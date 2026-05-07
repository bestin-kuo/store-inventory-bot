// 後台 CRUD API。前端透過 fetch 呼叫,header 帶 x-admin-password。
// 使用 service_role key,避免 RLS 限制。
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// products 表允許寫入的欄位(進貨資料另存 incoming_shipments)
const ALLOWED_FIELDS = [
  "sku",
  "name",
  "brand",
  "color",
  "stock_qty",
  "barcode",
  "category",
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function pickFields(obj) {
  const out = {};
  for (const k of ALLOWED_FIELDS) {
    if (obj[k] !== undefined) out[k] = obj[k] === "" ? null : obj[k];
  }
  return out;
}

// 把使用者輸入的進貨紀錄整理為要寫入 DB 的格式
function normalizeShipments(productId, incoming) {
  if (!Array.isArray(incoming)) return [];
  const out = [];
  for (const s of incoming) {
    if (!s) continue;
    if (s.qty === null || s.qty === undefined || s.qty === "") continue;
    const qty = Number(s.qty);
    if (!Number.isFinite(qty)) continue;
    out.push({
      product_id: productId,
      qty,
      date: s.date || null,
    });
  }
  return out;
}

async function listProducts() {
  const { data: products, error } = await supabase
    .from("products")
    .select("*")
    .order("sku", { ascending: true });
  if (error) throw error;
  if (!products || !products.length) return json(200, { rows: [] });

  // 不用 .in(product_id, ids) 過濾 — 1500 筆 UUID 會讓 URL 爆掉(~55KB)被 proxy 擋下來
  // shipments 是手動建立的少量資料,直接全撈一次再 JS 端 join 比較安全
  const { data: shipments, error: e2 } = await supabase
    .from("incoming_shipments")
    .select("*")
    .order("date", { ascending: false, nullsFirst: false });
  if (e2) throw e2;

  const byProduct = {};
  for (const s of shipments || []) {
    if (!byProduct[s.product_id]) byProduct[s.product_id] = [];
    byProduct[s.product_id].push(s);
  }
  const rows = products.map((p) => ({
    ...p,
    incoming: byProduct[p.id] || [],
  }));
  return json(200, { rows });
}

async function createProduct(body) {
  const row = pickFields(body || {});
  if (!row.sku) return json(400, { error: "sku is required" });
  row.updated_at = nowIso();
  const { data: created, error } = await supabase
    .from("products")
    .insert(row)
    .select()
    .single();
  if (error) throw error;

  const inserts = normalizeShipments(created.id, body && body.incoming);
  if (inserts.length) {
    const { error: e2 } = await supabase
      .from("incoming_shipments")
      .insert(inserts);
    if (e2) throw e2;
  }
  return json(200, { row: created });
}

async function updateProduct(body) {
  if (!body || !body.id) return json(400, { error: "id is required" });
  const patch = pickFields(body);
  patch.updated_at = nowIso();
  const { data: updated, error } = await supabase
    .from("products")
    .update(patch)
    .eq("id", body.id)
    .select()
    .single();
  if (error) throw error;

  // 若 body 有提供 incoming → 只替換「未到貨」(processed_at IS NULL)的部分
  // 已到貨的歷史紀錄保留,使用者也不能透過 modal 改它
  if (body.incoming !== undefined) {
    const { error: eDel } = await supabase
      .from("incoming_shipments")
      .delete()
      .eq("product_id", body.id)
      .is("processed_at", null);
    if (eDel) throw eDel;

    // 過濾:前端傳回有 processed_at 的代表是歷史紀錄,後端不該重新插入
    const filteredIncoming = (body.incoming || []).filter(
      (s) => !s || !s.processed_at
    );
    const inserts = normalizeShipments(body.id, filteredIncoming);
    if (inserts.length) {
      const { error: eIns } = await supabase
        .from("incoming_shipments")
        .insert(inserts);
      if (eIns) throw eIns;
    }
  }
  return json(200, { row: updated });
}

async function deleteProduct(body) {
  if (!body || !body.id) return json(400, { error: "id is required" });
  const { error } = await supabase
    .from("products")
    .delete()
    .eq("id", body.id);
  if (error) throw error;
  return json(200, { ok: true });
}

// === 即將到貨匯入(批次版本)===
// 65 筆若逐筆做 2-3 個 Supabase 往返會撞 Netlify 10 秒上限,改成批次:
//   1. 一次 SELECT by barcodes(分塊)
//   2. JS 端決定哪些是現有匹配 / 自動建 / 歧義
//   3. 一次 SELECT by sku 確認新 SKU 沒撞到既有(避免 SKU unique 衝突)
//   4. 一次 BULK INSERT 新 products
//   5. 一次 BULK INSERT shipments
async function importIncoming(body) {
  const rows = Array.isArray(body && body.rows) ? body.rows : [];
  const errors = [];
  const CHUNK = 200;

  // ─── 1. Normalize + 基本驗證 ───
  const valid = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    const barcode =
      raw.barcode != null ? String(raw.barcode).trim() : "";
    const brand =
      typeof raw.brand === "string" ? raw.brand.trim() : raw.brand || "";
    const qtyNum = Number(raw.qty);
    const date = raw.date ? String(raw.date).trim() : null;
    const color =
      typeof raw.color === "string" ? raw.color.trim() : null;

    if (!barcode) {
      errors.push({ index: i, error: "缺 barcode" });
      continue;
    }
    if (!brand) {
      errors.push({ index: i, barcode, error: "缺品牌" });
      continue;
    }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      errors.push({ index: i, barcode, error: "qty 不合法" });
      continue;
    }
    valid.push({ index: i, barcode, brand, qtyNum, date, color });
  }

  if (valid.length === 0) {
    return json(200, {
      inserted: 0,
      autoCreated: 0,
      ambiguous: 0,
      errors,
    });
  }

  // ─── 2. 一次撈所有 barcode 對應的現有 products ───
  const uniqueBarcodes = [...new Set(valid.map((v) => v.barcode))];
  const productsByBarcode = {};
  for (let i = 0; i < uniqueBarcodes.length; i += CHUNK) {
    const chunk = uniqueBarcodes.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("products")
      .select("id, sku, brand, barcode")
      .in("barcode", chunk);
    if (error) throw error;
    for (const p of data || []) {
      const bc = p.barcode || "";
      if (!productsByBarcode[bc]) productsByBarcode[bc] = [];
      productsByBarcode[bc].push(p);
    }
  }

  // ─── 3. 分類:精確匹配 / 歧義 / 待自動建 ───
  let ambiguous = 0;
  const shipmentInserts = []; // {product_id, qty, date}
  const toAutoCreate = []; // {v, payload}

  for (const v of valid) {
    const candidates = productsByBarcode[v.barcode] || [];
    const brandLower = v.brand.toLowerCase();
    // 先做精確 brand 比對(同 ilike 但 JS 端避免再 round-trip)
    const exact = candidates.filter(
      (c) => (c.brand || "").toLowerCase() === brandLower
    );
    let matches = exact;
    if (matches.length === 0) {
      // 退化成 substring 比對(雙向包含)
      matches = candidates.filter((c) => {
        const bl = (c.brand || "").toLowerCase();
        return bl && (bl.includes(brandLower) || brandLower.includes(bl));
      });
    }

    if (matches.length === 1) {
      shipmentInserts.push({
        product_id: matches[0].id,
        qty: v.qtyNum,
        date: v.date,
      });
    } else if (matches.length >= 2) {
      ambiguous++;
      errors.push({
        index: v.index,
        barcode: v.barcode,
        brand: v.brand,
        error: `barcode+品牌對應到 ${matches.length} 個 SKU`,
        skus: matches.map((m) => m.sku),
      });
    } else {
      // 沒比對到 → 自動建
      toAutoCreate.push({
        v,
        payload: {
          sku: v.barcode,
          name: "",
          brand: v.brand,
          color: v.color || null,
          barcode: v.barcode,
          stock_qty: 0,
          category: "主商品",
          updated_at: nowIso(),
        },
      });
    }
  }

  // ─── 4. 待建 SKU 中,先確認哪些 sku 已經存在(以 sku 唯一鍵) ───
  const skuToExistingId = {};
  if (toAutoCreate.length > 0) {
    const skusToCheck = [...new Set(toAutoCreate.map((t) => t.payload.sku))];
    for (let i = 0; i < skusToCheck.length; i += CHUNK) {
      const chunk = skusToCheck.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("products")
        .select("id, sku")
        .in("sku", chunk);
      if (error) throw error;
      for (const p of data || []) skuToExistingId[p.sku] = p.id;
    }
  }

  // ─── 5. 真正新的 SKU 一次 bulk insert ───
  const skuToNewId = {};
  let autoCreated = 0;
  const trulyNew = toAutoCreate.filter(
    (t) => !skuToExistingId[t.payload.sku]
  );
  if (trulyNew.length > 0) {
    // 同一檔可能有重複的 sku(同 barcode 多筆),先去重
    const seen = new Set();
    const dedupedPayloads = [];
    for (const t of trulyNew) {
      if (!seen.has(t.payload.sku)) {
        seen.add(t.payload.sku);
        dedupedPayloads.push(t.payload);
      }
    }
    const SHIP_CHUNK = 500;
    for (let i = 0; i < dedupedPayloads.length; i += SHIP_CHUNK) {
      const chunk = dedupedPayloads.slice(i, i + SHIP_CHUNK);
      const { data: created, error } = await supabase
        .from("products")
        .insert(chunk)
        .select();
      if (error) throw error;
      for (const c of created || []) skuToNewId[c.sku] = c.id;
      autoCreated += created ? created.length : 0;
    }
  }

  // ─── 6. 把待建 SKU 對應的 shipment 補進 shipmentInserts ───
  for (const t of toAutoCreate) {
    const sku = t.payload.sku;
    const pid = skuToNewId[sku] || skuToExistingId[sku];
    if (!pid) {
      errors.push({
        index: t.v.index,
        barcode: t.v.barcode,
        error: "auto-create failed (no id)",
      });
      continue;
    }
    shipmentInserts.push({
      product_id: pid,
      qty: t.v.qtyNum,
      date: t.v.date,
    });
  }

  // ─── 7. 一次 bulk insert shipments(分塊安全) ───
  let inserted = 0;
  if (shipmentInserts.length > 0) {
    const SHIP_CHUNK = 500;
    for (let i = 0; i < shipmentInserts.length; i += SHIP_CHUNK) {
      const chunk = shipmentInserts.slice(i, i + SHIP_CHUNK);
      const { error } = await supabase
        .from("incoming_shipments")
        .insert(chunk);
      if (error) throw error;
      inserted += chunk.length;
    }
  }

  return json(200, { inserted, autoCreated, ambiguous, errors });
}

// 批次匯入。1500 筆逐筆呼叫會撞 Netlify 10 秒上限,所以改成分塊 bulk upsert。
async function bulkUpsert(body) {
  const rows = Array.isArray(body && body.rows) ? body.rows : [];
  let upserted = 0;
  let skipped = 0;
  const errors = [];

  // === 1. 前處理:過濾、計入 skipped、整理成可批次 upsert 的陣列 ===
  const valid = []; // [{ originalIndex, raw, row }]
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    // 規則:品牌空(空字串 / null / undefined)→ 視為非商品列,計入 skipped
    const brandVal =
      typeof raw.brand === "string" ? raw.brand.trim() : raw.brand;
    if (!brandVal) {
      skipped++;
      continue;
    }
    const row = pickFields(raw);
    if (!row.sku) {
      errors.push({ index: i, sku: null, error: "missing sku" });
      continue;
    }
    row.updated_at = nowIso();
    valid.push({ originalIndex: i, raw, row });
  }

  // === 2. 分塊 bulk upsert,每塊 500 筆 ===
  const CHUNK_SIZE = 500;
  // 收集要附加的進貨紀錄(CSV 路徑用;.xls 路徑不會帶 incoming_qty)
  const shipmentInserts = [];

  for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
    const chunk = valid.slice(i, i + CHUNK_SIZE);
    const payload = chunk.map((c) => c.row);
    try {
      const { data: upRows, error } = await supabase
        .from("products")
        .upsert(payload, { onConflict: "sku" })
        .select();
      if (error) {
        // 整塊失敗,記一筆代表性錯誤(避免 errors 爆量)
        errors.push({
          index: chunk[0].originalIndex,
          sku: chunk[0].row.sku,
          error: `chunk upsert failed (${chunk.length} rows): ${error.message}`,
        });
        continue;
      }
      upserted += upRows ? upRows.length : 0;

      // 對應 sku → product id,供 shipment 建立
      const skuToId = {};
      for (const r of upRows || []) skuToId[r.sku] = r.id;

      for (const c of chunk) {
        const incomingQty = c.raw.incoming_qty;
        if (
          incomingQty === undefined ||
          incomingQty === null ||
          incomingQty === ""
        )
          continue;
        const qtyNum = Number(incomingQty);
        if (!Number.isFinite(qtyNum) || qtyNum <= 0) continue;
        const pid = skuToId[c.row.sku];
        if (!pid) continue;
        shipmentInserts.push({
          product_id: pid,
          qty: qtyNum,
          date: c.raw.incoming_date || null,
        });
      }
    } catch (e) {
      errors.push({
        index: chunk[0].originalIndex,
        sku: chunk[0].row.sku,
        error: `chunk exception (${chunk.length} rows): ${String(
          (e && e.message) || e
        )}`,
      });
    }
  }

  // === 3. 進貨紀錄一次 bulk insert(.xls 不會走到這)===
  if (shipmentInserts.length > 0) {
    try {
      const { error: eS } = await supabase
        .from("incoming_shipments")
        .insert(shipmentInserts);
      if (eS) {
        errors.push({
          error: `shipments bulk insert failed (${shipmentInserts.length} rows): ${eS.message}`,
        });
      }
    } catch (e) {
      errors.push({
        error: `shipments insert exception: ${String((e && e.message) || e)}`,
      });
    }
  }

  return json(200, { upserted, skipped, errors });
}

exports.handler = async (event) => {
  try {
    const headers = event.headers || {};
    // Netlify 會把 header name 轉小寫
    const pwd = headers["x-admin-password"];
    if (!process.env.ADMIN_PASSWORD || pwd !== process.env.ADMIN_PASSWORD) {
      return json(401, { error: "unauthorized" });
    }

    const action =
      (event.queryStringParameters && event.queryStringParameters.action) || "";
    const method = event.httpMethod;

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return json(400, { error: "invalid JSON body" });
      }
    }

    // === 診斷端點(暫用,debug 完移除)===
    if (method === "GET" && action === "ping") {
      const url = process.env.SUPABASE_URL || "";
      const key = process.env.SUPABASE_SERVICE_KEY || "";
      // 偵測 URL 字串有沒有可疑的隱藏字元
      const hasWhitespace = /\s/.test(url);
      const hasNewline = /[\r\n]/.test(url);
      return json(200, {
        env: {
          SUPABASE_URL_length: url.length,
          SUPABASE_URL_start: url.slice(0, 30),
          SUPABASE_URL_end: url.slice(-10),
          SUPABASE_URL_has_whitespace: hasWhitespace,
          SUPABASE_URL_has_newline: hasNewline,
          SUPABASE_SERVICE_KEY_length: key.length,
          SUPABASE_SERVICE_KEY_start: key.slice(0, 10),
          ADMIN_PASSWORD_length: (process.env.ADMIN_PASSWORD || "").length,
        },
      });
    }
    if (method === "GET" && action === "test_supabase") {
      // 繞過 supabase-js,直接打 REST API,把完整 response 透出
      const url = (process.env.SUPABASE_URL || "").trim();
      const key = (process.env.SUPABASE_SERVICE_KEY || "").trim();
      try {
        const res = await fetch(
          `${url}/rest/v1/products?select=*&limit=1`,
          {
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
            },
          }
        );
        const text = await res.text();
        return json(200, {
          status: res.status,
          statusText: res.statusText,
          body: text.slice(0, 1000),
          urlUsed: url.slice(0, 40),
        });
      } catch (e) {
        return json(500, {
          error: String(e.message || e),
          name: e.name,
          urlUsed: url.slice(0, 40),
        });
      }
    }

    if (method === "GET" && action === "list") return await listProducts();
    if (method === "POST" && action === "create")
      return await createProduct(body);
    if (method === "POST" && action === "update")
      return await updateProduct(body);
    if (method === "POST" && action === "delete")
      return await deleteProduct(body);
    if (method === "POST" && action === "bulk_upsert")
      return await bulkUpsert(body);
    if (method === "POST" && action === "import_incoming")
      return await importIncoming(body);

    return json(404, { error: "unknown action" });
  } catch (e) {
    // 把 Supabase 的完整錯誤資訊透出來,方便排查(message + details + hint + code)
    console.error("products-api handler error:", e);
    return json(500, {
      error: String((e && e.message) || e),
      details: e && e.details ? String(e.details) : undefined,
      hint: e && e.hint ? String(e.hint) : undefined,
      code: e && e.code ? String(e.code) : undefined,
    });
  }
};
