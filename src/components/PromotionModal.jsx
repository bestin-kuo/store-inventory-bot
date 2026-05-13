import { useEffect, useMemo, useState } from "react";
import { createPromotion, updatePromotion } from "../lib/api.js";

// products: 從 App 傳進來,給商品多選用
// mode: "create" | "edit"
// row: 編輯時的活動資料(含 id 與 products 陣列)
export default function PromotionModal({
  mode,
  row,
  products,
  onClose,
  onSaved,
}) {
  // 已選的 product ids
  const [selectedIds, setSelectedIds] = useState([]);
  const [endDate, setEndDate] = useState("");
  const [info, setInfo] = useState("");
  const [search, setSearch] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "edit" && row) {
      setSelectedIds(
        Array.isArray(row.products) ? row.products.map((p) => p.id) : []
      );
      setEndDate(row.end_date || "");
      setInfo(row.info || "");
    } else {
      setSelectedIds([]);
      setEndDate("");
      setInfo("");
    }
    setErr("");
    setSearch("");
  }, [mode, row]);

  // products map for quick lookup
  const productsById = useMemo(() => {
    const m = {};
    for (const p of products || []) m[p.id] = p;
    return m;
  }, [products]);

  const selectedProducts = useMemo(
    () => selectedIds.map((id) => productsById[id]).filter(Boolean),
    [selectedIds, productsById]
  );

  // 候選清單:依搜尋過濾、排除已選、依 sku 排序、限 100 筆
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    const set = new Set(selectedIds);
    let list = (products || []).filter((p) => !set.has(p.id));
    if (q) {
      list = list.filter((p) => {
        const sku = (p.sku || "").toLowerCase();
        const name = (p.name || "").toLowerCase();
        const brand = (p.brand || "").toLowerCase();
        return (
          sku.includes(q) || name.includes(q) || brand.includes(q)
        );
      });
    } else {
      // 沒搜尋時不顯示全部(太多會卡),提示使用者輸入關鍵字
      return [];
    }
    return [...list]
      .sort((a, b) =>
        String(a.sku || "").localeCompare(String(b.sku || ""))
      )
      .slice(0, 100);
  }, [products, search, selectedIds]);

  function addProduct(id) {
    setSelectedIds((s) => (s.includes(id) ? s : [...s, id]));
  }
  function removeProduct(id) {
    setSelectedIds((s) => s.filter((x) => x !== id));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    if (selectedIds.length === 0) {
      setErr("請至少選一個商品");
      return;
    }
    if (!endDate) {
      setErr("請選結束日期");
      return;
    }
    if (!info.trim()) {
      setErr("請輸入活動資訊");
      return;
    }
    const payload = {
      product_ids: selectedIds,
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

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-900/60 p-4">
      <form
        onSubmit={handleSubmit}
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-semibold">
          {mode === "edit" ? "編輯活動" : "新增活動"}
        </h2>

        {/* 商品多選 */}
        <div className="mb-3">
          <label className="mb-1 block text-sm">
            商品 <span className="text-red-500">*</span>
            <span className="ml-2 text-xs text-gray-500">
              已選 {selectedIds.length} 個
            </span>
          </label>

          {/* 已選 chips */}
          {selectedProducts.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1 rounded border border-gray-200 bg-gray-50 p-2">
              {selectedProducts.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1 rounded bg-blue-100 px-2 py-1 text-xs text-blue-800"
                >
                  <span className="font-mono">{p.sku}</span>
                  {p.name && <span>/ {p.name}</span>}
                  <button
                    type="button"
                    onClick={() => removeProduct(p.id)}
                    className="ml-1 text-blue-600 hover:text-blue-900"
                    aria-label="移除"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* 搜尋框 */}
          <input
            type="text"
            placeholder="搜尋 SKU / 名稱 / 品牌 後挑選"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />

          {/* 候選清單 */}
          {search.trim() && (
            <div className="mt-1 max-h-48 overflow-auto rounded border border-gray-200">
              {candidates.length === 0 ? (
                <p className="p-2 text-xs text-gray-500">
                  沒有符合的商品(或已全部選入)
                </p>
              ) : (
                candidates.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addProduct(p.id)}
                    className="block w-full border-b border-gray-100 px-3 py-1.5 text-left text-xs hover:bg-blue-50"
                  >
                    <span className="font-mono">{p.sku}</span>
                    {p.brand && (
                      <span className="ml-1 text-gray-500">
                        / {p.brand}
                      </span>
                    )}
                    {p.name && (
                      <span className="ml-1 text-gray-700">
                        / {p.name}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
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
            placeholder="例:買就送收納袋"
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
