import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import QrLoginPanel from './QrLoginPanel';
import { api } from '../lib/api';
import { useUser } from '../context/UserContext';
import { useAuthProviders } from '../lib/useAuthProviders';
import { PROVIDER_LABELS } from '../lib/authMessages';
import { withCaptcha } from '../lib/captcha';
import { passkeyErrorMessage, passkeySupported, signInWithPasskey } from '../lib/passkey';

const inputClass =
  'w-full rounded-xl border border-stone-200 px-3 py-2.5 text-sm outline-none ring-leaf-400 focus:ring-2 disabled:bg-stone-50';
const primaryButtonClass =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-leaf-600 py-3 text-sm font-bold text-white shadow-md transition hover:bg-leaf-700 disabled:opacity-60';

const SUCCESS_CLOSE_DELAY_MS = 1200;
const RESEND_COOLDOWN_SECONDS = 60;

const VIEW_TITLES = {
  qr: 'Đăng nhập bằng mã QR',
  mfa: 'Xác thực hai lớp',
  'complete-signup': 'Hoàn tất đăng ký',
  forgot: 'Quên mật khẩu',
  reset: 'Đặt mật khẩu mới',
  'verify-sent': 'Kiểm tra email của bạn',
  'verify-resend': 'Gửi lại email xác minh',
  'verify-email': 'Kích hoạt tài khoản',
};

/**
 * Popup đăng nhập / đăng ký: Google, Facebook, mã QR, passkey, email + mật khẩu, quên / đặt lại mật khẩu, bước hai của 2FA.
 * initialView 'complete-signup' dùng khi quay về từ Google/Facebook với danh tính chưa có tài khoản;
 * 'mfa' dùng khi quay về từ Google/Facebook với tài khoản đã bật 2FA;
 * 'reset' / 'verify-email' dùng khi mở liên kết trong email (resetToken, verifyToken chỉ nằm trong bộ nhớ).
 */
export default function AuthModal({ initialView = 'methods', initialError = '', notice = '', resetToken = '', verifyToken = '', onClose }) {
  const { login } = useUser();
  const [view, setView] = useState(initialView);
  const [success, setSuccess] = useState(null);
  const [registration, setRegistration] = useState(null); // { email, message, devConsole } sau khi gửi form đăng ký
  const closeTimer = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // Đăng nhập xong: cập nhật hồ sơ ngay (trang phía sau hiện hồ sơ), báo thành công rồi tự đóng popup
  const finish = (user, text) => {
    login(user);
    setSuccess({ text, name: user.name });
    setView('success');
    closeTimer.current = setTimeout(() => onCloseRef.current(), SUCCESS_CLOSE_DELAY_MS);
  };

  const title = VIEW_TITLES[view] || 'Đăng nhập / Đăng ký';

  return (
    <Modal title={title} onClose={onClose}>
      <div className="p-5">
        {view === 'methods' && (
          <MethodsView
            initialError={initialError}
            notice={notice}
            onQr={() => setView('qr')}
            onForgot={() => setView('forgot')}
            onResend={() => setView('verify-resend')}
            onRegistered={(sent) => {
              setRegistration(sent);
              setView('verify-sent');
            }}
            onMfaRequired={() => setView('mfa')}
            onSuccess={finish}
          />
        )}
        {view === 'mfa' && <MfaView onSuccess={finish} onBack={() => setView('methods')} />}
        {view === 'verify-sent' && registration && <VerificationSentView {...registration} onBack={() => setView('methods')} />}
        {view === 'verify-resend' && <ResendVerificationView onBack={() => setView('methods')} />}
        {view === 'verify-email' && (
          <VerifyEmailView token={verifyToken} onSuccess={finish} onRequestNew={() => setView('verify-resend')} onBack={() => setView('methods')} />
        )}
        {view === 'forgot' && (
          <ForgotPasswordView
            onBack={() => setView('methods')}
            onSuccess={(user) => finish(user, 'Đã đặt mật khẩu mới')}
            onMfaRequired={() => setView('mfa')}
          />
        )}
        {view === 'reset' && (
          <ResetPasswordView
            token={resetToken}
            onSuccess={(user) => finish(user, 'Đã đặt mật khẩu mới')}
            onMfaRequired={() => setView('mfa')}
            onRequestNew={() => setView('forgot')}
          />
        )}
        {view === 'qr' && (
          <div className="space-y-3">
            <QrLoginPanel onSuccess={(user) => finish(user, 'Đăng nhập bằng mã QR thành công')} />
            <BackButton onClick={() => setView('methods')} />
          </div>
        )}
        {view === 'complete-signup' && <CompleteSignupView onSuccess={finish} onCancel={() => setView('methods')} />}
        {view === 'success' && success && (
          <div role="status" className="space-y-2 py-6 text-center">
            <div className="animate-pop-in mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-leaf-100 text-2xl font-extrabold text-leaf-700">
              ✓
            </div>
            <p className="text-lg font-extrabold text-leaf-800">{success.text}</p>
            <p className="text-sm text-stone-500">Xin chào, {success.name}!</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function MethodsView({ initialError, notice, onQr, onForgot, onResend, onRegistered, onMfaRequired, onSuccess }) {
  const { loading, error: providersError, providers } = useAuthProviders();
  const [redirecting, setRedirecting] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(initialError);

  // Bấm Back từ trang Google/Facebook (trang được khôi phục từ bfcache) → bỏ trạng thái "đang chuyển"
  useEffect(() => {
    const onPageShow = (e) => {
      if (e.persisted) setRedirecting('');
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const unavailableReason = (key) => {
    if (loading) return 'Đang kiểm tra...';
    if (providersError) return providersError;
    return providers[key]?.enabled ? '' : 'Chưa cấu hình';
  };

  const startOAuth = (provider) => {
    setError('');
    setRedirecting(provider);
    window.location.assign(api.oauthStartUrl(provider, 'login'));
  };

  const oauthButton = (provider, icon) => {
    const reason = unavailableReason(provider);
    const name = PROVIDER_LABELS[provider];
    return (
      <MethodButton
        icon={icon}
        label={redirecting === provider ? `Đang chuyển tới ${name}...` : `Tiếp tục với ${name}`}
        status={reason}
        disabled={Boolean(reason) || Boolean(redirecting)}
        onClick={() => startOAuth(provider)}
      />
    );
  };

  const qrReason = unavailableReason('qr');

  const loginWithPasskey = async () => {
    setError('');
    setSigningIn(true);
    try {
      onSuccess(await signInWithPasskey(), 'Đăng nhập bằng passkey thành công');
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="space-y-4">
      {notice && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">{notice}</p>}
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}

      <div className="space-y-2">
        {oauthButton('google', <GoogleIcon />)}
        {oauthButton('facebook', <FacebookIcon />)}
        <MethodButton
          icon={<QrIcon />}
          label="Đăng nhập bằng mã QR"
          status={qrReason}
          disabled={Boolean(qrReason) || Boolean(redirecting)}
          onClick={onQr}
        />
        <MethodButton
          icon={<KeyIcon />}
          label={signingIn ? 'Đang chờ xác nhận trên thiết bị...' : 'Đăng nhập bằng passkey'}
          status={passkeySupported() ? '' : 'Trình duyệt chưa hỗ trợ'}
          disabled={!passkeySupported() || signingIn || Boolean(redirecting)}
          onClick={loginWithPasskey}
        />
      </div>

      <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-wide text-stone-400">
        <span className="h-px flex-1 bg-stone-200" />
        hoặc dùng email
        <span className="h-px flex-1 bg-stone-200" />
      </div>

      <EmailForms
        onSuccess={onSuccess}
        onForgot={onForgot}
        onResend={onResend}
        onRegistered={onRegistered}
        onMfaRequired={onMfaRequired}
        disabled={Boolean(redirecting) || signingIn}
        registrationBlocked={!loading && !providersError && providers.emailVerification?.enabled === false}
      />

      <p className="text-center text-[11px] text-stone-500">
        Khi đăng nhập hoặc tạo tài khoản, dữ liệu của bạn được xử lý theo{' '}
        <a href="/privacy.html" target="_blank" rel="noopener" className="font-bold text-leaf-700 underline underline-offset-2">
          Chính sách bảo mật và xử lý dữ liệu cá nhân
        </a>
        . Xem thêm{' '}
        <a href="/terms.html" target="_blank" rel="noopener" className="font-bold text-leaf-700 underline underline-offset-2">
          Điều khoản sử dụng
        </a>
        .
      </p>
    </div>
  );
}

function EmailForms({ onSuccess, onForgot, onResend, onRegistered, onMfaRequired, disabled, registrationBlocked }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', studentId: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  const switchMode = (next) => {
    setMode(next);
    setError('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        const { user, mfaRequired } = await withCaptcha((captcha) => api.login({ email: form.email, password: form.password }, captcha));
        if (mfaRequired) onMfaRequired();
        else onSuccess(user, 'Đăng nhập thành công');
      } else {
        // Chỉ gửi họ tên + mã SV (để gắn với check-in) cùng email/mật khẩu — không có Khoa/Viện, Lớp
        const sent = await withCaptcha((captcha) =>
          api.register({ name: form.name, studentId: form.studentId, email: form.email, password: form.password }, captcha)
        );
        onRegistered({ email: form.email, message: sent.message, devConsole: sent.devConsole });
      }
    } catch (err) {
      setError(err.message || 'Không thể xử lý yêu cầu.');
    } finally {
      setBusy(false);
    }
  };

  const isRegister = mode === 'register';
  const tabClass = (active) =>
    `rounded-lg py-1.5 transition ${active ? 'bg-white text-leaf-800 shadow-sm' : 'text-leaf-700'}`;

  const tabs = (
    <div className="grid grid-cols-2 rounded-xl bg-leaf-100 p-1 text-xs font-bold" role="tablist">
      <button type="button" role="tab" aria-selected={!isRegister} onClick={() => switchMode('login')} className={tabClass(!isRegister)}>
        Đăng nhập
      </button>
      <button type="button" role="tab" aria-selected={isRegister} onClick={() => switchMode('register')} className={tabClass(isRegister)}>
        Tạo tài khoản
      </button>
    </div>
  );

  // Không gửi được thư xác minh thì không có cách nào kích hoạt tài khoản → nói rõ, không cho điền form
  if (isRegister && registrationBlocked) {
    return (
      <div className="space-y-3">
        {tabs}
        <div role="alert" className="rounded-xl bg-stone-100 px-3 py-3 text-sm text-stone-700">
          <p className="font-bold">
            <span className="mr-2 rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold text-stone-600">Chưa cấu hình</span>
            Đăng ký bằng email chưa sẵn sàng
          </p>
          <p className="mt-1 text-xs">
            Máy chủ chưa cấu hình gửi email nên chưa xác minh được địa chỉ của bạn. Vui lòng liên hệ quản trị viên GreenCanteen, hoặc dùng
            Google/Facebook nếu đã được bật.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tabs}

      <form onSubmit={submit} className="space-y-3">
        {error && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
            {error}
          </p>
        )}
        {isRegister && <StudentFields form={form} onChange={onChange} disabled={busy} />}
        <TextField
          label="Email *"
          name="email"
          type="email"
          required
          autoComplete="email"
          value={form.email}
          onChange={onChange}
          disabled={busy}
        />
        <TextField
          label={isRegister ? 'Mật khẩu (ít nhất 8 ký tự) *' : 'Mật khẩu *'}
          name="password"
          type="password"
          required
          minLength={isRegister ? 8 : undefined}
          maxLength={128}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          value={form.password}
          onChange={onChange}
          disabled={busy}
        />
        {isRegister && (
          <p className="text-[11px] text-stone-500">
            Nên dùng một cụm từ dài. Sau khi gửi, hãy mở email để kích hoạt tài khoản; trước đó chưa đăng nhập được.
          </p>
        )}
        <button type="submit" disabled={busy || disabled} className={primaryButtonClass}>
          {busy && <Spinner />}
          {busy ? (isRegister ? 'Đang gửi email xác minh...' : 'Đang đăng nhập...') : isRegister ? 'Tạo tài khoản' : 'Đăng nhập'}
        </button>
        {!isRegister && (
          <>
            <button
              type="button"
              onClick={onForgot}
              disabled={busy}
              className="w-full text-center text-xs font-bold text-leaf-700 underline-offset-2 hover:underline"
            >
              Quên mật khẩu?
            </button>
            <button
              type="button"
              onClick={onResend}
              disabled={busy}
              className="w-full text-center text-xs font-bold text-leaf-700 underline-offset-2 hover:underline"
            >
              Chưa nhận được email xác minh?
            </button>
          </>
        )}
      </form>
    </div>
  );
}

/** Bước hai khi tài khoản đã bật 2FA: chưa có phiên cho tới khi nhập đúng mã */
function MfaView({ onSuccess, onBack }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { user } = await api.mfaVerify(code.trim());
      onSuccess(user, 'Đăng nhập thành công');
    } catch (err) {
      setError(err.message || 'Không xác thực được.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-stone-600">Nhập mã 6 chữ số từ ứng dụng xác thực, hoặc một mã khôi phục nếu bạn không còn thiết bị đó.</p>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <TextField
        label="Mã xác thực *"
        name="code"
        required
        autoFocus
        maxLength={40}
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={busy}
      />
      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {busy && <Spinner />}
        {busy ? 'Đang kiểm tra...' : 'Xác nhận'}
      </button>
      <BackButton onClick={onBack} label="← Quay lại đăng nhập" />
    </form>
  );
}

/** Đã gửi form đăng ký: tài khoản chưa được tạo cho tới khi người dùng mở liên kết trong thư */
function VerificationSentView({ email, message, devConsole, onBack }) {
  const [notice, setNotice] = useState(message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!cooldown) return undefined;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await withCaptcha((captcha) => api.resendVerification(email, captcha));
      setNotice(r.message);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err.message || 'Không gửi được yêu cầu.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div role="status" className="rounded-xl bg-leaf-50 px-3 py-3 text-sm font-semibold text-leaf-900">
        ✉️ {notice}
      </div>
      <p className="text-xs text-stone-500">Tài khoản chỉ hoạt động sau khi bạn mở liên kết trong email. Không thấy email? Kiểm tra thư mục Spam.</p>
      {devConsole && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          Chế độ phát triển: email được ghi vào log máy chủ, không gửi thật.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <button type="button" onClick={resend} disabled={busy || cooldown > 0} className={primaryButtonClass}>
        {busy && <Spinner />}
        {busy ? 'Đang gửi...' : cooldown > 0 ? `Gửi lại sau ${cooldown} giây` : 'Gửi lại email xác minh'}
      </button>
      <BackButton onClick={onBack} label="← Quay lại đăng nhập" />
    </div>
  );
}

function ResendVerificationView({ onBack }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null); // { message, devConsole }

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await withCaptcha((captcha) => api.resendVerification(email, captcha));
      setSent({ message: r.message, devConsole: r.devConsole });
    } catch (err) {
      setError(err.message || 'Không gửi được yêu cầu.');
    } finally {
      setBusy(false);
    }
  };

  if (sent) return <VerificationSentView email={email} message={sent.message} devConsole={sent.devConsole} onBack={onBack} />;

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-stone-600">Nhập email bạn đã dùng khi đăng ký để nhận liên kết kích hoạt mới.</p>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <TextField
        label="Email *"
        name="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />
      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {busy && <Spinner />}
        {busy ? 'Đang gửi...' : 'Gửi lại email xác minh'}
      </button>
      <BackButton onClick={onBack} label="← Quay lại đăng nhập" />
    </form>
  );
}

/** Mở liên kết trong email: phải nhập đúng mật khẩu đã đặt, nên người khác đăng ký bằng email của bạn không kích hoạt được qua tay bạn */
function VerifyEmailView({ token, onSuccess, onRequestNew, onBack }) {
  const [form, setForm] = useState({ password: '', claimCode: '' });
  const [needClaimCode, setNeedClaimCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [closed, setClosed] = useState(token ? null : { message: 'Liên kết xác minh không hợp lệ hoặc đã hết hạn.', canResend: true });

  const onChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const body = { token, password: form.password };
      if (needClaimCode) body.claimCode = form.claimCode;
      const { user, claimed } = await api.verifyEmail(body);
      onSuccess(user, claimed ? 'Đã nhận lại tài khoản cũ' : 'Tạo tài khoản thành công');
    } catch (err) {
      if (err.code === 'legacy_claim_required') {
        setNeedClaimCode(true);
        setInfo(err.message);
      } else if (err.code === 'verification_token_invalid' || err.code === 'registration_conflict') {
        setClosed({ message: err.message, canResend: err.code === 'verification_token_invalid' });
      } else {
        setError(err.message || 'Không kích hoạt được tài khoản.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (closed) {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {closed.message}
        </p>
        {closed.canResend && (
          <button type="button" onClick={onRequestNew} className={primaryButtonClass}>
            Gửi lại email xác minh
          </button>
        )}
        <BackButton onClick={onBack} label="← Quay lại đăng nhập" />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-stone-600">
        Nhập mật khẩu bạn đã đặt khi đăng ký để kích hoạt tài khoản. Nếu bạn không đăng ký GreenCanteen, hãy đóng cửa sổ này.
      </p>
      {info && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">{info}</p>}
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <TextField
        label="Mật khẩu đã đặt khi đăng ký *"
        name="password"
        type="password"
        required
        maxLength={128}
        autoComplete="current-password"
        value={form.password}
        onChange={onChange}
        disabled={busy}
      />
      {needClaimCode && <ClaimCodeField value={form.claimCode} onChange={onChange} disabled={busy} />}
      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {busy && <Spinner />}
        {busy ? 'Đang kích hoạt...' : 'Kích hoạt tài khoản'}
      </button>
    </form>
  );
}

function ForgotPasswordView({ onBack, onSuccess, onMfaRequired }) {
  const { loading, error: providersError, providers } = useAuthProviders();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null); // { message, devConsole, codeLength }

  const available = providers.passwordReset?.enabled;
  const withCode = providers.passwordReset?.code;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await withCaptcha((captcha) => api.forgotPassword(email, captcha));
      setSent({ message: r.message, devConsole: r.devConsole, codeLength: r.codeLength || 0 });
    } catch (err) {
      setError(err.message || 'Không gửi được yêu cầu.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="text-sm text-stone-500">Đang kiểm tra cấu hình máy chủ...</p>;

  // Máy chủ chưa cấu hình gửi email → nói rõ, không cho gửi yêu cầu (không bao giờ báo "đã gửi")
  if (providersError || !available) {
    return (
      <div className="space-y-3">
        <div role="alert" className="rounded-xl bg-stone-100 px-3 py-3 text-sm text-stone-700">
          <p className="font-bold">
            <span className="mr-2 rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold text-stone-600">
              {providersError ? 'Không kết nối được' : 'Chưa cấu hình'}
            </span>
            Đặt lại mật khẩu qua email chưa sẵn sàng
          </p>
          <p className="mt-1 text-xs">
            {providersError ||
              'Máy chủ chưa được cấu hình gửi email. Vui lòng liên hệ quản trị viên GreenCanteen, hoặc đăng nhập bằng Google/Facebook/QR nếu tài khoản đã liên kết.'}
          </p>
        </div>
        <BackButton onClick={onBack} />
      </div>
    );
  }

  if (sent?.codeLength) {
    return (
      <ResetCodeForm
        email={email}
        {...sent}
        onResent={(r) => setSent((s) => ({ ...s, message: `${r.message} Mã và liên kết trong email trước (nếu có) không còn dùng được.`, devConsole: r.devConsole }))}
        onChangeEmail={() => setSent(null)}
        onBack={onBack}
        onSuccess={onSuccess}
        onMfaRequired={onMfaRequired}
      />
    );
  }

  // Máy chủ chưa có khóa cho mã: thư chỉ có liên kết
  if (sent) {
    return (
      <div className="space-y-3">
        <div role="status" className="rounded-xl bg-leaf-50 px-3 py-3 text-sm font-semibold text-leaf-900">
          ✉️ {sent.message}
        </div>
        <DevConsoleNote show={sent.devConsole} />
        <p className="text-xs text-stone-500">Không thấy email? Kiểm tra thư mục Spam, hoặc gửi lại sau vài phút.</p>
        <BackButton onClick={onBack} label="← Quay lại đăng nhập" />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-stone-600">
        {withCode
          ? 'Nhập email của tài khoản. Nếu email đã đăng ký, bạn sẽ nhận được mã 6 số và liên kết để đặt mật khẩu mới (hiệu lực 30 phút).'
          : 'Nhập email của tài khoản. Nếu email đã đăng ký, bạn sẽ nhận được liên kết đặt mật khẩu mới (hiệu lực 30 phút).'}
      </p>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <TextField
        label="Email *"
        name="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />
      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {busy && <Spinner />}
        {busy ? 'Đang gửi...' : 'Gửi email đặt lại'}
      </button>
      <BackButton onClick={onBack} label="← Quay lại đăng nhập" />
    </form>
  );
}

/** Đã gửi thư có mã: nhập mã + mật khẩu mới ngay trong popup. Liên kết trong cùng thư vẫn dùng được thay cho mã */
function ResetCodeForm({ email, message, devConsole, codeLength, onResent, onChangeEmail, onBack, onSuccess, onMfaRequired }) {
  const [form, setForm] = useState({ code: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  // Vừa gửi xong: chờ một lúc rồi mới cho gửi lại, tránh bấm liên tục làm mã trong thư trước mất hiệu lực
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (!cooldown) return undefined;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const onChange = (e) => {
    const { name, value } = e.target;
    // Dán "123 456" hay "123-456" từ thư vẫn ra đúng mã
    setForm((f) => ({ ...f, [name]: name === 'code' ? value.replace(/\D/g, '').slice(0, codeLength) : value }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.code.length !== codeLength) {
      setError(`Mã gồm ${codeLength} chữ số.`);
      return;
    }
    if (form.password !== form.confirm) {
      setError('Hai mật khẩu chưa khớp nhau.');
      return;
    }
    setBusy(true);
    try {
      const { user, mfaRequired } = await api.resetPasswordWithCode(email, form.code, form.password);
      if (mfaRequired) onMfaRequired();
      else onSuccess(user);
    } catch (err) {
      if (err.code === 'reset_code_invalid') setForm((f) => ({ ...f, code: '' }));
      setError(err.message || 'Không đặt lại được mật khẩu.');
      setBusy(false);
    }
  };

  const resend = async () => {
    setError('');
    setResending(true);
    try {
      const r = await withCaptcha((captcha) => api.forgotPassword(email, captcha));
      onResent(r);
      setForm((f) => ({ ...f, code: '' }));
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err.message || 'Không gửi được yêu cầu.');
    } finally {
      setResending(false);
    }
  };

  const locked = busy || resending;

  return (
    <form onSubmit={submit} className="space-y-3">
      <div role="status" className="rounded-xl bg-leaf-50 px-3 py-3 text-sm font-semibold text-leaf-900">
        ✉️ {message}
      </div>
      <DevConsoleNote show={devConsole} />
      <p className="text-xs text-stone-500">
        Nhập mã trong email gửi tới <span className="font-bold text-stone-700">{email}</span>, hoặc mở liên kết trong email đó. Không thấy email? Kiểm
        tra thư mục Spam.
      </p>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <TextField
        label={`Mã ${codeLength} số trong email *`}
        name="code"
        required
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        className="text-center font-mono text-lg tracking-[0.4em]"
        value={form.code}
        onChange={onChange}
        disabled={locked}
      />
      <TextField
        label="Mật khẩu mới (ít nhất 8 ký tự) *"
        name="password"
        type="password"
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
        value={form.password}
        onChange={onChange}
        disabled={locked}
      />
      <TextField
        label="Nhập lại mật khẩu mới *"
        name="confirm"
        type="password"
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
        value={form.confirm}
        onChange={onChange}
        disabled={locked}
      />
      <p className="text-[11px] text-stone-500">Sau khi đổi, mọi thiết bị đang đăng nhập sẽ bị đăng xuất.</p>
      <button type="submit" disabled={locked} className={primaryButtonClass}>
        {busy && <Spinner />}
        {busy ? 'Đang lưu...' : 'Lưu mật khẩu mới'}
      </button>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={resend}
          disabled={locked || cooldown > 0}
          className="rounded-xl border border-leaf-200 py-2 text-xs font-bold text-leaf-800 transition hover:bg-leaf-50 disabled:opacity-60"
        >
          {resending ? 'Đang gửi...' : cooldown > 0 ? `Gửi lại mã sau ${cooldown} giây` : 'Gửi lại mã'}
        </button>
        <button
          type="button"
          onClick={onChangeEmail}
          disabled={locked}
          className="rounded-xl border border-stone-200 py-2 text-xs font-bold text-stone-600 transition hover:bg-stone-50 disabled:opacity-60"
        >
          Đổi email
        </button>
      </div>
      <BackButton onClick={onBack} label="← Quay lại đăng nhập" />
    </form>
  );
}

function DevConsoleNote({ show }) {
  if (!show) return null;
  return (
    <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
      Chế độ phát triển: email được ghi vào log máy chủ, không gửi thật.
    </p>
  );
}

function ResetPasswordView({ token, onSuccess, onMfaRequired, onRequestNew }) {
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalidLink, setInvalidLink] = useState(!token);

  const onChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirm) {
      setError('Hai mật khẩu chưa khớp nhau.');
      return;
    }
    setBusy(true);
    try {
      const { user, mfaRequired } = await api.resetPassword(token, form.password);
      if (mfaRequired) onMfaRequired();
      else onSuccess(user);
    } catch (err) {
      if (err.code === 'reset_token_invalid') setInvalidLink(true);
      setError(err.message || 'Không đặt lại được mật khẩu.');
    } finally {
      setBusy(false);
    }
  };

  if (invalidLink) {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error || 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.'}
        </p>
        <button type="button" onClick={onRequestNew} className={primaryButtonClass}>
          Yêu cầu liên kết mới
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-stone-600">
        Đặt mật khẩu mới cho tài khoản. Sau khi đổi, mọi thiết bị đang đăng nhập sẽ bị đăng xuất.
      </p>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <TextField
        label="Mật khẩu mới (ít nhất 8 ký tự) *"
        name="password"
        type="password"
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
        value={form.password}
        onChange={onChange}
        disabled={busy}
      />
      <TextField
        label="Nhập lại mật khẩu mới *"
        name="confirm"
        type="password"
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
        value={form.confirm}
        onChange={onChange}
        disabled={busy}
      />
      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {busy && <Spinner />}
        {busy ? 'Đang lưu...' : 'Lưu mật khẩu mới'}
      </button>
    </form>
  );
}

function CompleteSignupView({ onSuccess, onCancel }) {
  const [pending, setPending] = useState(null);
  const [expired, setExpired] = useState('');
  const [form, setForm] = useState({ name: '', studentId: '', claimCode: '' });
  const [needClaimCode, setNeedClaimCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .pendingSignup()
      .then((p) => {
        if (cancelled) return;
        setPending(p);
        setForm((f) => ({ ...f, name: p.name || '' }));
      })
      .catch((err) => {
        if (!cancelled) setExpired(err.message || 'Phiên đăng ký đã hết hạn.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const body = { name: form.name, studentId: form.studentId };
      if (needClaimCode) body.claimCode = form.claimCode;
      const { user, claimed } = await api.completeSignup(body);
      onSuccess(user, claimed ? 'Đã nhận lại tài khoản cũ' : 'Tạo tài khoản thành công');
    } catch (err) {
      if (err.code === 'legacy_claim_required') {
        setNeedClaimCode(true);
        setInfo(err.message);
      } else if (err.code === 'signup_expired') {
        setExpired(err.message);
      } else {
        setError(err.message || 'Không thể tạo tài khoản.');
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await api.cancelSignup();
    } catch {
      // phiên tạm sẽ tự hết hạn phía server
    }
    onCancel();
  };

  if (expired) {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {expired}
        </p>
        <BackButton onClick={onCancel} label="Chọn phương thức đăng nhập" />
      </div>
    );
  }
  if (!pending) return <p className="text-sm text-stone-500">Đang tải...</p>;

  const providerName = PROVIDER_LABELS[pending.provider] || pending.provider;

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="rounded-xl bg-leaf-50 px-3 py-2 text-xs font-semibold text-leaf-800">
        Đã xác minh tài khoản {providerName}
        {pending.email ? ` (${pending.email})` : ''}. Nhập họ tên và mã sinh viên để tạo tài khoản GreenCanteen.
      </p>
      {info && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">{info}</p>}
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <StudentFields form={form} onChange={onChange} disabled={busy} />
      {needClaimCode && <ClaimCodeField value={form.claimCode} onChange={onChange} disabled={busy} />}
      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {busy && <Spinner />}
        {busy ? 'Đang tạo tài khoản...' : 'Tạo tài khoản'}
      </button>
      <button type="button" onClick={cancel} disabled={busy} className="w-full text-sm font-semibold text-stone-500">
        Hủy
      </button>
    </form>
  );
}

function StudentFields({ form, onChange, disabled }) {
  return (
    <>
      <TextField
        label="Họ và tên *"
        name="name"
        required
        minLength={2}
        maxLength={80}
        autoComplete="name"
        value={form.name}
        onChange={onChange}
        disabled={disabled}
      />
      <TextField
        label="Mã sinh viên *"
        name="studentId"
        required
        maxLength={40}
        autoComplete="off"
        value={form.studentId}
        onChange={onChange}
        disabled={disabled}
      />
    </>
  );
}

function ClaimCodeField({ value, onChange, disabled }) {
  return (
    <div className="space-y-1">
      <TextField
        label="Mã kích hoạt tài khoản cũ *"
        name="claimCode"
        required
        autoComplete="off"
        className="font-mono uppercase"
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
      <p className="text-[11px] text-stone-500">
        Liên hệ quản trị viên GreenCanteen (mang theo thẻ sinh viên) để nhận mã. Mỗi mã chỉ dùng một lần.
      </p>
    </div>
  );
}

function TextField({ label, className = '', ...props }) {
  return <input aria-label={label} placeholder={label} className={`${inputClass} ${className}`} {...props} />;
}

function MethodButton({ icon, label, status, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-left text-sm font-bold text-stone-800 shadow-sm transition hover:border-leaf-300 hover:bg-leaf-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-stone-200 disabled:hover:bg-white"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex-1">{label}</span>
      {status && (
        <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold text-stone-500">{status}</span>
      )}
    </button>
  );
}

function BackButton({ onClick, label = '← Chọn phương thức khác' }) {
  return (
    <button type="button" onClick={onClick} className="w-full text-sm font-semibold text-stone-500">
      {label}
    </button>
  );
}

function Spinner() {
  return <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#1877F2" />
      <path
        fill="#fff"
        d="M15.1 15.5l.5-3.5h-3.3V9.8c0-1 .5-1.9 2-1.9h1.5V4.9s-1.4-.2-2.7-.2c-2.7 0-4.5 1.7-4.5 4.7V12H5.6v3.5h3v8.4a12 12 0 0 0 3.7 0v-8.4h2.8z"
      />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-leaf-700" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2 20 3M16 7l3 3M13 10l2 2" />
    </svg>
  );
}

function QrIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-leaf-700" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM18 18h3v3h-3z" />
    </svg>
  );
}
