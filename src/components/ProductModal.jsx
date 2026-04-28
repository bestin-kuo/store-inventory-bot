import { useEffect, useState } from "react";
import { createProduct, updateProduct } from "../lib/api.js";

const empty = {
  sku: "",
  name: "",
  color: "",
  stock_qty: "",
  incoming_qty: "",
  incoming_date: "",
};

// mode: "create" | "edit"
// row: 編輯時的原始資料(含 id)
export default function ProductModal({ mode, row, onClose, onSaved }) {
  const [form, setForm] = useState(empty);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "edit" && row) {
      setForm({
        sku: row.sku || "",
        name: row.name || "",
        color: row.color || "",
        stock_qty: row.stock_qty == null ? "" : String(row.stock_qty),
        incoming_qty: row.incoming_qty == null ? "" : String(row.incoming_qty),
        incoming_date: row.incoming_date || "",
      });
    } else {
      setForm(empty);
    }
    setErr("");
  }, [mode, row]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    if (!form.sku.trim()) {
      setErr("SKU 不能空白");
      return;
    }
    const payload = {
      sku: form.sku.trim(),
      name: form.name.trim(),
      color: form.color.trim(),
      stock_qty: form.stock_qty === "" ? null : Number(form.stock_qty),
      incoming_qty: form.incoming_qty === "" ? null : Number(form.incoming_qty),
      incoming_date: form.incoming_date || null,
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
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
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

        <div className="mb-3">
          <label className="mb-1 block text-sm">顏色</label>
          <input
            value={form.color}
            onChange={(e) => update("color", e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm">庫存</label>
            <input
              type="number"
              min="0"
              value={form.stock_qty}
              onChange={(e) => update("stock_qty", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm">進貨數</label>
            <input
              type="number"
              min="0"
              value={form.incoming_qty}
              onChange={(e) => update("incoming_qty", e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm">進貨日(可空)</label>
          <input
            type="date"
            value={form.incoming_date}
            onChange={(e) => update("incoming_date", e.target.value)}
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
