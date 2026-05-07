// Netlify Scheduled Function:每天台北 09:00 執行
// 處理「日期已到」且「尚未處理」的進貨紀錄,把數量加進 products.stock_qty。
//
// Cron:UTC 01:00 = 台北 09:00(UTC+8)
// 觸發:cron only,不接受外部 HTTP 呼叫。

const { schedule } = require("@netlify/functions");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function processArrivals() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 1. 撈出 date <= today 且 processed_at is null 的所有 shipment
  const { data: pending, error: e1 } = await supabase
    .from("incoming_shipments")
    .select("id, product_id, qty, date")
    .lte("date", today)
    .is("processed_at", null);
  if (e1) throw e1;
  if (!pending || pending.length === 0) {
    return { processed: 0, message: "no pending arrivals" };
  }

  // 2. 累加每個 product 的 qty(同一 product 可能多筆)
  const incrementByProduct = {};
  const shipmentIds = [];
  for (const s of pending) {
    incrementByProduct[s.product_id] =
      (incrementByProduct[s.product_id] || 0) + Number(s.qty || 0);
    shipmentIds.push(s.id);
  }

  // 3. 對每個 product,撈舊 stock,加上 increment,寫回
  //    Supabase JS 沒有原生的「stock_qty = stock_qty + N」原子操作,
  //    只能 read-then-write。並發風險低(每天一次 cron + 後台手動寫入間隔通常很長)。
  const productIds = Object.keys(incrementByProduct);
  let updated = 0;
  const errors = [];
  for (const pid of productIds) {
    const inc = incrementByProduct[pid];
    const { data: prod, error: eR } = await supabase
      .from("products")
      .select("stock_qty")
      .eq("id", pid)
      .single();
    if (eR) {
      errors.push({ product_id: pid, error: eR.message });
      continue;
    }
    const newQty = (prod.stock_qty || 0) + inc;
    const { error: eW } = await supabase
      .from("products")
      .update({ stock_qty: newQty, updated_at: new Date().toISOString() })
      .eq("id", pid);
    if (eW) {
      errors.push({ product_id: pid, error: eW.message });
      continue;
    }
    updated++;
  }

  // 4. 把處理過的 shipment 標記為 processed_at = now()
  //    分塊更新,避免 .in() URL 太長
  const CHUNK = 100;
  const now = new Date().toISOString();
  for (let i = 0; i < shipmentIds.length; i += CHUNK) {
    const chunk = shipmentIds.slice(i, i + CHUNK);
    const { error: eU } = await supabase
      .from("incoming_shipments")
      .update({ processed_at: now })
      .in("id", chunk);
    if (eU) errors.push({ shipments_chunk: i, error: eU.message });
  }

  return {
    processed: shipmentIds.length,
    productsUpdated: updated,
    errors,
  };
}

const handler = async () => {
  try {
    const result = await processArrivals();
    console.log("process-arrivals OK:", JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error("process-arrivals FAILED:", e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String((e && e.message) || e) }),
    };
  }
};

// Cron:每天台北 09:00 = UTC 01:00
exports.handler = schedule("0 1 * * *", handler);
