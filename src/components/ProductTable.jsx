import { useMemo } from "react";

function fmtUpdatedAt(d) {
  if (!d) return "";
  if (d.length <= 10) return d;
  return d.replace("T", " ").slice(0, 16);
}

export default function ProductTable({ rows, search, onEdit, onDelete }) {
  const visible = useMemo(() => {
    const q = (search || "").trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => {
          const sku = (r.sku || "").toLowerCase();
          const name = (r.name || "").toLowerCase();
          return sku.includes(q) || name.includes(q);
        })
      : rows;
    return [...filtered].sort((a, b) =>
      String(a.sku || "").localeCompare(String(b.sku || ""))
    );
  }, [rows, search]);

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-100 text-left">
          <tr>
            <th className="whitespace-nowrap px-3 py-2">SKU</th>
            <th className="whitespace-nowrap px-3 py-2">名稱</th>
            <th className="whitespace-nowrap px-3 py-2">品牌</th>
            <th className="whitespace-nowrap px-3 py-2">顏色</th>
            <th className="whitespace-nowrap px-3 py-2 text-right">庫存</th>
            <th className="whitespace-nowrap px-3 py-2">最近進貨</th>
            <th className="whitespace-nowrap px-3 py-2">更新時間</th>
            <th className="whitespace-nowrap px-3 py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td
                colSpan={8}
                className="px-3 py-6 text-center text-gray-500"
              >
                沒有資料
              </td>
            </tr>
          ) : (
            visible.map((r) => (
              <tr
                key={r.id}
                className="border-t border-gray-100 hover:bg-gray-50"
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono">
                  {r.sku}
                </td>
                <td className="px-3 py-2">{r.name || ""}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.brand || ""}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.color || ""}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {r.stock_qty ?? ""}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {(r.incoming && r.incoming[0] && r.incoming[0].date) || ""}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                  {fmtUpdatedAt(r.updated_at)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <button
                    onClick={() => onEdit(r)}
                    className="mr-2 rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50"
                  >
                    編輯
                  </button>
                  <button
                    onClick={() => onDelete(r)}
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                  >
                    刪除
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
