import { useCallback, useEffect, useState } from "react";
import {
  listLineUsers,
  updateLineUser,
  UnauthorizedError,
} from "../lib/api.js";

const AUDIENCE_OPTIONS = ["未分組", "百貨", "門市"];

export default function LineUsersTab({ onUnauthorized }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listLineUsers();
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

  async function changeAudience(row, newValue) {
    const audience = newValue === "未分組" ? null : newValue;
    setSavingId(row.line_user_id);
    try {
      const result = await updateLineUser({
        line_user_id: row.line_user_id,
        audience,
      });
      // 本地更新一筆,避免 reload 整個列表
      setRows((rs) =>
        rs.map((r) =>
          r.line_user_id === row.line_user_id ? result.row : r
        )
      );
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorized();
      else window.alert(`更新失敗:${e.message}`);
    } finally {
      setSavingId(null);
    }
  }

  function fmtTime(s) {
    if (!s) return "";
    return s.replace("T", " ").slice(0, 16);
  }

  // 統計
  const grouped = { 未分組: 0, 百貨: 0, 門市: 0 };
  for (const r of rows) {
    const k = r.audience || "未分組";
    if (grouped[k] !== undefined) grouped[k]++;
  }

  return (
    <>
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold sm:text-xl">LINE 使用者</h2>
        <div className="text-sm text-gray-600">
          總共 {rows.length} 人 · 百貨 {grouped["百貨"]} · 門市 {grouped["門市"]} · 未分組 {grouped["未分組"]}
        </div>
      </header>

      <div className="mb-3 text-sm text-gray-500">
        {loading
          ? "載入中…"
          : error
          ? <span className="text-red-600">錯誤:{error}</span>
          : "新使用者第一次傳訊息給 bot 後會自動出現在這裡。未分組的使用者只能看到「全部」audience 的活動。"}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="whitespace-nowrap px-3 py-2">LINE 顯示名</th>
              <th className="whitespace-nowrap px-3 py-2">User ID</th>
              <th className="whitespace-nowrap px-3 py-2">分組</th>
              <th className="whitespace-nowrap px-3 py-2">加入時間</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-6 text-center text-gray-500"
                >
                  尚無使用者
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const value = r.audience || "未分組";
                return (
                  <tr
                    key={r.line_user_id}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-3 py-2">
                      {r.display_name || (
                        <span className="text-gray-400">(未取得)</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-500">
                      {r.line_user_id.slice(0, 12)}…
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <select
                        value={value}
                        onChange={(e) => changeAudience(r, e.target.value)}
                        disabled={savingId === r.line_user_id}
                        className="rounded border border-gray-300 bg-white px-2 py-1 text-sm disabled:opacity-50"
                      >
                        {AUDIENCE_OPTIONS.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                      {fmtTime(r.created_at)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
