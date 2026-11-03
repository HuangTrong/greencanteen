import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';

/**
 * QR đăng nhập trên thiết bị CHƯA đăng nhập. QR chỉ chứa đường dẫn kèm mã thử thách
 * (dùng một lần, hết hạn sau 2 phút); điện thoại đã đăng nhập quét và xác nhận, còn trang này
 * nhận phiên bằng pollToken chỉ nằm trong bộ nhớ — không có mật khẩu hay token nào trong QR.
 */
export default function QrLoginPanel({ onSuccess }) {
  const [phase, setPhase] = useState('loading'); // loading | pending | approved | expired | rejected | error
  const [qrImage, setQrImage] = useState('');
  const [matchCode, setMatchCode] = useState('');
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  useEffect(() => {
    let cancelled = false;
    let timer;
    setPhase('loading');
    setError('');

    const poll = async (pollToken, intervalMs, deadline) => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setPhase('expired');
        return;
      }
      try {
        const r = await api.qrPoll(pollToken);
        if (cancelled) return;
        if (r.status === 'approved' && r.user) {
          setPhase('approved');
          onSuccessRef.current(r.user);
          return;
        }
        if (r.status !== 'pending') {
          setPhase(r.status === 'rejected' ? 'rejected' : 'expired');
          return;
        }
      } catch {
        if (cancelled) return;
        // lỗi mạng tạm thời → thử lại ở lượt sau
      }
      timer = setTimeout(() => poll(pollToken, intervalMs, deadline), intervalMs);
    };

    (async () => {
      try {
        const r = await api.qrStart();
        const url = `${window.location.origin}/profile?qr=${encodeURIComponent(r.challengeId)}`;
        const image = await QRCode.toDataURL(url, { width: 240, margin: 1, errorCorrectionLevel: 'M' });
        if (cancelled) return;
        // Tính hạn theo đồng hồ máy này (expiresInMs) để không lệch nếu giờ máy khác giờ server
        const expiry = Date.now() + (r.expiresInMs || 120000);
        const interval = r.pollIntervalMs || 2000;
        setQrImage(image);
        setMatchCode(r.matchCode || '');
        setExpiresAt(expiry);
        setNow(Date.now());
        setPhase('pending');
        timer = setTimeout(() => poll(r.pollToken, interval, expiry + 5000), interval);
      } catch (err) {
        if (!cancelled) {
          setPhase('error');
          setError(err.message || 'Không tạo được mã QR.');
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt]);

  useEffect(() => {
    if (phase !== 'pending') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const active = phase === 'pending' || phase === 'approved';

  return (
    <div className="space-y-3 text-center">
      <div className="mx-auto flex h-60 w-60 items-center justify-center rounded-2xl border border-leaf-100 bg-white p-2 shadow-sm">
        {qrImage ? (
          <img
            src={qrImage}
            alt="Mã QR đăng nhập GreenCanteen"
            className={`h-full w-full transition ${active ? '' : 'opacity-20 blur-[2px]'}`}
          />
        ) : (
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-leaf-600 border-t-transparent" />
        )}
      </div>

      {active && matchCode && (
        <div>
          <p className="text-xs font-semibold text-stone-500">Mã đối chiếu</p>
          <p className="font-mono text-2xl font-extrabold tracking-widest text-leaf-800">{matchCode}</p>
        </div>
      )}

      <div role="status" aria-live="polite" className="min-h-[1.25rem] text-sm font-bold">
        {phase === 'loading' && <p className="text-stone-500">Đang tạo mã QR...</p>}
        {phase === 'pending' && (
          <p className="text-leaf-800">
            {secondsLeft > 0 ? `Đang chờ xác nhận · hết hạn sau ${countdown}` : 'Đang kiểm tra...'}
          </p>
        )}
        {phase === 'approved' && <p className="text-leaf-800">Đã xác nhận — đang đăng nhập...</p>}
        {phase === 'expired' && <p className="text-amber-700">Mã QR đã hết hạn.</p>}
        {phase === 'rejected' && <p className="text-red-700">Yêu cầu đăng nhập đã bị từ chối trên thiết bị kia.</p>}
        {phase === 'error' && <p className="text-red-700">{error}</p>}
      </div>

      {(phase === 'expired' || phase === 'rejected' || phase === 'error') && (
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="w-full rounded-xl bg-leaf-600 py-2.5 text-sm font-bold text-white shadow-md transition hover:bg-leaf-700"
        >
          Tạo mã mới
        </button>
      )}

      <ol className="space-y-1 rounded-xl bg-leaf-50 px-4 py-3 text-left text-xs text-stone-600">
        <li>1. Mở GreenCanteen trên điện thoại đã đăng nhập.</li>
        <li>2. Quét mã này bằng camera điện thoại.</li>
        <li>3. Kiểm tra thông tin thiết bị, nhập mã đối chiếu rồi bấm «Xác nhận đăng nhập».</li>
      </ol>
      <p className="text-[11px] text-stone-400">
        Mã chỉ dùng một lần, hết hạn sau 2 phút và không chứa mật khẩu. Không gửi mã QR hay mã đối chiếu cho người khác.
      </p>
    </div>
  );
}
