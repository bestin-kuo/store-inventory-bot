import { useEffect, useState } from "react";
import {
  apiCall,
  getAdminPwd,
  setAdminPwd,
  clearAdminPwd,
  UnauthorizedError,
} from "../lib/api.js";

// 進頁面先擋密碼;通過後 onAuthed() 通知 App
export default function LoginGate({ onAuthed }) {
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);

  // 若 sessionStorage 已有密碼,先試一次
  useEffect(() => {
    const existing = getAdminPwd();
    if (!existing) {
      setChecked(true);
      return;
    }
    (async () => {
      try {
        await apiCall("list", "GET");
        onAuthed();
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          setErr("密碼已過期,請重新登入");
        } else {
          setErr(e.message || "驗證失敗");
        }
        setChecked(true);
      }
    })();
  }, [onAuthed]);

  async function handleSubmit(e) {
    e.preventDefault();
    const v = pwd.trim();
    if (!v) return;
    setBusy(true);
    setErr("");
    setAdminPwd(v);
    try {
      await apiCall("list", "GET");
      onAuthed();
    } catch (e) {
      clearAdminPwd();
      if (e instanceof UnauthorizedError) {
        setErr("密碼錯誤");
      } else {
        setErr(e.message || "登入失敗");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!checked) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/70">
        <div className="text-white">驗證中…</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/70 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl"
      >
        <h1 className="mb-4 text-lg font-semibold">後台登入</h1>
        <label className="mb-2 block text-sm text-gray-700">管理密碼</label>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          className="mb-2 w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          required
        />
        {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:bg-gray-400"
        >
          {busy ? "驗證中…" : "進入"}
        </button>
      </form>
    </div>
  );
}
