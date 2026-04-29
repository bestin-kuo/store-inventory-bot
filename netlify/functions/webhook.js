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
const MAX_LIST = 5; // 模糊比對最多回幾筆

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

// === 查詢:依序試 sku → barcode → name 模糊 → brand 模糊 ===
async function searchProduct(query) {
  const q = (query || "").trim();
  if (!q) return [];

  // 1. 完全比對 sku(case-insensitive)
  let { data } = await supabase
    .from("products")
    .select("*")
    .ilike("sku", q)
    .limit(1);
  if (data && data.length) return await attachIncoming(data);

  // 2. 完全比對 barcode
  ({ data } = await supabase
    .from("products")
    .select("*")
    .eq("barcode", q)
    .limit(1));
  if (data && data.length) return await attachIncoming(data);

  // 3. name 模糊
  ({ data } = await supabase
    .from("products")
    .select("*")
    .ilike("name", `%${q}%`)
    .order("sku")
    .limit(MAX_LIST));
  if (data && data.length) return await attachIncoming(data);

  // 4. brand 模糊
  ({ data } = await supabase
    .from("products")
    .select("*")
    .ilike("brand", `%${q}%`)
    .order("sku")
    .limit(MAX_LIST));
  if (data && data.length) return await attachIncoming(data);

  return [];
}

// 把 incoming_shipments 附到 products 結果上(僅查單筆時呼叫,避免多筆時噴 query)
async function attachIncoming(rows) {
  if (!rows.length) return rows;
  if (rows.length > 1) return rows; // 多筆模糊比對不抓進貨,顯示精簡列表
  const ids = rows.map((r) => r.id);
  const { data } = await supabase
    .from("incoming_shipments")
    .select("*")
    .in("product_id", ids)
    .order("date", { ascending: false, nullsFirst: false });
  const byId = {};
  for (const s of data || []) {
    if (!byId[s.product_id]) byId[s.product_id] = [];
    byId[s.product_id].push(s);
  }
  return rows.map((r) => ({ ...r, incoming: byId[r.id] || [] }));
}

// === 訊息格式化 ===
function formatSingle(r) {
  const lines = [`📦 ${r.sku}`];
  if (r.brand) lines.push(`品牌:${r.brand}`);
  if (r.name) lines.push(`名稱:${r.name}`);
  if (r.color) lines.push(`顏色:${r.color}`);
  lines.push(`庫存:${r.stock_qty ?? 0}`);
  if (r.barcode) lines.push(`條形碼:${r.barcode}`);
  const latest = r.incoming && r.incoming[0];
  if (latest) {
    const dateStr = latest.date || "(未填日期)";
    lines.push(`最近進貨:${dateStr}(${latest.qty} 件)`);
    if (r.incoming.length > 1) {
      lines.push(`(共 ${r.incoming.length} 筆進貨紀錄)`);
    }
  }
  return lines.join("\n");
}

function formatList(rows) {
  const head = `找到 ${rows.length} 筆,請輸入完整 SKU 查詳細:`;
  const list = rows
    .map(
      (r, i) =>
        `${i + 1}. ${r.sku}${r.brand ? ` / ${r.brand}` : ""}${
          r.name ? ` / ${r.name}` : ""
        }(庫存 ${r.stock_qty ?? 0})`
    )
    .join("\n");
  return `${head}\n${list}`;
}

function buildReplyText(query, rows) {
  if (!rows.length) {
    return `找不到「${query}」相關商品。\n可以試試:\n• 完整 SKU\n• 條形碼\n• 商品名稱關鍵字\n• 品牌名稱`;
  }
  if (rows.length === 1) return formatSingle(rows[0]);
  return formatList(rows);
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
        const rows = await searchProduct(text);
        const reply = buildReplyText(text, rows);
        await replyMessage(ev.replyToken, reply);
      } catch (e) {
        console.error("event handling error", e);
        // 不回 LINE,避免雙重回覆造成 reply token 錯誤
      }
    })
  );

  return { statusCode: 200, body: "ok" };
};
