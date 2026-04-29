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

// 找最新一筆進貨日期(沒填日期的略過)
function latestIncomingDate(r) {
  if (!r.incoming || !r.incoming.length) return null;
  for (const s of r.incoming) {
    if (s && s.date) return s.date;
  }
  return null;
}

// === 訊息格式化 ===
function formatSingle(r) {
  const lines = [`📦 ${r.sku}`];
  if (r.brand) lines.push(`品牌:${r.brand}`);
  if (r.name) lines.push(`名稱:${r.name}`);
  if (r.color) lines.push(`顏色:${r.color}`);
  lines.push(`庫存:${stockLabel(r.stock_qty)}`);
  if (r.barcode) lines.push(`條形碼:${r.barcode}`);
  // 沒貨時補上最近進貨日期(讓客人知道何時補貨)
  if ((r.stock_qty ?? 0) < 10) {
    const date = latestIncomingDate(r);
    if (date) lines.push(`最近進貨:${date}`);
  }
  return lines.join("\n");
}

function formatList(rows, query) {
  const head = `找到 ${rows.length} 件「${query}」相關商品:`;
  const lines = rows.map((r) => {
    const tags = [];
    if (r.brand) tags.push(r.brand);
    if (r.name) tags.push(r.name);
    if (r.color) tags.push(r.color);
    const detail = tags.length ? ` ${tags.join(" / ")}` : "";
    const label = stockLabel(r.stock_qty);
    let extra = "";
    if (label === "沒貨") {
      const date = latestIncomingDate(r);
      if (date) extra = `,進貨 ${date}`;
    }
    return `• ${r.sku}${detail}(${label}${extra})`;
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

function buildReplyText(query, rows) {
  if (!rows.length) {
    return `找不到「${query}」相關商品。\n可以試試:\n• 完整 SKU\n• 條形碼\n• 商品名稱關鍵字\n• 品牌名稱`;
  }
  if (rows.length === 1) return formatSingle(rows[0]);
  return formatList(rows, query);
}

// === Reply API ===
async function replyMessage(replyToken, text) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN not set");
    return;
  }
  // LINE text message 上限 5000 字,我們的回覆遠遠不到
  const body = JSON.stringify({
    replyToken,
    messages: [{ type: "text", text }],
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

  // 並行處理所有事件,但只對 text message 做事
  await Promise.all(
    events.map(async (ev) => {
      try {
        if (
          ev.type !== "message" ||
          !ev.message ||
          ev.message.type !== "text"
        )
          return;
        const text = (ev.message.text || "").trim();
        if (!text) return;
        const q = normalizeQuery(text);
        const rows = await searchProduct(q);
        // 回覆中顯示原始輸入,讓使用者看得懂
        const reply = buildReplyText(q || text, rows);
        await replyMessage(ev.replyToken, reply);
      } catch (e) {
        console.error("event handling error", e);
        // 不回 LINE,避免雙重回覆造成 reply token 錯誤
      }
    })
  );

  return { statusCode: 200, body: "ok" };
};
