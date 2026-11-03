import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { REAUTH_REQUIRED_MESSAGE } from '../lib/authMessages';
import { addPasskey, passkeyErrorMessage, passkeySupported } from '../lib/passkey';
import ReauthForm from './ReauthForm';

const inputClass =
  'w-full rounded-xl border border-stone-200 px-3 py-2.5 text-sm outline-none ring-leaf-400 focus:ring-2 disabled:bg-stone-50';
const panelClass = 'space-y-2 rounded-xl border border-leaf-50 bg-white p-3 shadow-sm';
const smallButton = 'shrink-0 rounded-lg border border-leaf-200 px-3 py-1 text-xs font-bold text-leaf-800 transition hover:bg-leaf-50 disabled:opacity-60';
const primaryButton = 'rounded-xl bg-leaf-600 py-2 text-sm font-bold text-white transition hover:bg-leaf-700 disabled:opacity-60';
const cancelButton = 'rounded-xl border border-stone-200 py-2 text-sm font-semibold text-stone-600';

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
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

/** 2FA và passkey. Mỗi thao tác đều thử gọi trước; phiên đã cũ thì máy chủ từ chối mới hỏi lại mật khẩu, tránh hỏi lại liên tục trong 10 phút */
export default function SecuritySection({ user }) {
  const hasPassword = Boolean(user.authMethods?.password);
  const [security, setSecurity] = useState(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(() => {
    setLoadError('');
    return api
      .accountSecurity()
      .then(setSecurity)
      .catch((err) => setLoadError(err.message || 'Không tải được cài đặt bảo mật.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-bold uppercase tracking-wide text-stone-500">Bảo vệ đăng nhập</h4>
      {loadError && (
        <div role="alert" className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          <span className="flex-1">{loadError}</span>
          <button type="button" onClick={load} className="shrink-0 font-bold underline">
            Thử lại
          </button>
        </div>
      )}
      {!security && !loadError && <p className="text-xs text-stone-500">Đang tải...</p>}
      {security && (
        <>
          <MfaPanel mfa={security.mfa} hasPassword={hasPassword} onChanged={load} />
          <PasskeyPanel passkeys={security.passkeys} hasPassword={hasPassword} onChanged={load} />
        </>
      )}
    </div>
  );
}

function RecoveryCodes({ codes, onDone }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-xs text-stone-600">
        Mỗi mã dùng được một lần khi không còn thiết bị xác thực. Các mã chỉ hiện một lần, hãy lưu ở nơi an toàn và không chia sẻ cho ai.
      </p>
      <ul aria-label="Mã khôi phục" className="grid grid-cols-1 gap-1 rounded-xl bg-stone-100 p-3 font-mono text-sm text-stone-800">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <label className="flex items-center gap-2 text-xs font-semibold text-stone-700">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        Tôi đã lưu các mã này
      </label>
      <button type="button" disabled={!saved} onClick={onDone} className={`w-full ${primaryButton}`}>
        Xong
      </button>
    </div>
  );
}

/** Tắt 2FA hay đổi mã khôi phục: mật khẩu và mã gửi cùng một yêu cầu để không phải chờ mã kế tiếp của ứng dụng xác thực */
function MfaProofForm({ hasPassword, submitLabel, onSubmit, onCancel }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSubmit({ password: hasPassword ? password : undefined, code: code.trim() });
    } catch (err) {
      setError(err.code === 'reauth_required' ? REAUTH_REQUIRED_MESSAGE : err.message || 'Không xử lý được yêu cầu.');
      setCode('');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      {hasPassword && (
        <input
          type="password"
          required
          maxLength={128}
          autoComplete="current-password"
          aria-label="Mật khẩu hiện tại"
          placeholder="Mật khẩu hiện tại"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className={inputClass}
        />
      )}
      <input
        required
        maxLength={40}
        autoComplete="one-time-code"
        aria-label="Mã xác thực"
        placeholder="Mã xác thực hoặc mã khôi phục"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={busy}
        className={inputClass}
      />
      <Feedback error={error} />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={cancelButton}>
          Hủy
        </button>
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Đang kiểm tra...' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function MfaSetupForm({ setup, onEnabled, onCancel }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { recoveryCodes } = await api.mfaEnable(code.trim());
      onEnabled(recoveryCodes);
    } catch (err) {
      setError(err.message || 'Mã chưa đúng.');
      setCode('');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <p className="text-xs text-stone-600">Quét mã này bằng ứng dụng xác thực (Google Authenticator, Microsoft Authenticator, Aegis...), rồi nhập mã 6 chữ số.</p>
      <img src={setup.qrImage} alt="Mã QR thiết lập ứng dụng xác thực" className="mx-auto h-52 w-52" />
      <div>
        <p className="text-[11px] font-semibold text-stone-500">Hoặc nhập khóa thủ công</p>
        <p data-testid="mfa-secret" className="break-all rounded-lg bg-stone-100 px-3 py-2 font-mono text-xs text-stone-800">
          {setup.secret}
        </p>
      </div>
      <input
        required
        autoFocus
        inputMode="numeric"
        maxLength={6}
        autoComplete="one-time-code"
        aria-label="Mã 6 chữ số"
        placeholder="Mã 6 chữ số"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={busy}
        className={inputClass}
      />
      <Feedback error={error} />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={cancelButton}>
          Hủy
        </button>
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Đang kiểm tra...' : 'Bật'}
        </button>
      </div>
    </form>
  );
}

function MfaPanel({ mfa, hasPassword, onChanged }) {
  const [view, setView] = useState('idle'); // idle | reauth | setup | disable | regenerate | codes
  const [setup, setSetup] = useState(null); // { secret, qrImage }
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const reset = () => {
    setView('idle');
    setSetup(null);
    setCodes(null);
    setError('');
  };

  const fetchSetup = async () => {
    const { secret, otpauthUri } = await api.mfaSetup();
    const qrImage = await QRCode.toDataURL(otpauthUri, { width: 220, margin: 1, errorCorrectionLevel: 'M' });
    setSetup({ secret, qrImage });
    setView('setup');
  };

  const startSetup = async () => {
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      await fetchSetup();
    } catch (err) {
      if (err.code === 'reauth_required' && hasPassword) setView('reauth');
      else setError(err.code === 'reauth_required' ? REAUTH_REQUIRED_MESSAGE : err.message || 'Không bắt đầu được thiết lập.');
    } finally {
      setBusy(false);
    }
  };

  const showCodes = async (recoveryCodes, notice) => {
    setCodes(recoveryCodes);
    setSetup(null);
    setView('codes');
    setSuccess(notice);
    await onChanged();
  };

  const disable = async (proof) => {
    await api.mfaDisable(proof);
    reset();
    setSuccess('Đã tắt xác thực hai lớp.');
    await onChanged();
  };

  const regenerate = async (proof) => {
    const { recoveryCodes } = await api.mfaRecoveryCodes(proof);
    await showCodes(recoveryCodes, 'Đã tạo mã khôi phục mới, các mã cũ không còn dùng được.');
  };

  const statusLabel = () => {
    if (mfa.enabled) return <span className="shrink-0 text-xs font-bold text-leaf-700">✓ Đã bật</span>;
    if (!mfa.available) {
      return <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold text-stone-500">Chưa cấu hình</span>;
    }
    return view === 'idle' ? (
      <button type="button" onClick={startSetup} disabled={busy} className={smallButton}>
        {busy ? 'Đang mở...' : 'Bật'}
      </button>
    ) : null;
  };

  return (
    <div className={panelClass}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-stone-700">Xác thực hai lớp</span>
        {statusLabel()}
      </div>
      {view === 'idle' && (
        <p className="text-xs text-stone-500">
          {mfa.enabled
            ? `Khi đăng nhập cần thêm mã từ ứng dụng xác thực. Còn ${mfa.recoveryCodesLeft} mã khôi phục.`
            : 'Có thêm một lớp bảo vệ: lộ mật khẩu cũng chưa vào được tài khoản.'}
        </p>
      )}
      <Feedback error={error} success={view === 'idle' ? success : ''} />
      {mfa.enabled && view === 'idle' && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setView('regenerate')} className={smallButton}>
            Tạo mã khôi phục mới
          </button>
          <button type="button" onClick={() => setView('disable')} className={smallButton}>
            Tắt
          </button>
        </div>
      )}
      {view === 'reauth' && <ReauthForm onConfirmed={fetchSetup} onCancel={reset} />}
      {view === 'setup' && setup && (
        <MfaSetupForm setup={setup} onEnabled={(recoveryCodes) => showCodes(recoveryCodes, 'Đã bật xác thực hai lớp và đăng xuất các thiết bị khác.')} onCancel={reset} />
      )}
      {view === 'disable' && <MfaProofForm hasPassword={hasPassword} submitLabel="Tắt" onSubmit={disable} onCancel={reset} />}
      {view === 'regenerate' && <MfaProofForm hasPassword={hasPassword} submitLabel="Tạo mã mới" onSubmit={regenerate} onCancel={reset} />}
      {view === 'codes' && codes && <RecoveryCodes codes={codes} onDone={reset} />}
    </div>
  );
}

function PasskeyPanel({ passkeys, hasPassword, onChanged }) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(null); // thao tác chờ xác thực lại
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const add = async () => {
    await addPasskey(name);
    setName('');
    setSuccess('Đã thêm passkey.');
    await onChanged();
  };

  const remove = async ({ id, name: label }) => {
    await api.passkeyRemove(id);
    setSuccess(`Đã xóa passkey ${label}.`);
    await onChanged();
  };

  const run = async (action) => {
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      await action();
    } catch (err) {
      if (err.code === 'reauth_required' && hasPassword) setPending(() => action);
      else setError(err.code === 'reauth_required' ? REAUTH_REQUIRED_MESSAGE : passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={panelClass}>
      <span className="text-sm font-semibold text-stone-700">Passkey</span>
      <p className="text-xs text-stone-500">
        Đăng nhập bằng vân tay, khuôn mặt hoặc mã PIN của thiết bị, không cần mật khẩu. Passkey chỉ dùng được trên đúng trang này nên trang giả mạo không lấy được.
      </p>
      {passkeys.length > 0 && (
        <ul aria-label="Passkey đã thêm" className="divide-y divide-leaf-50">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-stone-700">{passkey.name}</span>
                <span className="block text-[11px] text-stone-500">
                  Thêm ngày {formatDate(passkey.createdAt)}
                  {passkey.lastUsedAt && ` · Dùng gần nhất ${formatDate(passkey.lastUsedAt)}`}
                  {passkey.backedUp && ' · Đồng bộ qua tài khoản thiết bị'}
                </span>
              </span>
              <button type="button" aria-label={`Xóa passkey ${passkey.name}`} disabled={busy} onClick={() => run(() => remove(passkey))} className={smallButton}>
                Xóa
              </button>
            </li>
          ))}
        </ul>
      )}
      {pending ? (
        <ReauthForm
          onConfirmed={() => {
            setPending(null);
            return run(pending);
          }}
          onCancel={() => setPending(null)}
        />
      ) : passkeySupported() ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(add);
          }}
          className="flex gap-2"
        >
          <input
            maxLength={60}
            aria-label="Tên passkey"
            placeholder="Tên thiết bị (không bắt buộc)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className={`min-w-0 ${inputClass}`}
          />
          <button type="submit" disabled={busy} className={smallButton}>
            {busy ? 'Đang chờ...' : 'Thêm passkey'}
          </button>
        </form>
      ) : (
        <p className="text-xs text-stone-500">Trình duyệt này chưa hỗ trợ passkey.</p>
      )}
      <Feedback error={error} success={success} />
    </div>
  );
}
