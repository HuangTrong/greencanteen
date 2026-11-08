import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import GachaResult, { CopyCodeButton, KeychainImage, RULES_URL } from './GachaResult';

const formatDate = (iso) => new Date(iso).toLocaleDateString('vi-VN');

function KeychainReward({ reward }) {
  const delivered = reward.deliveryStatus === 'delivered';
  return (
    <li className="rounded-xl border border-leaf-50 bg-white p-3 text-xs shadow-sm">
      <div className="flex gap-3">
        <KeychainImage url={reward.imageUrl} label={reward.label} className="h-16 w-16 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-1">
            <p className="font-bold text-stone-800">{reward.label}</p>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${delivered ? 'bg-leaf-100 text-leaf-800' : 'bg-amber-100 text-amber-900'}`}>
              {delivered ? `Đã nhận ${reward.deliveredAt ? formatDate(reward.deliveredAt) : ''}`.trim() : 'Chờ nhận'}
            </span>
          </div>
          <p className="text-stone-400">Trúng ngày {formatDate(reward.createdAt)}</p>
          <p className="mt-1 break-all font-mono text-sm font-bold text-leaf-800">{reward.claimCode}</p>
        </div>
      </div>
      {!delivered && (
        <>
          <CopyCodeButton code={reward.claimCode} className="mt-2 w-full py-2 text-xs" />
          {reward.claimInstructions && <p className="mt-2 whitespace-pre-line break-words text-stone-600">{reward.claimInstructions}</p>}
        </>
      )}
    </li>
  );
}

// Tài khoản lấy từ phiên đăng nhập ở server — component không gửi mã sinh viên
export default function ProfileGachaSection({ pendingSpins, onSpinsChange }) {
  const [data, setData] = useState({ rewards: [], stats: { spins: 0, wins: 0 } });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState('');
  const onSpinsChangeRef = useRef(onSpinsChange);
  onSpinsChangeRef.current = onSpinsChange;

  const load = useCallback(() => {
    setLoading(true);
    setLoadError('');
    api
      .gachaResults()
      .then((r) => {
        setData({ rewards: r.rewards || [], stats: r.stats || { spins: 0, wins: 0 } });
        onSpinsChangeRef.current?.(r.pendingGachaSpins ?? 0);
      })
      .catch((err) => setLoadError(err.message || 'Không tải được kết quả quay thưởng.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const spin = async () => {
    if (spinning) return;
    setError('');
    setLastResult(null);
    setSpinning(true);
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const result = await api.gachaDraw();
      setLastResult(result);
      onSpinsChangeRef.current?.(result.pendingGachaSpins);
      load();
    } catch (err) {
      setError(err.message || 'Quay thất bại.');
      // Số lượt trên server là chuẩn — đồng bộ lại (vd. lượt đã dùng ở tab khác)
      load();
    } finally {
      setSpinning(false);
    }
  };

  const keychains = data.rewards.filter((r) => r.type === 'keychain');
  const legacyCodes = data.rewards.filter((r) => r.type !== 'keychain');

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-extrabold text-leaf-800">Quay thưởng tri ân</h3>
      <div className="rounded-2xl border border-amber-100 bg-gradient-to-br from-amber-50 to-white p-4">
        <p className="text-sm font-bold text-stone-800">
          Lượt quay đang có: <span className="text-amber-700">{pendingSpins ?? 0}</span>
        </p>
        <p className="mt-1 text-xs text-stone-500">
          Mỗi check-in hợp lệ +1 lượt. Quà là móc khóa GreenCanteen phiên bản đặc biệt; trúng hay không hoàn toàn do may mắn. Không thu
          phí, không bán lượt quay.{' '}
          <a href={RULES_URL} className="font-bold text-leaf-700 underline underline-offset-2">
            Thể lệ quay thưởng
          </a>
        </p>
        {error && (
          <p role="alert" className="mt-2 text-xs font-semibold text-red-600">
            {error}
          </p>
        )}
        <div aria-live="polite">
          {lastResult && (
            <div className="mt-3 rounded-xl bg-white p-4 shadow-sm">
              <GachaResult result={lastResult} />
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={spinning || (pendingSpins ?? 0) < 1}
          onClick={spin}
          className="mt-3 w-full rounded-xl bg-amber-500 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
        >
          {spinning ? 'Đang quay...' : 'Quay thưởng'}
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-stone-500">Đang tải kết quả quay thưởng...</p>
      ) : loadError ? (
        <p role="alert" className="text-xs font-semibold text-red-600">
          {loadError}{' '}
          <button type="button" onClick={load} className="font-bold underline">
            Thử lại
          </button>
        </p>
      ) : (
        <>
          <p className="text-xs text-stone-500">
            Đã quay {data.stats.spins} lượt · trúng {data.stats.wins} móc khóa
          </p>
          {keychains.length === 0 ? (
            <p className="text-xs text-stone-500">Chưa trúng móc khóa nào.</p>
          ) : (
            <ul aria-label="Móc khóa đã trúng" className="space-y-2">
              {keychains.map((reward) => (
                <KeychainReward key={reward.id} reward={reward} />
              ))}
            </ul>
          )}
          {legacyCodes.length > 0 && (
            <details className="rounded-xl bg-stone-50 px-3 py-2 text-xs text-stone-600">
              <summary className="cursor-pointer font-bold">Mã nạp demo cũ ({legacyCodes.length})</summary>
              <p className="mt-1">Mã do GreenCanteen tự tạo trước khi đổi sang móc khóa: không phải mã của nhà mạng, không có giá trị sử dụng.</p>
              <ul className="mt-1 space-y-1">
                {legacyCodes.map((r) => (
                  <li key={r.id} className="font-mono">
                    {r.topUpCode} · {formatDate(r.createdAt)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
