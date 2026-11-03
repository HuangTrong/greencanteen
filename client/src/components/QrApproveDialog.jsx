import { useEffect, useState } from 'react';
import Modal from './Modal';
import { api } from '../lib/api';
import { useUser } from '../context/UserContext';

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

/** Trên thiết bị ĐÃ đăng nhập (mở từ link trong QR): xác nhận hoặc từ chối cho thiết bị kia đăng nhập */
export default function QrApproveDialog({ challengeId, onClose }) {
  const { user } = useUser();
  const [phase, setPhase] = useState('loading'); // loading | ready | approving | rejecting | approved | rejected | error
  const [info, setInfo] = useState(null);
  const [matchCode, setMatchCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .qrChallenge(challengeId)
      .then((r) => {
        if (cancelled) return;
        setInfo(r);
        setPhase('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Mã QR không hợp lệ.');
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [challengeId]);

  const decide = async (approve) => {
    setError('');
    setPhase(approve ? 'approving' : 'rejecting');
    try {
      await (approve ? api.qrApprove(challengeId, matchCode) : api.qrReject(challengeId));
      setPhase(approve ? 'approved' : 'rejected');
    } catch (err) {
      setError(err.message || 'Không xử lý được yêu cầu.');
      setPhase(err.code === 'qr_match_invalid' ? 'ready' : 'error');
    }
  };

  const busy = phase === 'approving' || phase === 'rejecting';
  const done = phase === 'approved' || phase === 'rejected' || phase === 'error';

  return (
    <Modal title="Xác nhận đăng nhập bằng mã QR" onClose={onClose}>
      <div className="space-y-4 p-5">
        {phase === 'loading' && <p className="text-sm text-stone-500">Đang kiểm tra mã QR...</p>}

        {(phase === 'ready' || busy) && info && (
          <>
            <p className="text-sm text-stone-700">Một thiết bị đang yêu cầu đăng nhập vào tài khoản của bạn:</p>
            <dl className="space-y-1 rounded-xl bg-leaf-50 px-4 py-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Thiết bị</dt>
                <dd className="text-right font-bold text-stone-800">{info.device}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Tạo lúc</dt>
                <dd className="font-bold text-stone-800">{formatTime(info.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Tài khoản</dt>
                <dd className="text-right font-bold text-stone-800">
                  {user?.name} ({user?.studentId})
                </dd>
              </div>
            </dl>
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              Chỉ xác nhận nếu chính bạn vừa mở mã QR này trên thiết bị kia. Nếu ai đó gửi mã QR cho bạn, hãy bấm Từ chối.
              Không nhập mã do người khác đọc hoặc gửi cho bạn.
            </p>
            <label className="block text-sm font-semibold text-stone-700">
              Mã đối chiếu trên thiết bị kia
              <input
                value={matchCode}
                onChange={(e) => setMatchCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                inputMode="numeric"
                autoComplete="off"
                disabled={busy}
                className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2.5 text-center font-mono text-lg tracking-widest outline-none ring-leaf-400 focus:ring-2"
              />
            </label>
            {error && (
              <p role="alert" className="rounded-xl bg-red-50 px-3 py-3 text-sm font-semibold text-red-700">
                {error}
              </p>
            )}
            <button
              type="button"
              disabled={busy || matchCode.length !== 4}
              onClick={() => decide(true)}
              className="w-full rounded-xl bg-leaf-600 py-3 text-sm font-bold text-white shadow-md transition hover:bg-leaf-700 disabled:opacity-60"
            >
              {phase === 'approving' ? 'Đang xác nhận...' : 'Xác nhận đăng nhập'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => decide(false)}
              className="w-full rounded-xl border border-stone-200 py-2.5 text-sm font-semibold text-stone-600 disabled:opacity-60"
            >
              {phase === 'rejecting' ? 'Đang từ chối...' : 'Từ chối'}
            </button>
          </>
        )}

        {phase === 'approved' && (
          <p role="status" className="rounded-xl bg-leaf-100 px-3 py-3 text-sm font-bold text-leaf-900">
            ✓ Đã xác nhận. Thiết bị kia sẽ đăng nhập trong giây lát.
          </p>
        )}
        {phase === 'rejected' && (
          <p role="status" className="rounded-xl bg-stone-100 px-3 py-3 text-sm font-bold text-stone-700">
            Đã từ chối yêu cầu đăng nhập.
          </p>
        )}
        {phase === 'error' && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-3 text-sm font-semibold text-red-700">
            {error}
          </p>
        )}
        {done && (
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl border border-leaf-200 py-2.5 text-sm font-bold text-leaf-800"
          >
            Đóng
          </button>
        )}
      </div>
    </Modal>
  );
}
