import { useState } from 'react';
import { api } from '../lib/api';
import { withCaptcha } from '../lib/captcha';
import { useAuthProviders } from '../lib/useAuthProviders';
import { useSiteSettings } from '../context/SiteSettingsContext';
import LoginMethodsSection from './LoginMethodsSection';
import SecuritySection from './SecuritySection';

const inputClass =
  'w-full rounded-xl border border-stone-200 px-3 py-2.5 text-sm outline-none ring-leaf-400 focus:ring-2 disabled:bg-stone-50';
const panelClass = 'rounded-xl border border-leaf-50 bg-white p-3 shadow-sm';

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return '—';
  }
}

function Feedback({ error, success }) {
  if (error) {
    return (
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p role="status" className="rounded-lg bg-leaf-50 px-3 py-2 text-xs font-semibold text-leaf-800">
        {success}
      </p>
    );
  }
  return null;
}

/** Khu vực quản lý tài khoản: thông tin, phương thức đăng nhập, 2FA và passkey, mật khẩu, phiên đăng nhập */
export default function AccountSection({ user, onUserChange, onLogout }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-extrabold text-leaf-800">Quản lý tài khoản</h3>
      <AccountInfo user={user} />
      <LoginMethodsSection user={user} onUserChange={onUserChange} />
      <SecuritySection user={user} />
      <PasswordPanel user={user} onUserChange={onUserChange} />
      <SessionsPanel onLogout={onLogout} />
    </section>
  );
}

function AccountInfo({ user }) {
  const { supportContact } = useSiteSettings();
  const rows = [
    ['Họ và tên', user.name],
    ['Mã sinh viên', user.studentId],
    ['Email', user.email || 'Chưa có'],
    ['Tham gia từ', formatDate(user.createdAt)],
  ];
  return (
    <div className={panelClass}>
      <dl className="space-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="shrink-0 text-stone-500">{label}</dt>
            <dd className="min-w-0 truncate text-right font-bold text-stone-800">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-stone-400">
        Mã sinh viên gắn với điểm, lịch sử và mã nạp nên không tự đổi được. Cần sửa? Liên hệ quản trị viên kèm thẻ sinh
        viên để được xác minh.
      </p>
      {supportContact && <p className="mt-1 text-[11px] font-semibold text-stone-500">Liên hệ: {supportContact}</p>}
    </div>
  );
}

function PasswordPanel({ user, onUserChange }) {
  return user.authMethods?.password ? (
    <ChangePasswordForm onUserChange={onUserChange} />
  ) : (
    <SetPasswordByEmail user={user} />
  );
}

function ChangePasswordForm({ onUserChange }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const onChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (form.next !== form.confirm) {
      setError('Hai mật khẩu mới chưa khớp nhau.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.changePassword(form.current, form.next);
      onUserChange?.(r.user);
      setForm({ current: '', next: '', confirm: '' });
      setOpen(false);
      setSuccess(
        r.revokedSessions > 0
          ? `Đã đổi mật khẩu và đăng xuất ${r.revokedSessions} phiên trên thiết bị khác.`
          : 'Đã đổi mật khẩu.'
      );
    } catch (err) {
      setError(err.message || 'Không đổi được mật khẩu.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${panelClass} space-y-2`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-stone-700">Mật khẩu</span>
        {!open && (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setSuccess('');
            }}
            className="shrink-0 rounded-lg border border-leaf-200 px-3 py-1 text-xs font-bold text-leaf-800 transition hover:bg-leaf-50"
          >
            Đổi mật khẩu
          </button>
        )}
      </div>
      <Feedback error={open ? '' : error} success={success} />
      {open && (
        <form onSubmit={submit} className="space-y-2">
          <Feedback error={error} />
          {[
            ['current', 'Mật khẩu hiện tại', 'current-password'],
            ['next', 'Mật khẩu mới (ít nhất 8 ký tự)', 'new-password'],
            ['confirm', 'Nhập lại mật khẩu mới', 'new-password'],
          ].map(([name, label, autoComplete]) => (
            <input
              key={name}
              name={name}
              type="password"
              required
              minLength={name === 'current' ? undefined : 8}
              maxLength={128}
              aria-label={label}
              placeholder={label}
              autoComplete={autoComplete}
              value={form[name]}
              onChange={onChange}
              disabled={busy}
              className={inputClass}
            />
          ))}
          <p className="text-[11px] text-stone-400">Sau khi đổi, các thiết bị khác đang đăng nhập sẽ bị đăng xuất.</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError('');
              }}
              disabled={busy}
              className="rounded-xl border border-stone-200 py-2 text-sm font-semibold text-stone-600"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-leaf-600 py-2 text-sm font-bold text-white transition hover:bg-leaf-700 disabled:opacity-60"
            >
              {busy ? 'Đang lưu...' : 'Lưu'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Tài khoản đăng nhập bằng Google/Facebook/QR chưa có mật khẩu: đặt qua email (chứng minh sở hữu email) */
function SetPasswordByEmail({ user }) {
  const { loading, providers } = useAuthProviders();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const send = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await withCaptcha((captcha) => api.forgotPassword(user.email, captcha));
      setSuccess(
        r.devConsole ? `${r.message} (Chế độ phát triển: email chỉ được ghi vào log máy chủ.)` : r.message
      );
    } catch (err) {
      setError(err.message || 'Không gửi được email.');
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (!user.email) {
    body = 'Tài khoản đăng nhập bằng Google/Facebook/QR và chưa có email nên không đặt được mật khẩu.';
  } else if (loading) {
    body = 'Đang kiểm tra...';
  } else if (!providers.passwordReset?.enabled) {
    body = 'Đặt mật khẩu qua email chưa được cấu hình trên máy chủ.';
  }

  return (
    <div className={`${panelClass} space-y-2`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-stone-700">Mật khẩu</span>
        <span className="shrink-0 text-xs font-semibold text-stone-400">Chưa thiết lập</span>
      </div>
      {body ? (
        <p className="text-xs text-stone-500">{body}</p>
      ) : (
        <>
          <p className="text-xs text-stone-500">
            Gửi liên kết đặt mật khẩu tới <span className="font-bold">{user.email}</span> để đăng nhập thêm bằng email.
          </p>
          <Feedback error={error} success={success} />
          {!success && (
            <button
              type="button"
              onClick={send}
              disabled={busy}
              className="w-full rounded-xl border border-leaf-200 py-2 text-sm font-bold text-leaf-800 transition hover:bg-leaf-50 disabled:opacity-60"
            >
              {busy ? 'Đang gửi...' : 'Gửi email đặt mật khẩu'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SessionsPanel({ onLogout }) {
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Thành công thì trang chuyển sang trạng thái chưa đăng nhập (panel này bị gỡ); lỗi thì phiên vẫn còn
  const logout = async () => {
    setError('');
    setSuccess('');
    setLoggingOut(true);
    try {
      await onLogout();
    } catch (err) {
      setError(`Không đăng xuất được: ${err.message || 'lỗi không xác định.'} Bạn vẫn đang đăng nhập trên thiết bị này.`);
      setLoggingOut(false);
    }
  };

  const revokeOthers = async () => {
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      const r = await api.revokeOtherSessions();
      setSuccess(
        r.revokedSessions > 0
          ? `Đã đăng xuất ${r.revokedSessions} phiên trên thiết bị khác.`
          : 'Không có thiết bị nào khác đang đăng nhập.'
      );
    } catch (err) {
      setError(err.message || 'Không đăng xuất được các thiết bị khác.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Feedback error={error} success={success} />
      <button
        type="button"
        onClick={revokeOthers}
        disabled={busy}
        className="w-full rounded-xl border border-stone-200 bg-white py-2 text-sm font-semibold text-stone-600 disabled:opacity-60"
      >
        {busy ? 'Đang xử lý...' : 'Đăng xuất khỏi các thiết bị khác'}
      </button>
      <button
        type="button"
        onClick={logout}
        disabled={loggingOut}
        className="w-full rounded-xl border border-red-100 bg-white py-2 text-sm font-bold text-red-700 disabled:opacity-60"
      >
        {loggingOut ? 'Đang đăng xuất...' : 'Đăng xuất'}
      </button>
    </div>
  );
}
