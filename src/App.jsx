import { useCallback, useEffect, useState } from "react";
import LoginGate from "./components/LoginGate.jsx";
import ProductTable from "./components/ProductTable.jsx";
import ProductModal from "./components/ProductModal.jsx";
import CsvImport from "./components/CsvImport.jsx";
import IncomingImport from "./components/IncomingImport.jsx";
import PromotionsTab from "./components/PromotionsTab.jsx";
import LineUsersTab from "./components/LineUsersTab.jsx";
import {
  listProducts,
  deleteProduct,
  clearAdminPwd,
  UnauthorizedError,
} from "./lib/api.js";

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState("products"); // "products" | "promotions" | "line_users"
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const [modalMode, setModalMode] = useState(null); // null | "create" | "edit"
  const [editingRow, setEditingRow] = useState(null);
  const [showCsv, setShowCsv] = useState(false);
  const [showIncoming, setShowIncoming] = useState(false);

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
      <main className="mx-auto max-w-screen-2xl p-4 sm:p-6">
        {/* 頂部 tab + 登出 */}
        <div className="mb-4 flex items-center justify-between border-b border-gray-200">
          <nav className="flex gap-1">
            <button
              onClick={() => setTab("products")}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                tab === "products"
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              商品管理
            </button>
            <button
              onClick={() => setTab("promotions")}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                tab === "promotions"
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              活動管理
            </button>
            <button
              onClick={() => setTab("line_users")}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                tab === "line_users"
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              LINE 使用者
            </button>
          </nav>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-500 hover:text-gray-700 hover:underline"
          >
            登出
          </button>
        </div>

        {tab === "products" && (
          <>
            <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold sm:text-xl">商品管理</h2>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  placeholder="搜尋 SKU / 名稱 / 品牌 / 條形碼…"
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
                    匯入庫存
                  </button>
                  <button
                    onClick={() => setShowIncoming(true)}
                    className="flex-1 rounded bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 sm:flex-none"
                  >
                    匯入即將到貨
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
          </>
        )}

        {tab === "promotions" && (
          <PromotionsTab
            products={rows}
            onUnauthorized={() => setAuthed(false)}
          />
        )}

        {tab === "line_users" && (
          <LineUsersTab onUnauthorized={() => setAuthed(false)} />
        )}
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

      {showIncoming && (
        <IncomingImport
          onClose={() => setShowIncoming(false)}
          onImported={reload}
        />
      )}
    </div>
  );
}
