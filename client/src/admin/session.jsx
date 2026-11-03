import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Modal from '../components/Modal';
import { adminApi, onSessionLost, setCsrfToken } from './adminApi';
import { Button, TextField } from './ui';

const AdminSessionContext = createContext(null);

/**
 * Trạng thái đăng nhập chỉ để điều hướng giao diện. Quyền thật được server kiểm tra ở từng API, nên sửa trạng thái này
 * trong trình duyệt cũng không lấy được dữ liệu nào.
 */
export function AdminSessionProvider({ children }) {
  const [session, setSession] = useState({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const data = await adminApi.session();
      setCsrfToken(data.csrfToken);
      setSession({ status: data.stage === 'active' ? 'active' : data.stage === 'mfa' ? 'mfa' : 'none', ...data });
    } catch (err) {
      setCsrfToken('');
      setSession({ status: err.code === 'admin_not_configured' ? 'unconfigured' : 'error', error: err.message });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(
    () =>
      onSessionLost(() => {
        setCsrfToken('');
        setSession((current) => (current.status === 'active' ? { status: 'none', expired: true } : current));
      }),
    []
  );

  const logout = useCallback(async () => {
    try {
      await adminApi.logout();
    } finally {
      setCsrfToken('');
      setSession({ status: 'none' });
    }
  }, []);

  const value = useMemo(() => ({ session, setSession, refresh, logout }), [session, refresh, logout]);
  return <AdminSessionContext.Provider value={value}>{children}</AdminSessionContext.Provider>;
}

export function useAdminSession() {
  const ctx = useContext(AdminSessionContext);
  if (!ctx) throw new Error('useAdminSession must be used within AdminSessionProvider');
  return ctx;
}

const ReauthContext = createContext(null);

/** Bọc thao tác nhạy cảm: server báo reauth_required → hỏi lại mật khẩu + mã MFA rồi thử lại đúng một lần */
export function ReauthProvider({ children }) {
  const [pending, setPending] = useState(null);

  const withReauth = useCallback(async (action) => {
    try {
      return await action();
    } catch (err) {
      if (err.code !== 'reauth_required') throw err;
      await new Promise((resolve, reject) => setPending({ resolve, reject }));
      return action();
    }
  }, []);

  const value = useMemo(() => ({ withReauth }), [withReauth]);
  return (
    <ReauthContext.Provider value={value}>
      {children}
      {pending && (
        <ReauthDialog
          onDone={() => {
            pending.resolve();
            setPending(null);
          }}
          onCancel={() => {
            pending.reject(Object.assign(new Error('Đã hủy xác thực lại.'), { cancelled: true }));
            setPending(null);
          }}
        />
      )}
    </ReauthContext.Provider>
  );
}

export const useReauth = () => useContext(ReauthContext).withReauth;

function ReauthDialog({ onDone, onCancel }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminApi.reauth(password, code.trim());
      onDone();
    } catch (err) {
      setError(err.message || 'Không xác thực được.');
      setCode('');
      setBusy(false);
    }
  };

  return (
    <Modal title="Xác thực lại" onClose={onCancel}>
      <form onSubmit={submit} className="space-y-3 p-5">
        <p className="text-sm text-stone-600">Thao tác này nhạy cảm. Nhập lại mật khẩu và mã từ ứng dụng xác thực để tiếp tục.</p>
        <TextField label="Mật khẩu" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        <TextField label="Mã xác thực" required inputMode="text" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button tone="secondary" onClick={onCancel} disabled={busy}>
            Hủy
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Đang kiểm tra...' : 'Xác nhận'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
