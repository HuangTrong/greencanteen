import { useEffect, useState } from 'react';
import { assetUrl } from '../lib/api';

/** Tên Việt gọi theo từ cuối: "Nguyễn An" → "A". Dùng normalize để chữ có dấu không bị tách thành hai ký tự */
function initialOf(name) {
  const lastWord = (name || '').trim().split(/\s+/).pop();
  return [...lastWord.normalize('NFC')][0]?.toUpperCase() || '?';
}

/** Ảnh đại diện hình tròn. Chưa có ảnh hoặc ảnh tải lỗi thì hiện chữ cái đầu của tên. */
export default function Avatar({ src, name, alt = '', className = '' }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);

  if (!src || broken) {
    return (
      <span
        data-testid="avatar-initial"
        aria-hidden="true"
        className={`flex items-center justify-center rounded-full bg-leaf-100 font-extrabold text-leaf-800 ${className}`}
      >
        {initialOf(name)}
      </span>
    );
  }
  return <img src={assetUrl(src)} alt={alt} decoding="async" onError={() => setBroken(true)} className={`rounded-full bg-leaf-50 object-cover ${className}`} />;
}
