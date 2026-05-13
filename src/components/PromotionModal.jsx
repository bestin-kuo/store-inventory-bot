import { useEffect, useMemo, useState } from "react";
import { createPromotion, updatePromotion } from "../lib/api.js";

// products: 用來填商品下拉(從 App 傳進來,避免重複 fetch)
// mode: "create" | "edit"
// row: 編輯時的活動原始資料(含 id 與 product 物件)
export default function PromotionModal({
  mode,
  row,
  products,
  onClose,
  onSaved,
}) {
  // product_id 用 "" 代表「全店活動」
  const [productId, setProductId] = useState("");
  const [endDate, setEndDate] = useState("");
  const [info, setInfo] = useState("");
  const [search, setSearch] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "edit" && row) {
      setProductId(row.product_id || "");
      setEndDate(row.end_date || "");
      setInfo(row.info || "");
    } else {
      setProductId("");
      setEndDate("");
      setInfo("");
    }
    setErr("");
    setSearch("");
  }, [mode, row]);

  // 商品下拉:依搜尋過濾,sku 排序
  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = products || [];
    if (q) {
      list = list.filter((p) => {
        const sku = (p.sku || "").toLowerCase();
        const name = (p.name || "").toLowerCase();
        return sku.includes(q) || name.includes(q);
      });
    }
    return [...list]
      .sort((a, b) => String(a.sku || "").localeCompare(String(b.sku || "")))
      .slice(0, 200); // 太多選項下拉會很慢,只顯示前 200
  }, [products, search]);

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    if (!endDate) {
      setErr("請選結束日期");
      return;
    }
    if (!info.trim()) {
      setErr("請輸入活動資訊");
      return;
    }
    const payload = {
      product_id: productId || null,
      end_date: endDate,
      info: info.trim(),
    };
    setBusy(true);
    try {
      if (mode === "edit") {
        await updatePromotion({ id: row.id, ...payload });
      } else {
        await createPromotion(payload);
      }
      onSaved();
    } catch (e) {
      setErr(e.message || "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  // 當前選中的商品(編輯模式下要顯示在下拉外面,因為 visibleProducts 只顯示 200)
  const selectedProduct =
    productId && products
      ? products.find((p) => p.id === productId)
      : null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-900/60 p-4">
      <form
        onSubmit={handleSubmit}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-semibold">
          {mode === "edit" ? "編輯活動" : "新增活動"}
        </h2>

        <div className="mb-3">
          <label className="mb-1 block text-sm">商品</label>
          <input
            type="text"
            placeholder="搜尋 SKU / 名稱..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-2 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">⭐ 全店活動(不限商品)</option>
            {selectedProduct &&
              !visibleProducts.find((p) => p.id === selectedProduct.id) && (
                <option value={selectedProduct.id}>
                  {selectedProduct.sku} - {selectedProduct.name || "(無名)"}
                  (目前選中)
                </option>
              )}
            {visibleProducts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} - {p.name || "(無名)"}
              </option>
            ))}
          </select>
          {products && products.length > 200 && (
            <p className="mt-1 text-xs text-gray-500">
              共 {products.length} 個商品,下拉只顯示前 200。請用上方搜尋過濾。
            </p>
          )}
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-sm">
            結束日期 <span className="text-red-500">*</span>
          </label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            required
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            過了這天的隔天 09:00 會自動歸檔,LINE bot 就不會再帶出
          </p>
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm">
            活動資訊 <span className="text-red-500">*</span>
          </label>
          <textarea
            rows={3}
            value={info}
            onChange={(e) => setInfo(e.target.value)}
            placeholder="例:買就送收納袋 / 春季優惠 9 折"
            required
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        {err && <p className="mb-3 text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-400"
          >
            {busy ? "儲存中…" : "儲存"}
          </button>
        </div>
      </form>
    </div>
  );
}
