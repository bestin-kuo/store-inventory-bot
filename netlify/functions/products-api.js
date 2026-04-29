// 後台 CRUD API。前端透過 fetch 呼叫,header 帶 x-admin-password。
// 使用 service_role key,避免 RLS 限制。
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// products 表允許寫入的欄位(進貨資料另存 incoming_shipments)
const ALLOWED_FIELDS = ["sku", "name", "brand", "color", "stock_qty", "barcode"];

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

  const ids = products.map((p) => p.id);
  // date desc 排序,nullsLast 確保有日期的排前面
  const { data: shipments, error: e2 } = await supabase
    .from("incoming_shipments")
    .select("*")
    .in("product_id", ids)
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

  // 若 body 有提供 incoming(包含空陣列),代表使用者編輯過進貨清單 → 整批替換
  if (body.incoming !== undefined) {
    const { error: eDel } = await supabase
      .from("incoming_shipments")
      .delete()
      .eq("product_id", body.id);
    if (eDel) throw eDel;

    const inserts = normalizeShipments(body.id, body.incoming);
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

async function bulkUpsert(body) {
  const rows = Array.isArray(body && body.rows) ? body.rows : [];
  let upserted = 0;
  let skipped = 0;
  const errors = [];
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
    try {
      const { data: upRow, error } = await supabase
        .from("products")
        .upsert(row, { onConflict: "sku" })
        .select()
        .single();
      if (error) {
        errors.push({ index: i, sku: row.sku, error: error.message });
        continue;
      }
      // CSV 若有提供 incoming_qty(>0)就附加一筆進貨紀錄;不會清掉舊資料
      // (.xls 路徑不會帶 incoming_qty,所以這段不會被執行)
      const incomingQty = raw.incoming_qty;
      if (
        incomingQty !== undefined &&
        incomingQty !== null &&
        incomingQty !== ""
      ) {
        const qtyNum = Number(incomingQty);
        if (Number.isFinite(qtyNum) && qtyNum > 0) {
          const { error: eS } = await supabase
            .from("incoming_shipments")
            .insert({
              product_id: upRow.id,
              qty: qtyNum,
              date: raw.incoming_date || null,
            });
          if (eS) {
            errors.push({
              index: i,
              sku: row.sku,
              error: `product OK, shipment fail: ${eS.message}`,
            });
            continue;
          }
        }
      }
      upserted++;
    } catch (e) {
      errors.push({ index: i, sku: row.sku, error: String(e.message || e) });
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

    if (method === "GET" && action === "list") return await listProducts();
    if (method === "POST" && action === "create")
      return await createProduct(body);
    if (method === "POST" && action === "update")
      return await updateProduct(body);
    if (method === "POST" && action === "delete")
      return await deleteProduct(body);
    if (method === "POST" && action === "bulk_upsert")
      return await bulkUpsert(body);

    return json(404, { error: "unknown action" });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};
