import { useState } from 'react';
import { api } from '../lib/api';
import { PROVIDER_LABELS, REAUTH_REQUIRED_MESSAGE } from '../lib/authMessages';
import { useAuthProviders } from '../lib/useAuthProviders';
import ReauthForm from './ReauthForm';

const smallButton = 'shrink-0 rounded-lg border border-leaf-200 px-3 py-1 text-xs font-bold text-leaf-800 transition hover:bg-leaf-50';

/** Các phương thức đăng nhập đã gắn với tài khoản. Liên kết hay hủy liên kết đều phải xác thực lại: chỉ giữ phiên thì không thêm được cửa vào tài khoản */
export default function LoginMethodsSection({ user, onUserChange }) {
  const { loading, providers } = useAuthProviders();
  const methods = user.authMethods || {};
  const [pending, setPending] = useState(null); // { provider, action: 'link' | 'unlink' }
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const perform = async ({ provider, action }) => {
    if (action === 'link') {
      window.location.assign(api.oauthStartUrl(provider, 'link'));
      return;
    }
    const r = await api.unlinkProvider(provider);
    onUserChange?.(r.user);
    setSuccess(`Đã hủy liên kết ${PROVIDER_LABELS[provider]} và đăng xuất các thiết bị khác.`);
  };

  const showError = (err) => setError(err.code === 'reauth_required' ? REAUTH_REQUIRED_MESSAGE : err.message || 'Không xử lý được yêu cầu.');

  const close = () => {
    setPending(null);
    setError('');
  };

  // Tài khoản chưa có mật khẩu không có gì để nhập lại: máy chủ dựa vào phiên vừa đăng nhập từ nhà cung cấp
  const begin = async (next) => {
    setError('');
    setSuccess('');
    if (methods.password) {
      setPending(next);
      return;
    }
    try {
      await perform(next);
    } catch (err) {
      showError(err);
    }
  };

  const otherLinked = (provider) => (provider === 'google' ? methods.facebook : methods.google);

  const status = (linked, provider) => {
    if (linked) {
      return (
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-xs font-bold text-leaf-700">✓ Đã liên kết</span>
          {provider && (methods.password || otherLinked(provider)) && (
            <button
              type="button"
              aria-label={`Hủy liên kết ${PROVIDER_LABELS[provider]}`}
              onClick={() => begin({ provider, action: 'unlink' })}
              className="text-xs font-semibold text-stone-500 underline underline-offset-2"
            >
              Hủy
            </button>
          )}
        </span>
      );
    }
    if (!provider) return <span className="shrink-0 text-xs font-semibold text-stone-400">Chưa thiết lập</span>;
    if (loading) return <span className="shrink-0 text-xs text-stone-400">...</span>;
    if (!providers[provider]?.enabled) {
      return (
        <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold text-stone-500">
          Chưa cấu hình
        </span>
      );
    }
    return (
      <button type="button" onClick={() => begin({ provider, action: 'link' })} className={smallButton}>
        Liên kết
      </button>
    );
  };

  const rows = [
    { label: methods.password ? `Email · ${user.email}` : 'Email và mật khẩu', linked: methods.password },
    { label: 'Google / Gmail', linked: methods.google, provider: 'google' },
    { label: 'Facebook', linked: methods.facebook, provider: 'facebook' },
  ];

  return (
    <div>
      <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-stone-500">Phương thức đăng nhập</h4>
      <ul className="divide-y divide-leaf-50 rounded-xl border border-leaf-50 bg-white shadow-sm">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="min-w-0 truncate text-sm font-semibold text-stone-700">{row.label}</span>
            {status(row.linked, row.provider)}
          </li>
        ))}
      </ul>
      {pending && (
        <ReauthForm
          onConfirmed={async () => {
            await perform(pending);
            close();
          }}
          onCancel={close}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="mt-2 rounded-lg bg-leaf-50 px-3 py-2 text-xs font-semibold text-leaf-800">
          {success}
        </p>
      )}
      {providers.qr?.enabled && (
        <p className="mt-2 text-xs text-stone-500">
          Đăng nhập máy khác bằng QR: chọn «Đăng nhập bằng mã QR» trên máy đó rồi quét bằng thiết bị đang đăng nhập này.
        </p>
      )}
    </div>
  );
}
