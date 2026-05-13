// Netlify Scheduled Function:每天台北 09:00 執行
//   1. 把「到期」的進貨紀錄併入 products.stock_qty
//   2. 把「end_date 已過」的活動歸檔
//
// Cron:UTC 01:00 = 台北 09:00(UTC+8)

const { schedule } = require("@netlify/functions");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function processArrivals(today, nowIso) {
  // 1. 撈未處理的進貨
  const { data: pending, error: e1 } = await supabase
    .from("incoming_shipments")
    .select("id, product_id, qty, date")
    .lte("date", today)
    .is("processed_at", null);
  if (e1) throw e1;
  if (!pending || pending.length === 0) {
    return { processed: 0, productsUpdated: 0, errors: [] };
  }

  // 2. 累加每個 product 的 qty
  const incrementByProduct = {};
  const shipmentIds = [];
  for (const s of pending) {
    incrementByProduct[s.product_id] =
      (incrementByProduct[s.product_id] || 0) + Number(s.qty || 0);
    shipmentIds.push(s.id);
  }

  // 3. 對每個 product,read-then-write 更新 stock_qty
  const productIds = Object.keys(incrementByProduct);
  const errors = [];
  let updated = 0;
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
      .update({ stock_qty: newQty, updated_at: nowIso })
      .eq("id", pid);
    if (eW) {
      errors.push({ product_id: pid, error: eW.message });
      continue;
    }
    updated++;
  }

  // 4. 標記 shipment 已處理(分塊避免 .in() URL 過長)
  const CHUNK = 100;
  for (let i = 0; i < shipmentIds.length; i += CHUNK) {
    const chunk = shipmentIds.slice(i, i + CHUNK);
    const { error: eU } = await supabase
      .from("incoming_shipments")
      .update({ processed_at: nowIso })
      .in("id", chunk);
    if (eU) errors.push({ shipments_chunk: i, error: eU.message });
  }

  return {
    processed: shipmentIds.length,
    productsUpdated: updated,
    errors,
  };
}

async function archiveExpiredPromotions(today, nowIso) {
  const { data, error } = await supabase
    .from("promotions")
    .update({ archived_at: nowIso, updated_at: nowIso })
    .lt("end_date", today)
    .is("archived_at", null)
    .select("id");
  if (error) throw error;
  return { archived: data ? data.length : 0 };
}

const handler = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const result = { today };

  try {
    result.arrivals = await processArrivals(today, nowIso);
  } catch (e) {
    result.arrivalsError = String((e && e.message) || e);
    console.error("processArrivals failed:", e);
  }

  try {
    result.promotions = await archiveExpiredPromotions(today, nowIso);
  } catch (e) {
    result.promotionsError = String((e && e.message) || e);
    console.error("archiveExpiredPromotions failed:", e);
  }

  console.log("scheduled run OK:", JSON.stringify(result));
  return { statusCode: 200, body: JSON.stringify(result) };
};

// Cron:每天台北 09:00 = UTC 01:00
exports.handler = schedule("0 1 * * *", handler);
