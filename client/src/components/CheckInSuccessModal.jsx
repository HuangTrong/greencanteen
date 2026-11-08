import { useEffect, useState } from 'react';
import Modal from './Modal';
import GachaResult, { RULES_URL } from './GachaResult';
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
  const [result, setResult] = useState(null);
  const [spinError, setSpinError] = useState('');

  useEffect(() => {
    if (open) {
      setPhase('story');
      setResult(null);
      setSpinError('');
      if (story?.source?.url) trackImpression(SOURCE_LINK);
    }
  }, [open, story?.slug, story?.source?.url]);

  const runDraw = async () => {
    setSpinError('');
    setPhase('spinning');
    try {
      // Hiệu ứng chờ chỉ để trang trí: kết quả do máy chủ rút, không phụ thuộc thời điểm bấm
      await new Promise((r) => setTimeout(r, 1800));
      const next = await api.gachaDraw();
      setResult(next);
      onGachaComplete?.({ pendingGachaSpins: next.pendingGachaSpins });
      setPhase('result');
    } catch (err) {
      setSpinError(err.message || 'Không quay được.');
      setPhase(result ? 'result' : 'story');
    }
  };

  if (!open) return null;

  // Đang quay thì không cho đóng (kết quả vẫn được lưu ở server và hiện trong trang Cá nhân)
  const close = () => {
    if (phase !== 'spinning') onClose();
  };

  const errorLine = spinError && (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
      {spinError}
    </p>
  );

  return (
    <Modal title={phase === 'result' ? 'Kết quả quay thưởng' : 'Check-in thành công'} onClose={close}>
      {phase === 'story' && (
        <>
          <div className="border-b border-amber-100 bg-gradient-to-r from-amber-50 via-yellow-50 to-leaf-50 px-4 py-3">
            <p className="text-center text-sm font-extrabold text-stone-800">
              🎁 Bạn nhận được {gachaSpinGranted || 1} lượt quay thưởng tri ân!
            </p>
            <p className="text-center text-[11px] font-semibold text-stone-500">
              Quà là móc khóa GreenCanteen phiên bản đặc biệt. Trúng hay không hoàn toàn do may mắn.{' '}
              <a href={RULES_URL} target="_blank" rel="noopener" className="underline underline-offset-2">
                Thể lệ
              </a>
            </p>
          </div>

          {story && <StoryHeader story={story} />}

          <div className="space-y-3 p-5">
            <div className="flex items-center justify-between rounded-xl bg-leaf-50 px-3 py-2">
              <span className="text-sm font-bold text-leaf-800">+{pointsEarned} Eco-points</span>
              <span className="text-2xl">🌿</span>
            </div>
            {classification && <ClassificationLine classification={classification} />}
            {story && <StoryBody story={story} onSourceClick={() => trackClick(SOURCE_LINK)} />}
            {errorLine}
            <button
              type="button"
              onClick={runDraw}
              className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 py-3.5 text-sm font-extrabold text-white shadow-md"
            >
              Quay thưởng tri ân
            </button>
            <button type="button" onClick={close} className="w-full text-sm font-semibold text-stone-500">
              Quay sau (lượt vẫn được lưu)
            </button>
          </div>
        </>
      )}

      {phase === 'spinning' && (
        <div role="status" className="space-y-6 px-6 py-12 text-center">
          <p className="text-sm font-extrabold text-leaf-800">Đang quay thưởng...</p>
          <div className="relative mx-auto h-36 w-36">
            <div className="absolute inset-0 rounded-full border-4 border-dashed border-leaf-300 border-t-amber-500 motion-safe:animate-spin" />
            <div className="absolute inset-4 flex items-center justify-center rounded-full bg-gradient-to-br from-leaf-100 to-amber-100 text-4xl">
              🎁
            </div>
          </div>
          <p className="text-xs font-semibold text-stone-500">Máy chủ rút thăm ngẫu nhiên theo thể lệ.</p>
        </div>
      )}

      {phase === 'result' && result && (
        <div className="space-y-4 p-6">
          <GachaResult result={result} />
          {errorLine}
          {result.pendingGachaSpins > 0 && (
            <button
              type="button"
              onClick={runDraw}
              className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 py-3 text-sm font-extrabold text-white shadow-md"
            >
              Quay tiếp (còn {result.pendingGachaSpins} lượt)
            </button>
          )}
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
