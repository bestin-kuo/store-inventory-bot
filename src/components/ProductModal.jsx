import { useEffect, useState } from "react";
import { createProduct, updateProduct } from "../lib/api.js";

const empty = {
  sku: "",
  name: "",
  brand: "",
  color: "",
  stock_qty: "",
  incoming: [], // [{date, qty}]
};

// mode: "create" | "edit"
// row: 編輯時的原始資料(含 id 與 incoming 陣列)
export default function ProductModal({ mode, row, onClose, onSaved }) {
  const [form, setForm] = useState(empty);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "edit" && row) {
      setForm({
        sku: row.sku || "",
        name: row.name || "",
        brand: row.brand || "",
        color: row.color || "",
        stock_qty: row.stock_qty == null ? "" : String(row.stock_qty),
        incoming: Array.isArray(row.incoming)
          ? row.incoming.map((s) => ({
              date: s.date || "",
              qty: s.qty == null ? "" : String(s.qty),
            }))
          : [],
      });
    } else {
      setForm({ ...empty, incoming: [] });
    }
    setErr("");
  }, [mode, row]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function updateShipment(idx, field, value) {
    setForm((f) => {
      const next = [...f.incoming];
      next[idx] = { ...next[idx], [field]: value };
      return { ...f, incoming: next };
    });
  }

  function addShipment() {
    setForm((f) => ({
      ...f,
      incoming: [...f.incoming, { date: "", qty: "" }],
    }));
  }

  function removeShipment(idx) {
    setForm((f) => ({
      ...f,
      incoming: f.incoming.filter((_, i) => i !== idx),
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    if (!form.sku.trim()) {
      setErr("SKU 不能空白");
      return;
    }
    // 整理進貨清單:略過完全空白的列;有日期沒數量視為錯誤
    const shipments = [];
    for (let i = 0; i < form.incoming.length; i++) {
      const s = form.incoming[i];
      const hasDate = !!s.date;
      const hasQty = s.qty !== "" && s.qty !== null;
      if (!hasDate && !hasQty) continue; // 空列略過
      if (!hasQty) {
        setErr(`第 ${i + 1} 筆進貨缺少數量`);
        return;
      }
      const qtyNum = Number(s.qty);
      if (!Number.isFinite(qtyNum)) {
        setErr(`第 ${i + 1} 筆進貨數量格式錯誤`);
        return;
      }
      shipments.push({ date: s.date || null, qty: qtyNum });
    }

    const payload = {
      sku: form.sku.trim(),
      name: form.name.trim(),
      brand: form.brand.trim(),
      color: form.color.trim(),
      stock_qty: form.stock_qty === "" ? null : Number(form.stock_qty),
      incoming: shipments,
    };

    setBusy(true);
    try {
      if (mode === "edit") {
        await updateProduct({ id: row.id, ...payload });
      } else {
        await createProduct(payload);
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
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-semibold">
          {mode === "edit" ? "編輯 SKU" : "新增 SKU"}
        </h2>

        <div className="mb-3">
          <label className="mb-1 block text-sm">
            SKU <span className="text-red-500">*</span>
          </label>
          <input
            value={form.sku}
            onChange={(e) => update("sku", e.target.value)}
            disabled={mode === "edit"}
            required
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100 disabled:text-gray-500"
          />
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-sm">名稱</label>
          <input
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm">品牌</label>
            <input
              value={form.brand}
              onChange={(e) => update("brand", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm">顏色</label>
            <input
              value={form.color}
              onChange={(e) => update("color", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm">庫存</label>
          <input
            type="number"
            min="0"
            value={form.stock_qty}
            onChange={(e) => update("stock_qty", e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="mb-4 rounded border border-gray-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium">進貨紀錄(可多筆)</label>
            <button
              type="button"
              onClick={addShipment}
              className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50"
            >
              + 新增一筆
            </button>
          </div>
          {form.incoming.length === 0 ? (
            <p className="text-xs text-gray-500">尚無進貨紀錄</p>
          ) : (
            <div className="space-y-2">
              {form.incoming.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="date"
                    value={s.date}
                    onChange={(e) =>
                      updateShipment(i, "date", e.target.value)
                    }
                    className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                  <input
                    type="number"
                    min="0"
                    placeholder="數量"
                    value={s.qty}
                    onChange={(e) =>
                      updateShipment(i, "qty", e.target.value)
                    }
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeShipment(i)}
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                    aria-label="刪除這筆"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
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
