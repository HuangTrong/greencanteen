import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { assetUrl } from '../lib/api';

// Dùng chung cho các trang quay thưởng tri ân: thanh chuyển mục, ảnh từ thư viện ảnh quay thưởng

const TABS = [
  ['/gacha', 'Phiên bản cấu hình', (path) => path === '/gacha' || /^\/gacha\/[a-f0-9]{24}$/i.test(path)],
  ['/gacha/media', 'Ảnh & sticker', (path) => path === '/gacha/media'],
  ['/gacha/rewards', 'Trao quà', (path) => path === '/gacha/rewards'],
];

export function GachaTabs() {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Mục quay thưởng tri ân" className="mb-4 flex flex-wrap gap-2">
      {TABS.map(([to, label, matches]) => {
        const active = matches(pathname);
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? 'page' : undefined}
            className={`rounded-full px-3 py-1.5 text-sm font-bold outline-none ring-leaf-400 focus-visible:ring-2 ${
              active ? 'bg-leaf-700 text-white' : 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-100'
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Ảnh trong thư viện ảnh quay thưởng; ảnh đã bị xóa hoặc không tải được → ô trống có chữ, không vỡ bố cục */
export function MediaImage({ url, alt, className = '' }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <span className={`flex items-center justify-center rounded-lg bg-stone-100 text-center text-[10px] font-semibold text-stone-500 ${className}`}>
        {url ? 'Ảnh đã xóa' : 'Chưa có ảnh'}
      </span>
    );
  }
  return (
    <img
      src={assetUrl(url)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className={`rounded-lg bg-stone-50 object-contain ${className}`}
    />
  );
}
