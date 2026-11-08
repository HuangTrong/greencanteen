import { useEffect, useRef, useState } from 'react';
import { assetUrl } from '../lib/api';

export const RULES_URL = '/gacha-rules.html';

/**
 * Sticker do quản trị viên tải lên (có thể là ảnh động), chọn sau khi đã có kết quả nên chỉ để trang trí: alt rỗng, kết quả nằm ở
 * tiêu đề ngay dưới. Chưa có sticker, ảnh lỗi hoặc người dùng bật giảm chuyển động → biểu tượng tĩnh thay thế.
 */
function Sticker({ sticker, fallback }) {
  const [broken, setBroken] = useState(false);
  const icon = (
    <span aria-hidden="true" className="text-5xl">
      {fallback}
    </span>
  );
  if (!sticker?.url || broken) {
    return <div className="flex h-24 items-center justify-center motion-safe:animate-pop-in">{icon}</div>;
  }
  return (
    <div className="flex h-28 items-center justify-center">
      <img src={assetUrl(sticker.url)} alt="" onError={() => setBroken(true)} className="h-28 w-28 object-contain motion-reduce:hidden" />
      <span className="hidden motion-reduce:inline">{icon}</span>
    </div>
  );
}

export function KeychainImage({ url, label, className = 'h-32 w-32' }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <span role="img" aria-label={`Móc khóa ${label}`} className={`flex items-center justify-center rounded-2xl bg-amber-50 text-4xl ${className}`}>
        🔑
      </span>
    );
  }
  return <img src={assetUrl(url)} alt={`Móc khóa ${label}`} onError={() => setBroken(true)} className={`rounded-2xl bg-white object-contain ${className}`} />;
}

export function CopyCodeButton({ code, className = '' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" onClick={copy} className={`rounded-xl bg-leaf-600 py-2.5 text-sm font-bold text-white ${className}`}>
      {copied ? 'Đã sao chép!' : 'Sao chép mã'}
    </button>
  );
}

/** Kết quả một lượt quay thưởng tri ân: trúng (sticker, ảnh móc khóa, mã nhận quà, hướng dẫn nhận) hoặc không trúng */
export default function GachaResult({ result }) {
  if (result.outcome === 'win' && result.prize) {
    const { prize } = result;
    return (
      <div className="space-y-4 text-center">
        <Sticker sticker={result.sticker} fallback="🎉" />
        <div>
          <h3 className="text-xl font-extrabold text-leaf-800">Trúng thưởng!</h3>
          <p className="text-sm font-semibold text-stone-600">Bạn nhận được một móc khóa GreenCanteen phiên bản đặc biệt</p>
        </div>
        <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-4">
          <KeychainImage url={prize.imageUrl} label={prize.label} className="mx-auto h-36 w-36" />
          <p className="mt-2 text-lg font-extrabold text-stone-900">{prize.label}</p>
          {prize.description && <p className="text-xs text-stone-600">{prize.description}</p>}
          <p className="mt-3 text-[10px] font-bold uppercase tracking-wide text-amber-700">Mã nhận quà</p>
          <p className="break-all rounded-xl bg-white px-3 py-2 font-mono text-base font-bold text-leaf-800">{prize.claimCode}</p>
          <CopyCodeButton code={prize.claimCode} className="mt-3 w-full" />
        </div>
        {result.claimInstructions && (
          <div className="rounded-xl bg-leaf-50 px-3 py-2 text-left text-xs text-stone-700">
            <p className="font-bold text-leaf-800">Cách nhận quà</p>
            <p className="whitespace-pre-line break-words">{result.claimInstructions}</p>
          </div>
        )}
        <p className="text-[11px] text-stone-500">
          Mã nhận quà luôn có trong trang Cá nhân. Người trao quà đối chiếu tài khoản của bạn trước khi trao.{' '}
          <a href={RULES_URL} target="_blank" rel="noopener" className="underline underline-offset-2">
            Thể lệ
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-center">
      <Sticker sticker={result.sticker} fallback="🍀" />
      <div>
        <h3 className="text-xl font-extrabold text-stone-800">Chưa trúng lần này</h3>
        <p className="text-sm text-stone-600">
          Kết quả hoàn toàn do may mắn. Mỗi lần check-in hợp lệ lại có thêm lượt quay. Cảm ơn bạn đã dùng bình, ly cá nhân!
        </p>
      </div>
    </div>
  );
}
