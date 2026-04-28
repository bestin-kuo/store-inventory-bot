import { useCallback, useEffect, useState } from "react";
import LoginGate from "./components/LoginGate.jsx";
import ProductTable from "./components/ProductTable.jsx";
import ProductModal from "./components/ProductModal.jsx";
import CsvImport from "./components/CsvImport.jsx";
import {
  listProducts,
  deleteProduct,
  clearAdminPwd,
  UnauthorizedError,
} from "./lib/api.js";

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const [modalMode, setModalMode] = useState(null); // null | "create" | "edit"
  const [editingRow, setEditingRow] = useState(null);
  const [showCsv, setShowCsv] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listProducts();
      setRows(data.rows || []);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        setAuthed(false);
      } else {
        setError(e.message || "載入失敗");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authed) reload();
  }, [authed, reload]);

  function handleEdit(row) {
    setEditingRow(row);
    setModalMode("edit");
  }

  function handleNew() {
    setEditingRow(null);
    setModalMode("create");
  }

  function closeModal() {
    setModalMode(null);
    setEditingRow(null);
  }

  async function handleDelete(row) {
    const label = row.sku || row.id;
    if (!window.confirm(`確定刪除「${label}」?此動作無法復原。`)) return;
    if (!window.confirm(`再次確認:刪除「${label}」?`)) return;
    try {
      await deleteProduct(row.id);
      await reload();
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        setAuthed(false);
      } else {
        window.alert(`刪除失敗:${e.message}`);
      }
    }
  }

  function handleLogout() {
    clearAdminPwd();
    setAuthed(false);
    setRows([]);
  }

  if (!authed) {
    return <LoginGate onAuthed={() => setAuthed(true)} />;
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold sm:text-2xl">商品管理</h1>
            <button
              onClick={handleLogout}
              className="text-xs text-gray-500 hover:text-gray-700 hover:underline"
            >
              登出
            </button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              placeholder="搜尋 SKU 或名稱…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm sm:w-64"
            />
            <div className="flex gap-2">
              <button
                onClick={handleNew}
                className="flex-1 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 sm:flex-none"
              >
                新增 SKU
              </button>
              <button
                onClick={() => setShowCsv(true)}
                className="flex-1 rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 sm:flex-none"
              >
                匯入 CSV
              </button>
            </div>
          </div>
        </header>

        <div className="mb-3 text-sm text-gray-500">
          {loading
            ? "載入中…"
            : error
            ? <span className="text-red-600">錯誤:{error}</span>
            : `共 ${rows.length} 筆`}
        </div>

        <ProductTable
          rows={rows}
          search={search}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      </main>

      {modalMode && (
        <ProductModal
          mode={modalMode}
          row={editingRow}
          onClose={closeModal}
          onSaved={async () => {
            closeModal();
            await reload();
          }}
        />
      )}

      {showCsv && (
        <CsvImport
          onClose={() => setShowCsv(false)}
          onImported={reload}
        />
      )}
    </div>
  );
}
