import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import QRCode from 'qrcode';
import { askPasskey, passkeyErrorMessage, passkeySupported } from '../../lib/passkey';
import { adminApi, setCsrfToken } from '../adminApi';
import { useAdminSession } from '../session';
import { Button, ErrorState, LoadingState, TextField } from '../ui';

function Shell({ title, children }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-4">
      <p className="mb-3 text-center font-extrabold text-leaf-800">
        <span aria-hidden="true">🌿</span> GreenCanteen
      </p>
      <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <h1 className="mb-4 text-lg font-extrabold text-stone-800">{title}</h1>
        {children}
      </div>
    </main>
  );
}

const FormError = ({ message }) =>
  message ? (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
      {message}
    </p>
  ) : null;

function PasswordStep({ notice, onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await adminApi.login(email, password);
      setCsrfToken(result.csrfToken);
      onDone(result);
    } catch (err) {
      setError(err.message || 'Không đăng nhập được.');
      setBusy(false);
    }
  };

  return (
    <Shell title="Đăng nhập quản trị">
      <form onSubmit={submit} className="space-y-3">
        {notice && (
          <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
            {notice}
          </p>
        )}
        <TextField label="Email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        <TextField label="Mật khẩu" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        <FormError message={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Đang kiểm tra...' : 'Tiếp tục'}
        </Button>
      </form>
    </Shell>
  );
}

function VerifyStep({ passkeyAvailable, onDone }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await adminApi.mfaVerify(code.trim()));
    } catch (err) {
      setError(err.message || 'Không xác thực được.');
      setCode('');
      setBusy(false);
    }
  };

  const loginWithPasskey = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await askPasskey(await adminApi.passkeyOptions());
      onDone(await adminApi.passkeyVerify(response));
    } catch (err) {
      setError(passkeyErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Shell title="Xác thực hai lớp">
      <form onSubmit={submit} className="space-y-3">
        <TextField
          label="Mã xác thực"
          hint="6 chữ số từ ứng dụng xác thực, hoặc một mã khôi phục."
          required
          autoFocus
          inputMode="text"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
        />
        <FormError message={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Đang kiểm tra...' : 'Đăng nhập'}
        </Button>
        {passkeyAvailable && passkeySupported() && (
          <Button tone="secondary" disabled={busy} onClick={loginWithPasskey} className="w-full">
            Dùng passkey
          </Button>
        )}
      </form>
    </Shell>
  );
}

function EnrollStep({ onDone }) {
  const [enrollCode, setEnrollCode] = useState('');
  const [setup, setSetup] = useState(null); // { secret, qrImage }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const start = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { secret, otpauthUri } = await adminApi.mfaSetup(enrollCode.trim());
      const qrImage = await QRCode.toDataURL(otpauthUri, { width: 220, margin: 1, errorCorrectionLevel: 'M' });
      setSetup({ secret, qrImage });
    } catch (err) {
      setError(err.message || 'Không bắt đầu được đăng ký.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await adminApi.mfaVerify(code.trim()));
    } catch (err) {
      setError(err.message || 'Mã chưa đúng.');
      setCode('');
      setBusy(false);
    }
  };

  if (!setup) {
    return (
      <Shell title="Đăng ký xác thực hai lớp">
        <form onSubmit={start} className="space-y-3">
          <p className="text-sm text-stone-600">Tài khoản quản trị bắt buộc có MFA. Nhập mã đăng ký dùng một lần do người cấp quyền trao cho bạn.</p>
          <TextField label="Mã đăng ký" required autoComplete="off" value={enrollCode} onChange={(e) => setEnrollCode(e.target.value)} disabled={busy} />
          <FormError message={error} />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Đang kiểm tra...' : 'Tiếp tục'}
          </Button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title="Gắn ứng dụng xác thực">
      <form onSubmit={confirm} className="space-y-3">
        <p className="text-sm text-stone-600">Quét mã này bằng ứng dụng xác thực (Google Authenticator, Microsoft Authenticator, Aegis...).</p>
        <img src={setup.qrImage} alt="Mã QR đăng ký ứng dụng xác thực" className="mx-auto h-52 w-52" />
        <div>
          <p className="text-xs font-semibold text-stone-500">Hoặc nhập khóa thủ công</p>
          <p data-testid="mfa-secret" className="break-all rounded-lg bg-stone-100 px-3 py-2 font-mono text-sm text-stone-800">
            {setup.secret}
          </p>
        </div>
        <TextField label="Mã 6 chữ số" required autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
        <FormError message={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Đang kiểm tra...' : 'Hoàn tất'}
        </Button>
      </form>
    </Shell>
  );
}

function RecoveryCodes({ codes, onContinue }) {
  const [saved, setSaved] = useState(false);
  return (
    <Shell title="Lưu mã khôi phục">
      <div className="space-y-3">
        <p className="text-sm text-stone-600">Mỗi mã dùng được một lần khi mất thiết bị xác thực. Các mã này chỉ hiển thị một lần, hãy lưu ở nơi an toàn.</p>
        <ul aria-label="Mã khôi phục" className="grid grid-cols-1 gap-1 rounded-xl bg-stone-100 p-3 font-mono text-sm text-stone-800">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Tôi đã lưu các mã này
        </label>
        <Button disabled={!saved} onClick={onContinue} className="w-full">
          Vào khu quản trị
        </Button>
      </div>
    </Shell>
  );
}

export default function LoginPage() {
  const { session, setSession, refresh } = useAdminSession();
  const navigate = useNavigate();
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  useEffect(() => {
    document.title = 'Đăng nhập · Quản trị GreenCanteen';
  }, []);

  const finishLogin = (result) => {
    setCsrfToken(result.csrfToken);
    if (result.recoveryCodes) {
      setRecoveryCodes({ codes: result.recoveryCodes, session: { status: 'active', ...result } });
      return;
    }
    setSession({ status: 'active', ...result });
    navigate('/', { replace: true });
  };

  if (recoveryCodes) {
    return (
      <RecoveryCodes
        codes={recoveryCodes.codes}
        onContinue={() => {
          setSession(recoveryCodes.session);
          navigate('/', { replace: true });
        }}
      />
    );
  }

  switch (session.status) {
    case 'loading':
      return <LoadingState text="Đang kiểm tra phiên đăng nhập..." />;
    case 'active':
      return <Navigate to="/" replace />;
    case 'unconfigured':
      return (
        <Shell title="Khu quản trị chưa sẵn sàng">
          <p role="alert" className="text-sm text-stone-600">
            Máy chủ chưa được cấu hình cho khu quản trị nên mọi truy cập đều bị từ chối. Xem hướng dẫn khởi tạo trong tài liệu triển khai.
          </p>
        </Shell>
      );
    case 'error':
      return (
        <Shell title="Không kết nối được">
          <ErrorState message={session.error || 'Không kiểm tra được phiên đăng nhập.'} onRetry={refresh} />
        </Shell>
      );
    case 'mfa':
      return session.mfaEnrolled ? <VerifyStep passkeyAvailable={session.passkeyAvailable} onDone={finishLogin} /> : <EnrollStep onDone={finishLogin} />;
    default:
      return (
        <PasswordStep
          notice={session.expired ? 'Phiên làm việc đã hết hạn. Hãy đăng nhập lại.' : ''}
          onDone={(result) => setSession({ status: 'mfa', ...result })}
        />
      );
  }
}
