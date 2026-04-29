import { useState } from "react";
import * as XLSX from "xlsx";
import { bulkUpsert } from "../lib/api.js";

// 共用允許欄位(CSV 路徑用)
const ALLOWED = [
  "sku",
  "name",
  "brand",
  "color",
  "stock_qty",
  "incoming_qty",
  "incoming_date",
  "barcode",
];
const NUMERIC = new Set(["stock_qty", "incoming_qty"]);

// === CSV 解析(原樣保留 split 路徑)===

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

function normalizeCsvRows(headers, rows) {
  const known = headers.filter((h) => ALLOWED.includes(h));
  const unknown = headers.filter((h) => !ALLOWED.includes(h));
  const normalized = rows.map((r) => {
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
        o[f] = typeof v === "string" ? v.trim() : v;
      }
    }
    return o;
  });
  return { knownHeaders: known, unknownHeaders: unknown, rows: normalized };
}

// === XLS / XLSX 解析(SheetJS,寫死翔盛-現存量明細表結構)===
// 第 7 列(0-index 6)為 header,內容固定為:
//   品牌名 / 貨品代號 / 貨品名稱 / 庫位名稱 / 現有存量 / 在途量 / 條形碼 / 貨品規格
// 對應規則(寫死,不做動態 mapping):
//   品牌名 → brand;空 → 跳過整列
//   貨品代號 → sku(trim)
//   貨品名稱 → name(trim)
//   現有存量 → stock_qty(空 → 0;有值轉 int,可吃 "1.0")
//   條形碼 → barcode(空 → null,有值 trim)
//   庫位名稱 / 在途量 / 貨品規格 → 忽略
//   color 不從這份檔匯入(後端 upsert 不傳 color,既有色值保留)

function parseXls(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // range: 6 → 從第 7 列開始,把它當 header,後續列當資料
  // defval: "" → 空格用空字串,避免 undefined
  const raw = XLSX.utils.sheet_to_json(sheet, { range: 6, defval: "" });

  let totalParsed = 0;
  let skippedNoBrand = 0;
  const out = [];

  for (const r of raw) {
    totalParsed++;
    const brand = String(r["品牌名"] ?? "").trim();
    if (!brand) {
      skippedNoBrand++;
      // 仍送給後端,後端會再過濾(雙保險、單一回傳資料來源)
      out.push({ brand: "" });
      continue;
    }
    const sku = String(r["貨品代號"] ?? "").trim();
    const name = String(r["貨品名稱"] ?? "").trim();
    const stockRaw = r["現有存量"];
    const stockNum =
      stockRaw === "" || stockRaw == null
        ? 0
        : parseInt(stockRaw, 10) || 0; // parseInt 對 "1.0" / 1.0 都安全
    const barcodeRaw = r["條形碼"];
    const barcode =
      barcodeRaw === "" || barcodeRaw == null
        ? null
        : String(barcodeRaw).trim();

    out.push({
      sku,
      name,
      brand,
      stock_qty: stockNum,
      barcode,
    });
  }
  return { rows: out, totalParsed, skippedNoBrand };
}

// === 元件本體 ===

const PREVIEW_FIELDS_XLS = ["sku", "name", "brand", "stock_qty", "barcode"];

export default function CsvImport({ onClose, onImported }) {
  const [mode, setMode] = useState(null); // "csv" | "xls"
  const [rows, setRows] = useState([]); // 已 normalize,要送後端的陣列
  const [meta, setMeta] = useState({}); // 預覽資訊
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState(false);

  function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();

    if (ext === "csv") {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const { headers, rows: parsedRows } = parseCsv(
            String(reader.result || "")
          );
          const { knownHeaders, unknownHeaders, rows: normalized } =
            normalizeCsvRows(headers, parsedRows);
          setMode("csv");
          setRows(normalized);
          setMeta({ knownHeaders, unknownHeaders, total: normalized.length });
          setErr("");
          setParsed(true);
        } catch (ex) {
          setErr(`CSV 解析失敗:${ex.message}`);
        }
      };
      reader.onerror = () => setErr("讀取檔案失敗");
      reader.readAsText(file, "utf-8");
      return;
    }

    if (ext === "xls" || ext === "xlsx") {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const { rows: normalized, totalParsed, skippedNoBrand } = parseXls(
            reader.result
          );
          setMode("xls");
          setRows(normalized);
          setMeta({
            total: totalParsed,
            willImport: totalParsed - skippedNoBrand,
            skippedNoBrand,
          });
          setErr("");
          setParsed(true);
        } catch (ex) {
          setErr(`Excel 解析失敗:${ex.message}`);
        }
      };
      reader.onerror = () => setErr("讀取檔案失敗");
      reader.readAsArrayBuffer(file);
      return;
    }

    setErr("不支援的檔案格式(僅接受 .csv / .xls / .xlsx)");
  }

  async function confirmImport() {
    if (!rows.length) {
      setErr("沒有可匯入的資料");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const result = await bulkUpsert(rows);
      const errCount =
        result.errors && result.errors.length ? result.errors.length : 0;
      const errMsg =
        errCount > 0
          ? "\n\n錯誤範例:\n" +
            result.errors
              .slice(0, 5)
              .map((e) => `- ${e.sku || "(no sku)"}: ${e.error}`)
              .join("\n")
          : "";
      window.alert(
        `匯入完成:\n` +
          `  成功 upsert ${result.upserted} 筆\n` +
          `  跳過 ${result.skipped} 筆(品牌空)\n` +
          `  錯誤 ${errCount} 筆${errMsg}`
      );
      onImported();
      onClose();
    } catch (e) {
      setErr(e.message || "匯入失敗");
    } finally {
      setBusy(false);
    }
  }

  // === 預覽渲染 ===
  function renderPreview() {
    if (mode === "xls") {
      const willImportRows = rows.filter((r) => r.brand);
      const previewRows = willImportRows.slice(0, 5);
      return (
        <>
          <p className="mb-3 text-sm text-gray-600">
            總共 {meta.total} 筆,會匯入 <strong>{meta.willImport}</strong> 筆
            / 跳過 <strong>{meta.skippedNoBrand}</strong> 筆(品牌空)
            <br />
            (此匯入不會修改既有商品的「顏色」欄,也不會異動進貨紀錄)
          </p>
          <div className="mb-3 max-h-64 overflow-auto rounded border border-gray-200">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  {PREVIEW_FIELDS_XLS.map((h) => (
                    <th key={h} className="px-2 py-1 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    {PREVIEW_FIELDS_XLS.map((h) => (
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
      );
    }
    // CSV 預覽
    const fields = ALLOWED.filter((f) =>
      (meta.knownHeaders || []).includes(f)
    );
    const previewRows = rows.slice(0, 5);
    return (
      <>
        <p className="mb-3 text-sm text-gray-600">
          總共 {rows.length} 筆;
          {fields.length > 0
            ? `辨識欄位:${fields.join(", ")}`
            : "(無有效欄位)"}
          {meta.unknownHeaders && meta.unknownHeaders.length > 0 &&
            ` / 略過未知欄位:${meta.unknownHeaders.join(", ")}`}
          <br />
          注意:CSV 也會套用「品牌空 → 跳過」規則。
        </p>
        <div className="mb-3 max-h-64 overflow-auto rounded border border-gray-200">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                {(fields.length ? fields : ALLOWED).map((h) => (
                  <th key={h} className="px-2 py-1 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r, i) => (
                <tr key={i} className="border-t border-gray-100">
                  {(fields.length ? fields : ALLOWED).map((h) => (
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
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-900/60 p-4">
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold">匯入</h2>

        {!parsed ? (
          <>
            <p className="mb-3 text-sm text-gray-600">
              支援 <strong>.xls / .xlsx</strong>(翔盛-現存量明細表格式,自動跳過前 6 列)
              與 <strong>.csv</strong>(欄位:{ALLOWED.join(", ")}
              ,首列為 header)。
            </p>
            <input
              type="file"
              accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFile}
              className="mb-3 block w-full text-sm"
            />
          </>
        ) : (
          renderPreview()
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
              {busy
                ? "匯入中…"
                : `確認匯入 ${
                    mode === "xls" ? meta.willImport ?? 0 : rows.length
                  } 筆`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
