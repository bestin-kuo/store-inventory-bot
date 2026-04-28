import { useRef, useState } from "react";
import { bulkUpsert } from "../lib/api.js";

const ALLOWED = [
  "sku",
  "name",
  "color",
  "stock_qty",
  "incoming_qty",
  "incoming_date",
];
const NUMERIC = new Set(["stock_qty", "incoming_qty"]);

// 簡單 CSV 解析:支援雙引號包字串(含逗號)、雙引號脫逸 ""
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuote = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"' && cur === "") {
        inQuote = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  // 去 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] !== undefined ? cells[idx] : "").trim();
    });
    rows.push(obj);
  }
  return { headers, rows };
}

function normalizeRows(headers, rows) {
  return rows.map((r) => {
    const o = {};
    for (const f of ALLOWED) {
      if (r[f] === undefined) continue;
      const v = r[f];
      if (v === "") {
        o[f] = null;
      } else if (NUMERIC.has(f)) {
        const n = Number(v);
        o[f] = Number.isFinite(n) ? n : null;
      } else {
        o[f] = v;
      }
    }
    return o;
  });
}

// onClose: 關閉並回到主畫面
// onImported: 匯入完成後刷新列表
export default function CsvImport({ onClose, onImported }) {
  const fileRef = useRef(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]); // 已 normalize
  const [unknown, setUnknown] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState(false);

  function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { headers: hs, rows: rs } = parseCsv(String(reader.result || ""));
        const known = hs.filter((h) => ALLOWED.includes(h));
        const unk = hs.filter((h) => !ALLOWED.includes(h));
        const normalized = normalizeRows(hs, rs);
        setHeaders(known);
        setUnknown(unk);
        setRows(normalized);
        setErr("");
        setParsed(true);
      } catch (ex) {
        setErr(`CSV 解析失敗:${ex.message}`);
      }
    };
    reader.onerror = () => setErr("讀取檔案失敗");
    reader.readAsText(file, "utf-8");
  }

  async function confirmImport() {
    if (!rows.length) {
      setErr("沒有可匯入的資料");
      return;
    }
    if (!rows.every((r) => r.sku)) {
      setErr("有資料缺少 sku 欄位,無法匯入");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const result = await bulkUpsert(rows);
      const errMsg =
        result.errors && result.errors.length
          ? "\n\n錯誤範例:\n" +
            result.errors
              .slice(0, 5)
              .map((e) => `- ${e.sku || "(no sku)"}: ${e.error}`)
              .join("\n")
          : "";
      window.alert(
        `匯入完成:成功 ${result.success} 筆 / 失敗 ${result.failed} 筆${errMsg}`
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
        <h2 className="mb-3 text-lg font-semibold">CSV 匯入</h2>

        {!parsed ? (
          <>
            <p className="mb-3 text-sm text-gray-600">
              欄位格式:{ALLOWED.join(", ")}
              <br />
              第一列為 header,逗號分隔。
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="mb-3 block w-full text-sm"
            />
          </>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-600">
              總共 {rows.length} 筆;
              {headers.length > 0 ? `辨識欄位:${headers.join(", ")}` : "(無有效欄位)"}
              {unknown.length > 0 && ` / 略過未知欄位:${unknown.join(", ")}`}
              <br />
              以下為前 5 筆預覽。
            </p>
            <div className="mb-3 max-h-64 overflow-auto rounded border border-gray-200">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    {ALLOWED.map((h) => (
                      <th key={h} className="px-2 py-1 text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      {ALLOWED.map((h) => (
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
