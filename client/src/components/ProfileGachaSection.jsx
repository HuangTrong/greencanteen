import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// Tài khoản lấy từ phiên đăng nhập ở server — component không gửi mã sinh viên
export default function ProfileGachaSection({ pendingSpins, onSpinsChange }) {
  const [rewards, setRewards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [lastPrize, setLastPrize] = useState(null);
  const [error, setError] = useState('');
  const onSpinsChangeRef = useRef(onSpinsChange);
  onSpinsChangeRef.current = onSpinsChange;

  const load = useCallback(() => {
    setLoading(true);
    setLoadError('');
    api
      .gachaRewards()
      .then((r) => {
        setRewards(r.rewards || []);
        onSpinsChangeRef.current?.(r.pendingGachaSpins ?? 0);
      })
      .catch((err) => setLoadError(err.message || 'Không tải được danh sách mã nạp.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const spin = async () => {
    if (spinning) return;
    setError('');
    setLastPrize(null);
    setSpinning(true);
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const result = await api.gachaSpin();
      setLastPrize(result.prize);
      onSpinsChangeRef.current?.(result.pendingGachaSpins);
      load();
    } catch (err) {
      setError(err.message || 'Quay thất bại');
      // Số lượt trên server là chuẩn — đồng bộ lại (vd. lượt đã dùng ở tab khác)
      load();
    } finally {
      setSpinning(false);
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-extrabold text-leaf-800">Gacha — Mã nạp điện thoại</h3>
      <div className="rounded-2xl border border-amber-100 bg-gradient-to-br from-amber-50 to-white p-4">
        <p className="text-sm font-bold text-stone-800">
          Lượt quay đang có: <span className="text-amber-700">{pendingSpins ?? 0}</span>
        </p>
        <p className="mt-1 text-xs text-stone-500">Mỗi check-in hợp lệ +1 lượt. Giải duy nhất: mã nạp điện thoại.</p>
        {error && <p className="mt-2 text-xs font-semibold text-red-600">{error}</p>}
        {lastPrize && (
          <div className="mt-3 rounded-xl bg-white p-3 text-center shadow-sm">
            <p className="text-xs font-bold text-amber-800">{lastPrize.carrier}</p>
            <p className="font-extrabold text-stone-900">{lastPrize.amountVnd.toLocaleString('vi-VN')}đ</p>
            <p className="mt-1 font-mono text-sm font-bold text-leaf-800">{lastPrize.topUpCode}</p>
          </div>
        )}
        <p className="mt-2 text-[11px] text-stone-400">Mã demo cho môi trường thử nghiệm, chưa đổi được tại nhà mạng.</p>
        <button
          type="button"
          disabled={spinning || (pendingSpins ?? 0) < 1}
          onClick={spin}
          className="mt-3 w-full rounded-xl bg-amber-500 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
        >
          {spinning ? 'Đang quay...' : 'Quay Gacha'}
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-stone-500">Đang tải phần thưởng...</p>
      ) : loadError ? (
        <p role="alert" className="text-xs font-semibold text-red-600">
          {loadError}{' '}
          <button type="button" onClick={load} className="font-bold underline">
            Thử lại
          </button>
        </p>
      ) : rewards.length === 0 ? (
        <p className="text-xs text-stone-500">Chưa có mã nạp nào.</p>
      ) : (
        <ul className="space-y-2">
          {rewards.map((r) => (
            <li key={r._id} className="rounded-xl border border-leaf-50 bg-white px-3 py-2 text-xs shadow-sm">
              <div className="flex justify-between font-bold text-stone-800">
                <span>
                  {r.amountVnd.toLocaleString('vi-VN')}đ · {r.carrier}
                </span>
                <span className="text-stone-400">{new Date(r.createdAt).toLocaleDateString('vi-VN')}</span>
              </div>
              <p className="font-mono text-leaf-800">{r.topUpCode}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
