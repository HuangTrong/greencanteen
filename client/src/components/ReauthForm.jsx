import { useState } from 'react';
import { api } from '../lib/api';
import { REAUTH_REQUIRED_MESSAGE } from '../lib/authMessages';

const inputClass =
  'w-full rounded-xl border border-stone-200 px-3 py-2.5 text-sm outline-none ring-leaf-400 focus:ring-2 disabled:bg-stone-50';

/** Nhập lại mật khẩu trước khi đổi cách đăng nhập. Tài khoản đã bật 2FA được máy chủ đòi thêm mã, nên ô mã chỉ hiện khi cần */
export default function ReauthForm({ onConfirmed, onCancel }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.reauth(password, needCode ? code.trim() : undefined);
      await onConfirmed();
    } catch (err) {
      if (err.code === 'invalid_mfa_code' && !needCode) {
        setNeedCode(true);
      } else {
        setError(err.code === 'reauth_required' ? REAUTH_REQUIRED_MESSAGE : err.message || 'Không xử lý được yêu cầu.');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-xl border border-leaf-50 bg-white p-3 shadow-sm">
      <input
        type="password"
        required
        maxLength={128}
        autoComplete="current-password"
        aria-label="Nhập lại mật khẩu để tiếp tục"
        placeholder="Nhập lại mật khẩu để tiếp tục"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
        className={inputClass}
      />
      {needCode && (
        <input
          required
          autoFocus
          maxLength={40}
          autoComplete="one-time-code"
          aria-label="Mã xác thực hai lớp"
          placeholder="Mã xác thực hai lớp"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
          className={inputClass}
        />
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-xl border border-stone-200 py-2 text-sm font-semibold text-stone-600">
          Hủy
        </button>
        <button type="submit" disabled={busy} className="rounded-xl bg-leaf-600 py-2 text-sm font-bold text-white transition hover:bg-leaf-700 disabled:opacity-60">
          {busy ? 'Đang kiểm tra...' : 'Tiếp tục'}
        </button>
      </div>
    </form>
  );
}
