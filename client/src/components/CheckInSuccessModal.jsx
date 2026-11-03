import { useEffect, useState } from 'react';
import Modal from './Modal';
import { StoryBody, StoryHeader } from './StoryContent';
import { api } from '../lib/api';
import { trackClick, trackImpression } from '../lib/analytics';

const SOURCE_LINK = 'story_source_link';

export default function CheckInSuccessModal({
  open,
  onClose,
  story,
  classification,
  pointsEarned,
  gachaSpinGranted,
  onGachaComplete,
}) {
  const [phase, setPhase] = useState('story');
  const [prize, setPrize] = useState(null);
  const [spinError, setSpinError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setPhase('story');
      setPrize(null);
      setSpinError('');
      setCopied(false);
      if (story?.source?.url) trackImpression(SOURCE_LINK);
    }
  }, [open, story?.slug, story?.source?.url]);

  const runGacha = async () => {
    setSpinError('');
    setPhase('spinning');
    try {
      await new Promise((r) => setTimeout(r, 1800));
      const result = await api.gachaSpin();
      setPrize(result.prize);
      onGachaComplete?.({ pendingGachaSpins: result.pendingGachaSpins });
      setPhase('prize');
    } catch (err) {
      setSpinError(err.message || 'Không quay được Gacha');
      setPhase('story');
    }
  };

  const copyCode = async () => {
    if (!prize?.topUpCode) return;
    try {
      await navigator.clipboard.writeText(prize.topUpCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (!open) return null;

  // Đang quay thì không cho đóng (kết quả vẫn được lưu ở server và hiện trong trang Cá nhân)
  const close = () => {
    if (phase !== 'spinning') onClose();
  };

  return (
    <Modal title={phase === 'prize' ? 'Phần thưởng Gacha' : 'Check-in thành công'} onClose={close}>
      {phase === 'story' && (
        <>
          <div className="border-b border-amber-100 bg-gradient-to-r from-amber-50 via-yellow-50 to-leaf-50 px-4 py-3">
            <p className="text-center text-sm font-extrabold text-stone-800">
              🎁 Bạn đã nhận {gachaSpinGranted || 1} lượt quay Gacha!
            </p>
            <p className="text-center text-[11px] font-semibold text-stone-500">Giải thưởng duy nhất: mã nạp điện thoại</p>
          </div>

          {story && <StoryHeader story={story} />}

          <div className="space-y-3 p-5">
            <div className="flex items-center justify-between rounded-xl bg-leaf-50 px-3 py-2">
              <span className="text-sm font-bold text-leaf-800">+{pointsEarned} Eco-points</span>
              <span className="text-2xl">🌿</span>
            </div>
            {classification && <ClassificationLine classification={classification} />}
            {story && <StoryBody story={story} onSourceClick={() => trackClick(SOURCE_LINK)} />}
            {spinError && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                {spinError}
              </p>
            )}
            <button
              type="button"
              onClick={runGacha}
              className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 py-3.5 text-sm font-extrabold text-white shadow-md"
            >
              Quay Gacha — Nhận mã nạp điện thoại
            </button>
            <button type="button" onClick={close} className="w-full text-sm font-semibold text-stone-500">
              Quay sau (lượt vẫn được lưu)
            </button>
          </div>
        </>
      )}

      {phase === 'spinning' && (
        <div role="status" className="space-y-6 px-6 py-12 text-center">
          <p className="text-sm font-extrabold text-leaf-800">Đang quay Gacha...</p>
          <div className="relative mx-auto h-36 w-36">
            <div className="absolute inset-0 animate-spin rounded-full border-4 border-dashed border-leaf-300 border-t-amber-500" />
            <div className="absolute inset-4 flex items-center justify-center rounded-full bg-gradient-to-br from-leaf-100 to-amber-100 text-4xl">
              📱
            </div>
          </div>
          <p className="text-xs font-semibold text-stone-500">100% trúng mã nạp điện thoại</p>
        </div>
      )}

      {phase === 'prize' && prize && (
        <div className="space-y-4 p-6">
          <div className="text-center">
            <p className="text-4xl">🎉</p>
            <h3 className="mt-2 text-xl font-extrabold text-leaf-800">Chúc mừng!</h3>
            <p className="text-sm font-semibold text-stone-600">{prize.label}</p>
          </div>
          <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-4 text-center">
            <p className="text-xs font-bold uppercase text-amber-800">{prize.carrier}</p>
            <p className="text-2xl font-extrabold text-stone-900">{prize.amountVnd.toLocaleString('vi-VN')}đ</p>
            <p className="mt-2 break-all rounded-xl bg-white px-3 py-2 font-mono text-sm font-bold text-leaf-800">
              {prize.topUpCode}
            </p>
            <button
              type="button"
              onClick={copyCode}
              className="mt-3 w-full rounded-xl bg-leaf-600 py-2.5 text-sm font-bold text-white"
            >
              {copied ? 'Đã sao chép!' : 'Sao chép mã'}
            </button>
          </div>
          <p className="text-center text-[11px] text-stone-400">
            Mã demo cho môi trường thử nghiệm — tích hợp đối tác nạp thật ở bản production.
          </p>
          <button
            type="button"
            onClick={close}
            className="w-full rounded-xl border border-leaf-200 py-3 text-sm font-bold text-leaf-800"
          >
            Hoàn tất
          </button>
        </div>
      )}
    </Modal>
  );
}

function ClassificationLine({ classification }) {
  const percent = typeof classification.confidence === 'number' ? `${Math.round(classification.confidence * 100)}%` : '';
  return (
    <p className="text-xs text-stone-500">
      {classification.simulated ? (
        <span className="mr-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
          MÔ PHỎNG — không phải AI
        </span>
      ) : (
        <span className="font-bold text-stone-600">AI nhận diện: </span>
      )}
      {classification.categoryLabel}
      {percent && ` · độ tin cậy ${percent}`}
    </p>
  );
}
