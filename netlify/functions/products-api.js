// 後台 CRUD API。前端透過 fetch 呼叫,header 帶 x-admin-password。
// 使用 service_role key,避免 RLS 限制。
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ALLOWED_FIELDS = [
  "sku",
  "name",
  "color",
  "stock_qty",
  "incoming_qty",
  "incoming_date",
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

async function listProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("sku", { ascending: true });
  if (error) throw error;
  return json(200, { rows: data || [] });
}

async function createProduct(body) {
  const row = pickFields(body || {});
  if (!row.sku) return json(400, { error: "sku is required" });
  row.updated_at = nowIso();
  const { data, error } = await supabase
    .from("products")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return json(200, { row: data });
}

async function updateProduct(body) {
  if (!body || !body.id) return json(400, { error: "id is required" });
  const patch = pickFields(body);
  patch.updated_at = nowIso();
  const { data, error } = await supabase
    .from("products")
    .update(patch)
    .eq("id", body.id)
    .select()
    .single();
  if (error) throw error;
  return json(200, { row: data });
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
  let success = 0;
  let failed = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    const row = pickFields(raw);
    if (!row.sku) {
      failed++;
      errors.push({ index: i, sku: raw.sku || null, error: "missing sku" });
      continue;
    }
    row.updated_at = nowIso();
    try {
      const { error } = await supabase
        .from("products")
        .upsert(row, { onConflict: "sku" });
      if (error) {
        failed++;
        errors.push({ index: i, sku: row.sku, error: error.message });
      } else {
        success++;
      }
    } catch (e) {
      failed++;
      errors.push({ index: i, sku: row.sku, error: String(e.message || e) });
    }
  }
  return json(200, { success, failed, errors });
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
