// LINE bot webhook:依使用者輸入(SKU / 條形碼 / 關鍵字)查 Supabase products 表並回覆。
// 僅處理 text message,其他事件略過。
//
// 環境變數(Netlify env vars):
//   LINE_CHANNEL_SECRET        — 簽章驗證
//   LINE_CHANNEL_ACCESS_TOKEN  — Reply API 認證
//   SUPABASE_URL / SUPABASE_SERVICE_KEY  — 已存在

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const MAX_LIST = 200; // 模糊比對最多撈幾筆,實際顯示再依字數截斷
const REPLY_HARD_CAP = 4500; // LINE text message 上限 5000 字,留 buffer

// 常見「廢字」:用空白把它們切掉,只留商品關鍵字
// 例如:「Cova 庫存」→「Cova」、「047406145850 庫存」→「047406145850」
const NOISE_TOKENS = new Set([
  "庫存",
  "庫存量",
  "存貨",
  "多少",
  "幾個",
  "幾件",
  "個",
  "件",
  "還有",
  "還剩",
  "剩",
  "剩多少",
  "嗎",
  "呢",
  "?",
  "?",
  "有沒有",
  "查",
  "查詢",
  "查一下",
  "查一查",
  "看一下",
]);

// === 簽章驗證 ===
function verifySignature(rawBody, signature) {
  if (!signature || !process.env.LINE_CHANNEL_SECRET) return false;
  const hmac = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  // 用 timingSafeEqual 防 timing attack
  const a = Buffer.from(hmac);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 字元級剝離:緊貼商品關鍵字的廢字也要砍(例如「Cova嗎」→「Cova」)
const SUFFIX_NOISE_RE =
  /(庫存量?|存貨|多少|幾[個件]?|有沒有|嗎|呢|還剩|剩多少?|剩|還有)+$/u;
const PREFIX_NOISE_RE = /^(查詢?|查一[下查]|看一下|還有)+/u;

// 把使用者輸入正規化:
//   1. 全形/半形問號當分隔符
//   2. 字元級剝離前後綴廢字(不需空白)
//   3. token 級剝離(用空白切後再過濾)
//   4. 全被剝光 → 退回原字串
function normalizeQuery(raw) {
  const original = (raw || "").trim();
  if (!original) return "";

  // 全形/半形問號當分隔符 + 廢字
  let q = original.replace(/[??]+/g, " ").trim();

  // 字元級剝離前後綴廢字,迴圈直到不變(處理「Cova嗎?」這種多層)
  let prev;
  do {
    prev = q;
    q = q.replace(SUFFIX_NOISE_RE, "").trim();
    q = q.replace(PREFIX_NOISE_RE, "").trim();
  } while (q !== prev && q.length > 0);

  // token 級:過濾整段就是廢字的 token(處理「Cova 庫存」)
  if (/\s/.test(q)) {
    const tokens = q.split(/\s+/).filter((t) => t && !NOISE_TOKENS.has(t));
    q = tokens.join(" ").trim();
  }

  return q || original;
}

// 把 token 過一道殺特殊字元,避免破壞 PostgREST or-string 語法
function sanitizeToken(t) {
  return (t || "").replace(/[,()*\\]/g, "").trim();
}

// === 查詢策略 ===
//   單 token  :sku 完全 → barcode 完全 → 跨欄位模糊(sku/name/brand/color)
//   多 token  :每個 token 都要在某欄位(sku/name/brand/color)出現(AND of ORs)
// 顏色常出現在 SKU 字串裡,所以 sku 也納入模糊比對。
async function searchProduct(query) {
  const q = (query || "").trim();
  if (!q) return [];

  const tokens = q.split(/\s+/).filter(Boolean);

  // ─── 多 token 路徑 ───
  if (tokens.length >= 2) {
    let qb = supabase.from("products").select("*");
    for (const raw of tokens) {
      const t = sanitizeToken(raw);
      if (!t) continue;
      // 每個 token 都疊一個 .or()(supabase-js 多次 .or() 會用 AND 串起來)
      qb = qb.or(
        `sku.ilike.%${t}%,name.ilike.%${t}%,brand.ilike.%${t}%,color.ilike.%${t}%`
      );
    }
    const { data } = await qb.order("sku").limit(MAX_LIST);
    return await attachIncoming(data || []);
  }

  // ─── 單 token 路徑 ───
  // 1. sku 完全比對
  let { data } = await supabase
    .from("products")
    .select("*")
    .ilike("sku", q)
    .limit(1);
  if (data && data.length) return await attachIncoming(data);

  // 2. barcode 完全比對
  ({ data } = await supabase
    .from("products")
    .select("*")
    .eq("barcode", q)
    .limit(1));
  if (data && data.length) return await attachIncoming(data);

  // 3. 跨欄位模糊:sku / name / brand / color
  const safe = sanitizeToken(q);
  if (safe) {
    ({ data } = await supabase
      .from("products")
      .select("*")
      .or(
        `sku.ilike.%${safe}%,name.ilike.%${safe}%,brand.ilike.%${safe}%,color.ilike.%${safe}%`
      )
      .order("sku")
      .limit(MAX_LIST));
    if (data && data.length) return await attachIncoming(data);
  }

  return [];
}

// 把 incoming_shipments 附到所有結果上(沒貨時要顯示最近進貨日期)
// 注意:.in(product_id, ids) 把 UUID 塞進 query string,id 多時 URL 會爆 → 分塊查詢
async function attachIncoming(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const CHUNK = 50; // 50 個 UUID ≈ 1.8KB,絕對安全
  const all = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data } = await supabase
      .from("incoming_shipments")
      .select("*")
      .in("product_id", slice)
      .order("date", { ascending: false, nullsFirst: false });
    if (data) all.push(...data);
  }
  const byId = {};
  for (const s of all) {
    if (!byId[s.product_id]) byId[s.product_id] = [];
    byId[s.product_id].push(s);
  }
  return rows.map((r) => ({ ...r, incoming: byId[r.id] || [] }));
}

// 不公開實際庫存數,只給「有貨 / 沒貨」標籤
//   >= 10 → 有貨
//   <  10 → 沒貨
function stockLabel(qty) {
  return (qty ?? 0) >= 10 ? "有貨" : "沒貨";
}

// 找最近一筆「未到貨」的進貨日期(已被併入庫存的就不再顯示)
// incoming 陣列已依 date desc 排序
function latestIncomingDate(r) {
  if (!r.incoming || !r.incoming.length) return null;
  // 取最早的「未到貨」(對客人有意義 = 最快會補上)
  const unprocessed = r.incoming.filter(
    (s) => s && s.date && !s.processed_at
  );
  if (!unprocessed.length) return null;
  // 找日期最早的
  const earliest = unprocessed.reduce((a, b) =>
    a.date < b.date ? a : b
  );
  return earliest.date;
}

// === 訊息格式化 ===
// 不顯示 SKU,改用「[主商品] / [配件]」標籤 + 商品名 當頭題
function formatSingle(r) {
  const cat = r.category || "主商品";
  const headline = r.name ? `📦 [${cat}] ${r.name}` : `📦 [${cat}]`;
  const lines = [headline];
  if (r.brand) lines.push(`品牌:${r.brand}`);
  if (r.color) lines.push(`顏色:${r.color}`);
  lines.push(`庫存:${stockLabel(r.stock_qty)}`);
  if (r.barcode) lines.push(`條形碼:${r.barcode}`);
  // 沒貨時補上下批到貨日期(讓客人知道何時補貨)
  if ((r.stock_qty ?? 0) < 10) {
    const date = latestIncomingDate(r);
    if (date) lines.push(`下批到貨時間:${date}`);
  }
  return lines.join("\n");
}

function formatList(rows, query) {
  const head = `找到 ${rows.length} 件「${query}」相關商品:`;
  const lines = rows.map((r) => {
    const cat = r.category || "主商品";
    const tags = [];
    if (r.brand) tags.push(r.brand);
    if (r.name) tags.push(r.name);
    if (r.color) tags.push(r.color);
    const detail = tags.length ? ` ${tags.join(" / ")}` : "";
    const label = stockLabel(r.stock_qty);
    let extra = "";
    if (label === "沒貨") {
      const date = latestIncomingDate(r);
      if (date) extra = `,下批到貨時間 ${date}`;
    }
    return `• [${cat}]${detail}(${label}${extra})`;
  });

  // 字數保護:超過 LINE 上限就截斷
  let body = lines.join("\n");
  let truncatedNote = "";
  if (head.length + 1 + body.length > REPLY_HARD_CAP) {
    let acc = "";
    let shown = 0;
    for (const line of lines) {
      // 預留 200 字給尾端說明
      if (
        head.length + 1 + acc.length + line.length + 1 >
        REPLY_HARD_CAP - 200
      )
        break;
      acc += (acc ? "\n" : "") + line;
      shown++;
    }
    body = acc;
    truncatedNote = `\n\n…還有 ${rows.length - shown} 筆未顯示,請輸入更具體的關鍵字(例如完整 SKU 或加上顏色)`;
  }
  return `${head}\n${body}${truncatedNote}`;
}

// 回傳 { text, quickReplyItems? }
// parentQuery: 從 postback 傳進來的原始母查詢字串(text 訊息呼叫時為 undefined)
async function buildReplyText(query, rows, parentQuery) {
  if (!rows.length) {
    return {
      text: `找不到「${query}」相關商品。\n可以試試:\n• 完整 SKU\n• 條形碼\n• 商品名稱關鍵字\n• 品牌名稱`,
    };
  }
  const productIds = rows.map((r) => r.id);
  const perProduct = await fetchActivePromotionsByProduct(productIds);

  if (rows.length === 1) {
    let body = formatSingle(rows[0]);
    const promos = perProduct[rows[0].id] || [];
    if (promos.length) {
      body += "\n\n" + promos.map(formatPromoLine).join("\n");
    }
    // Quick Reply:↩ 回母查詢 + 相關商品
    const items = [];
    // 回上一頁按鈕(若有母查詢且不等於現在的 query)
    if (parentQuery && parentQuery !== query) {
      const backLabel = `↩ ${parentQuery}`;
      items.push({
        type: "action",
        action: {
          type: "postback",
          label:
            backLabel.length > 20 ? backLabel.slice(0, 20) : backLabel,
          data: encodePostbackData(parentQuery, ""),
          displayText: parentQuery,
        },
      });
    }
    // 相關商品(同品牌同首字),最多填到 13 個
    const remaining = 13 - items.length;
    if (remaining > 0) {
      const related = await fetchRelatedProducts(rows[0]);
      const relatedItems = buildQuickReplyItems(
        related,
        parentQuery || query
      ).slice(0, remaining);
      items.push(...relatedItems);
    }
    return { text: body, quickReplyItems: items };
  }

  // 多筆模式:列表 + 提示 + Quick Reply buttons
  let body = formatList(rows, query);
  const totalPromos = Object.values(perProduct).reduce(
    (a, arr) => a + arr.length,
    0
  );
  if (totalPromos > 0) {
    body += `\n\n📣 上述商品中有 ${totalPromos} 個活動進行中,點下方按鈕看詳細`;
  } else {
    body += `\n\n👇 點下方按鈕看單一商品詳細`;
  }
  // 母查詢:如果這次本身就是 user 直接打的字,query 就是母;
  // 如果是從 postback 進來,延用 parentQuery(否則用 query)
  const newParent = parentQuery || query;
  return {
    text: body,
    quickReplyItems: buildQuickReplyItems(rows, newParent),
  };
}

// 透過 junction 查每個 product 的進行中活動
// 進行中定義:archived_at IS NULL 且 (start_date IS NULL OR start_date <= today)
async function fetchActivePromotionsByProduct(productIds) {
  if (!productIds || !productIds.length) return {};
  const today = new Date().toISOString().slice(0, 10);
  const perProduct = {};
  const CHUNK = 50;
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const slice = productIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("promotion_products")
      .select(
        "product_id, promotion:promotions!inner(id, info, start_date, end_date, archived_at)"
      )
      .in("product_id", slice);
    if (error) {
      console.error("fetchActivePromotionsByProduct failed:", error);
      continue;
    }
    for (const pp of data || []) {
      const promo = pp.promotion;
      if (!promo || promo.archived_at) continue;
      // 過濾未開始的活動
      if (promo.start_date && promo.start_date > today) continue;
      if (!perProduct[pp.product_id]) perProduct[pp.product_id] = [];
      perProduct[pp.product_id].push(promo);
    }
  }
  // 同 product 的活動依 end_date asc 排序
  for (const k of Object.keys(perProduct)) {
    perProduct[k].sort((a, b) =>
      (a.end_date || "9999").localeCompare(b.end_date || "9999")
    );
  }
  return perProduct;
}

function formatPromoLine(p) {
  const date = p.end_date ? `(至 ${p.end_date})` : "";
  return `📣 ${p.info}${date}`;
}

// 「活動」指令:列出所有進行中活動及其商品
// 進行中定義:archived_at IS NULL 且 (start_date IS NULL OR start_date <= today)
async function buildActivityList() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("promotions")
    .select(
      "id, info, start_date, end_date, archived_at, promotion_products(product:products(sku, name, brand))"
    )
    .is("archived_at", null)
    .or(`start_date.is.null,start_date.lte.${today}`)
    .order("end_date", { ascending: true });
  if (error) throw error;
  const promos = (data || []).map((p) => ({
    ...p,
    products: (p.promotion_products || [])
      .map((pp) => pp.product)
      .filter(Boolean),
  }));
  if (!promos.length) return "目前沒有進行中的活動。";

  const head = `📣 目前進行中的活動(${promos.length} 個):`;
  const lines = promos.map((p) => {
    const productList =
      p.products.length === 0
        ? "(未綁商品)"
        : p.products.length <= 3
        ? p.products.map((pr) => pr.name || pr.sku).join("、")
        : `${p.products
            .slice(0, 3)
            .map((pr) => pr.name || pr.sku)
            .join("、")} 等 ${p.products.length} 項`;
    const date = p.end_date ? `(至 ${p.end_date})` : "";
    return `• ${productList}:${p.info}${date}`;
  });
  // 字數保護
  let body = lines.join("\n");
  if (head.length + body.length > REPLY_HARD_CAP) {
    let acc = "";
    let shown = 0;
    for (const line of lines) {
      if (
        head.length + acc.length + line.length + 1 >
        REPLY_HARD_CAP - 200
      )
        break;
      acc += (acc ? "\n" : "") + line;
      shown++;
    }
    body = acc + `\n\n…還有 ${promos.length - shown} 個活動未顯示`;
  }
  return `${head}\n${body}`;
}

// === Reply API ===
// quickReplyItems: 可選的 [{type:"action", action:{type:"message", label, text}}]
async function replyMessage(replyToken, text, quickReplyItems) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN not set");
    return;
  }
  const message = { type: "text", text };
  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = { items: quickReplyItems.slice(0, 13) }; // LINE 上限 13
  }
  const body = JSON.stringify({
    replyToken,
    messages: [message],
  });
  const res = await fetch(LINE_REPLY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("LINE reply failed", res.status, errText);
  }
}

// === Postback data 編碼/解碼 ===
// 格式:URL-encoded query string,例如 q=Mica 360 Pro&p=mica pro
//   q = 這個按鈕要查的目標(SKU 或名稱)
//   p = 原始母查詢字串(用來在後續訊息提供「↩ 回搜尋結果」按鈕)
function encodePostbackData(q, parent) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (parent) params.set("p", parent);
  return params.toString();
}

function parsePostbackData(data) {
  if (!data) return { q: "", p: "" };
  try {
    const params = new URLSearchParams(data);
    return { q: params.get("q") || "", p: params.get("p") || "" };
  } catch (e) {
    return { q: "", p: "" };
  }
}

// 把列表中的商品轉成 Quick Reply buttons
//   - 若所有商品共用同一個 name(只有顏色不同)→ 按鈕顯示顏色,送 SKU 觸發單筆查詢
//   - 否則 → 按鈕顯示 name(去重),送 name 觸發列表查詢(展開該款各顏色)
//   - 按鈕用 postback action,data 帶上原始母查詢,讓後續訊息能加「↩ 回搜尋結果」
//   - label 最長 20 字(LINE 限制)、最多 13 個 button
// parentQuery: 這次按鈕產生時的母查詢字串(會傳到下一層 postback 的 p 欄)
function buildQuickReplyItems(rows, parentQuery) {
  if (!rows || !rows.length) return [];
  const sample = rows[0];
  const allSameName =
    rows.length > 1 &&
    !!sample.name &&
    rows.every((r) => r.name === sample.name);

  const seen = new Set();
  const items = [];
  for (const r of rows) {
    let label;
    let target;
    if (allSameName) {
      label = r.color || r.sku;
      target = r.sku;
    } else {
      label = r.name || r.sku;
      target = r.name || r.sku;
    }
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const truncated = label.length > 20 ? label.slice(0, 20) : label;
    items.push({
      type: "action",
      action: {
        type: "postback",
        label: truncated,
        data: encodePostbackData(target, parentQuery || ""),
        displayText: target, // 按下後在聊天裡顯示這串,讓對話歷史好讀
      },
    });
    if (items.length >= 13) break;
  }
  return items;
}

// 取同品牌且名稱首字相同的相關商品(排除自己),用於單筆結果的「相關商品」Quick Reply
async function fetchRelatedProducts(row) {
  if (!row || !row.brand) return [];
  const firstWord = (row.name || "").trim().split(/\s+/)[0];
  let qb = supabase
    .from("products")
    .select("id, sku, name, brand, color")
    .eq("brand", row.brand)
    .neq("id", row.id)
    .order("name")
    .limit(20);
  if (firstWord) qb = qb.ilike("name", `${firstWord}%`);
  const { data, error } = await qb;
  if (error) {
    console.error("fetchRelatedProducts failed:", error);
    return [];
  }
  return data || [];
}

// === 主 handler ===
exports.handler = async (event) => {
  // LINE 會送 POST,其他都直接 200(避免 console verify 時誤報)
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ok" }),
    };
  }

  const rawBody = event.body || "";
  const signature =
    (event.headers &&
      (event.headers["x-line-signature"] ||
        event.headers["X-Line-Signature"])) ||
    "";

  if (!verifySignature(rawBody, signature)) {
    return { statusCode: 401, body: "invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: "invalid JSON" };
  }

  const events = Array.isArray(payload.events) ? payload.events : [];

  // LINE 在 console 按 Verify 時會送空 events 陣列;直接回 200 算過關
  if (events.length === 0) {
    return { statusCode: 200, body: "ok" };
  }

  // 並行處理所有事件,支援 text message 和 postback
  await Promise.all(
    events.map(async (ev) => {
      try {
        // === 文字訊息 ===
        if (
          ev.type === "message" &&
          ev.message &&
          ev.message.type === "text"
        ) {
          const text = (ev.message.text || "").trim();
          if (!text) return;
          const q = normalizeQuery(text);

          // 「活動」指令:直接列所有進行中活動
          if (q === "活動" || text === "活動") {
            const reply = await buildActivityList();
            await replyMessage(ev.replyToken, reply);
            return;
          }

          const rows = await searchProduct(q);
          const reply = await buildReplyText(q || text, rows);
          await replyMessage(
            ev.replyToken,
            reply.text,
            reply.quickReplyItems
          );
          return;
        }

        // === Postback 事件(Quick Reply 按鈕)===
        if (ev.type === "postback") {
          const { q, p } = parsePostbackData(
            ev.postback && ev.postback.data
          );
          if (!q) return;
          const rows = await searchProduct(q);
          // 把母查詢傳下去,讓單筆訊息可以加「↩ 回搜尋結果」按鈕
          const reply = await buildReplyText(q, rows, p);
          await replyMessage(
            ev.replyToken,
            reply.text,
            reply.quickReplyItems
          );
          return;
        }
      } catch (e) {
        console.error("event handling error", e);
      }
    })
  );

  return { statusCode: 200, body: "ok" };
};
