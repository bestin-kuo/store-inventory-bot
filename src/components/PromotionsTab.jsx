import { useCallback, useEffect, useState } from "react";
import {
  listPromotions,
  deletePromotion,
  UnauthorizedError,
} from "../lib/api.js";
import PromotionModal from "./PromotionModal.jsx";

// products: 從 App.jsx 傳入,給 PromotionModal 的下拉用
export default function PromotionsTab({ products, onUnauthorized }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [modalMode, setModalMode] = useState(null); // null | "create" | "edit"
  const [editingRow, setEditingRow] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listPromotions();
      setRows(data.rows || []);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        onUnauthorized();
      } else {
        setError(e.message || "載入失敗");
      }
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    reload();
  }, [reload]);

  const visible = rows.filter((r) =>
    showArchived ? true : !r.archived_at
  );

  function handleNew() {
    setEditingRow(null);
    setModalMode("create");
  }
  function handleEdit(row) {
    setEditingRow(row);
    setModalMode("edit");
  }
  function closeModal() {
    setModalMode(null);
    setEditingRow(null);
  }
  async function handleDelete(row) {
    const count = (row.products || []).length;
    const label = count > 0 ? `綁了 ${count} 個商品` : "";
    if (!window.confirm(`確定刪除活動「${row.info}」${label}?`)) return;
    if (!window.confirm("再次確認:此動作無法復原")) return;
    try {
      await deletePromotion(row.id);
      await reload();
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorized();
      else window.alert(`刪除失敗:${e.message}`);
    }
  }

  return (
    <>
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold sm:text-xl">活動管理</h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-1 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded"
            />
            顯示已歸檔
          </label>
          <button
            onClick={handleNew}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            新增活動
          </button>
        </div>
      </header>

      <div className="mb-3 text-sm text-gray-500">
        {loading
          ? "載入中…"
          : error
          ? <span className="text-red-600">錯誤:{error}</span>
          : `共 ${visible.length} 個活動${
              showArchived ? "(含已歸檔)" : "(進行中)"
            }`}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="whitespace-nowrap px-3 py-2">對象</th>
              <th className="whitespace-nowrap px-3 py-2">商品</th>
              <th className="whitespace-nowrap px-3 py-2">期間</th>
              <th className="px-3 py-2">活動資訊</th>
              <th className="whitespace-nowrap px-3 py-2">狀態</th>
              <th className="whitespace-nowrap px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                  沒有活動
                </td>
              </tr>
            ) : (
              visible.map((r) => {
                const isArchived = !!r.archived_at;
                const today = new Date().toISOString().slice(0, 10);
                const notStarted =
                  !isArchived && r.start_date && r.start_date > today;
                return (
                  <tr
                    key={r.id}
                    className={`border-t border-gray-100 hover:bg-gray-50 ${
                      isArchived ? "opacity-60" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-3 py-2">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs ${
                          r.audience === "百貨"
                            ? "bg-pink-100 text-pink-800"
                            : r.audience === "門市"
                            ? "bg-indigo-100 text-indigo-800"
                            : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {r.audience || "全部"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {(r.products || []).length === 0 ? (
                        <span className="text-xs text-gray-500">
                          (未綁商品)
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {(r.products || []).slice(0, 5).map((p) => (
                            <span
                              key={p.id}
                              className="inline-block rounded bg-blue-50 px-2 py-0.5 text-xs"
                            >
                              <span className="font-mono">{p.sku}</span>
                              {p.name && (
                                <span className="ml-1 text-gray-600">
                                  / {p.name}
                                </span>
                              )}
                            </span>
                          ))}
                          {(r.products || []).length > 5 && (
                            <span className="text-xs text-gray-500">
                              +{(r.products || []).length - 5} 個
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">
                      <div>{r.start_date || "(立即)"}</div>
                      <div className="text-gray-500">↓</div>
                      <div>{r.end_date}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-pre-wrap">{r.info}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {isArchived ? (
                        <span className="inline-block rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                          已歸檔
                        </span>
                      ) : notStarted ? (
                        <span className="inline-block rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">
                          未開始
                        </span>
                      ) : (
                        <span className="inline-block rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">
                          進行中
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <button
                        onClick={() => handleEdit(r)}
                        className="mr-2 rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50"
                      >
                        編輯
                      </button>
                      <button
                        onClick={() => handleDelete(r)}
                        className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        刪除
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modalMode && (
        <PromotionModal
          mode={modalMode}
          row={editingRow}
          products={products}
          onClose={closeModal}
          onSaved={async () => {
            closeModal();
            await reload();
          }}
        />
      )}
    </>
  );
}
