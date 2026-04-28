// 統一呼叫 Netlify Functions:/.netlify/functions/products-api
// 從 sessionStorage 讀取 adminPwd,自動帶上 x-admin-password header
const API_BASE = "/.netlify/functions/products-api";

export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function getAdminPwd() {
  return sessionStorage.getItem("adminPwd") || "";
}

export function setAdminPwd(pwd) {
  sessionStorage.setItem("adminPwd", pwd);
}

export function clearAdminPwd() {
  sessionStorage.removeItem("adminPwd");
}

export async function apiCall(action, method = "GET", body) {
  const opts = {
    method,
    headers: {
      "x-admin-password": getAdminPwd(),
    },
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const url = `${API_BASE}?action=${encodeURIComponent(action)}`;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error(`網路錯誤:${e.message || e}`);
  }

  let data = null;
  let parseErr = null;
  try {
    data = await res.json();
  } catch (e) {
    parseErr = e;
  }

  if (res.status === 401) {
    clearAdminPwd();
    throw new UnauthorizedError((data && data.error) || "unauthorized");
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  // API 合約規定一定回 JSON,若拿到非 JSON(常見是 vite dev 沒跑 netlify functions)就視為錯誤
  if (parseErr || data === null) {
    throw new Error("伺服器回應格式錯誤(請改用 `netlify dev` 啟動,或部署到 Netlify)");
  }
  return data;
}

// 高階快捷函式
export const listProducts = () => apiCall("list", "GET");
export const createProduct = (row) => apiCall("create", "POST", row);
export const updateProduct = (row) => apiCall("update", "POST", row);
export const deleteProduct = (id) => apiCall("delete", "POST", { id });
export const bulkUpsert = (rows) => apiCall("bulk_upsert", "POST", { rows });
