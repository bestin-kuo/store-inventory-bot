// 即將到貨匯入。檔案格式固定為:
//   品牌 / 顏色 / 國條碼 / 庫存 / 預計到貨
// 第 1 列就是 header,日期欄是 Excel serial number。
// 每筆用 (barcode + brand) 比對 products,找不到就自動建 SKU。
import { useState } from "react";
import * as XLSX from "xlsx";
import { apiCall } from "../lib/api.js";

// Excel 出來的可能是 Date(cellDates:true)、數字、或字串
function fmtDateValue(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    const yyyy = v.getUTCFullYear();
    const mm = String(v.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(v.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  if (typeof v === "number") {
    // Excel serial number(以防 cellDates 漏掉)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return fmtDateValue(d);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const d = new Date(t);
    if (!isNaN(d.getTime())) return fmtDateValue(d);
    return null;
  }
  return null;
}

function parseFile(arrayBuffer, ext) {
  // CSV 也丟給 SheetJS,反正它都吃
  const wb = XLSX.read(arrayBuffer, {
    type: "array",
    cellDates: true,
  });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const out = [];
  let totalParsed = 0;
  let skippedNoBarcode = 0;
  let skippedNoBrand = 0;
  let skippedNoQty = 0;

  for (const r of raw) {
    totalParsed++;
    const barcode =
      r["國條碼"] != null && r["國條碼"] !== ""
        ? String(r["國條碼"]).trim()
        : "";
    const brand =
      r["品牌"] != null ? String(r["品牌"]).trim() : "";
    const color =
      r["顏色"] != null ? String(r["顏色"]).trim() : "";
    const qtyRaw = r["庫存"];
    const dateVal = r["預計到貨"];

    if (!barcode) {
      skippedNoBarcode++;
      continue;
    }
    if (!brand) {
      skippedNoBrand++;
      continue;
    }
    const qty =
      qtyRaw === "" || qtyRaw == null ? NaN : Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) {
      skippedNoQty++;
      continue;
    }
    const date = fmtDateValue(dateVal);

    out.push({ barcode, brand, color, qty, date });
  }

  return {
    rows: out,
    stats: {
      totalParsed,
      willImport: out.length,
      skippedNoBarcode,
      skippedNoBrand,
      skippedNoQty,
    },
  };
}

const PREVIEW_FIELDS = ["barcode", "brand", "color", "qty", "date"];

export default function IncomingImport({ onClose, onImported }) {
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState(false);

  function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!["xlsx", "xls", "csv"].includes(ext)) {
      setErr("僅支援 .xlsx / .xls / .csv");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { rows: r, stats: s } = parseFile(reader.result, ext);
        setRows(r);
        setStats(s);
        setErr("");
        setParsed(true);
      } catch (ex) {
        setErr(`檔案解析失敗:${ex.message}`);
      }
    };
    reader.onerror = () => setErr("讀取檔案失敗");
    reader.readAsArrayBuffer(file);
  }

  async function confirmImport() {
    if (!rows.length) {
      setErr("沒有可匯入的資料");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const result = await apiCall("import_incoming", "POST", { rows });
      const errCount =
        result.errors && result.errors.length ? result.errors.length : 0;
      const errSample =
        errCount > 0
          ? "\n\n錯誤範例:\n" +
            result.errors
              .slice(0, 5)
              .map(
                (e) =>
                  `- ${e.barcode || "(no barcode)"}: ${e.error}`
              )
              .join("\n")
          : "";
      window.alert(
        `匯入完成:\n` +
          `  新增進貨紀錄 ${result.inserted} 筆\n` +
          `  自動建立新 SKU ${result.autoCreated} 筆\n` +
          `  歧義(barcode+品牌對應到多個 SKU)${result.ambiguous} 筆\n` +
          `  錯誤 ${errCount} 筆${errSample}`
      );
      onImported();
      onClose();
    } catch (e) {
      setErr(e.message || "匯入失敗");
    } finally {
      setBusy(false);
    }
  }

  const preview = rows.slice(0, 5);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-900/60 p-4">
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold">匯入即將到貨</h2>

        {!parsed ? (
          <>
            <p className="mb-3 text-sm text-gray-600">
              支援 <strong>.xlsx / .xls / .csv</strong>,header 欄位:
              <br />
              <code className="text-xs">
                品牌 / 顏色 / 國條碼 / 庫存 / 預計到貨
              </code>
              <br />
              比對方式:用「國條碼 + 品牌」找對應 SKU,找不到會自動建立新 SKU(以國條碼當 SKU)。
              <br />
              到了預計到貨日後系統會每天 09:00 自動把數量併入庫存。
            </p>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFile}
              className="mb-3 block w-full text-sm"
            />
          </>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-600">
              總共 {stats.totalParsed} 筆,將匯入{" "}
              <strong>{stats.willImport}</strong> 筆
              {stats.skippedNoBarcode > 0 &&
                ` / 跳過 ${stats.skippedNoBarcode} 筆(無國條碼)`}
              {stats.skippedNoBrand > 0 &&
                ` / 跳過 ${stats.skippedNoBrand} 筆(無品牌)`}
              {stats.skippedNoQty > 0 &&
                ` / 跳過 ${stats.skippedNoQty} 筆(數量 0 或非法)`}
            </p>
            <div className="mb-3 max-h-64 overflow-auto rounded border border-gray-200">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    {PREVIEW_FIELDS.map((h) => (
                      <th key={h} className="px-2 py-1 text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      {PREVIEW_FIELDS.map((h) => (
                        <td key={h} className="px-2 py-1">
                          {r[h] == null ? "" : String(r[h])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

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
          {parsed && (
            <button
              type="button"
              onClick={confirmImport}
              disabled={busy || rows.length === 0}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-gray-400"
            >
              {busy ? "匯入中…" : `確認匯入 ${rows.length} 筆`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
