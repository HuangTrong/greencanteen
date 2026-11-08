import { useState } from 'react';

// Tên miền không phân giải được trên Internet (giống server/src/services/adminStories.js)
const INTERNAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|invalid|test)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * SEC-04: chỉ tải ảnh / mở liên kết tới tên miền công khai trên cổng HTTPS mặc định. Câu chuyện cũ trong DB còn URL trỏ vào địa chỉ
 * IP, máy trong mạng nội bộ hay kèm tài khoản thì trình duyệt của sinh viên không gửi request tới đó.
 */
export function isPublicHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || IPV4.test(host)) return false;
  return host.includes('.') && !INTERNAL_NAME.test(host);
}

/**
 * Ảnh là tùy chọn: không có ảnh hoặc ảnh lỗi thì dùng biểu tượng minh họa. remoteImage=false (khu quản trị): không tải ảnh từ máy
 * khác, chỉ hiện tên máy và liên kết mở ảnh ở tab mới; CSP của khu quản trị cũng không cho tải.
 */
export function StoryHeader({ story, remoteImage = true }) {
  const [imageFailed, setImageFailed] = useState(false);
  const publicImage = isPublicHttpsUrl(story.imageUrl);
  const showImage = remoteImage && publicImage && !imageFailed;
  return (
    <div className="relative h-36 overflow-hidden bg-gradient-to-br from-sky-600 via-teal-600 to-leaf-700">
      {showImage ? (
        <img src={story.imageUrl} alt="" className="h-full w-full object-cover" onError={() => setImageFailed(true)} />
      ) : (
        <span aria-hidden="true" className="absolute right-4 top-3 text-6xl drop-shadow-lg">
          {story.icon || '🌊'}
        </span>
      )}
      {!remoteImage && publicImage && (
        <p className="absolute left-4 top-3 max-w-[70%] rounded-lg bg-black/50 px-2 py-1 text-[11px] text-white">
          Ảnh ở {new URL(story.imageUrl).hostname} (không tải trong khu quản trị) ·{' '}
          <a href={story.imageUrl} target="_blank" rel="noopener noreferrer" className="font-bold underline">
            Mở ảnh
          </a>
        </p>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
      <div className="absolute bottom-3 left-4 right-4">
        <p className="text-[11px] font-bold uppercase tracking-wide text-leaf-200">Câu chuyện từ nghiên cứu khoa học</p>
        <h3 className="text-lg font-extrabold leading-tight text-white">{story.title}</h3>
      </div>
    </div>
  );
}

function SourceCard({ source, onSourceClick }) {
  const volume = [source.volume && `${source.volume}${source.issue ? `(${source.issue})` : ''}`, source.pages]
    .filter(Boolean)
    .join(': ');
  // Dữ liệu nguồn thiếu trường (câu chuyện thêm thẳng vào DB) → chỉ hiện phần có, không làm sập popup
  const authors = Array.isArray(source.authors) ? source.authors.join(', ') : '';
  const citation = [source.year && `(${source.year})`, volume].filter(Boolean).join(', ');
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-xs leading-relaxed text-stone-600">
      <p className="text-[10px] font-bold uppercase tracking-wide text-stone-400">Nguồn nghiên cứu</p>
      <p className="mt-0.5 font-semibold text-stone-800">{source.title}</p>
      {authors && <p>{authors}</p>}
      {(source.journal || citation) && (
        <p>
          {source.journal && <span className="italic">{source.journal}</span>}
          {source.journal && citation ? ' ' : ''}
          {citation}
        </p>
      )}
      {isPublicHttpsUrl(source.url) && (
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onSourceClick}
          className="mt-1 inline-block break-all font-bold text-leaf-700 underline underline-offset-2"
        >
          {source.doi ? `DOI: ${source.doi}` : 'Mở bài báo'} ↗
        </a>
      )}
    </div>
  );
}

/** Nội dung câu chuyện: dùng chung cho popup sau check-in và màn hình xem trước của quản trị viên */
export function StoryBody({ story, onSourceClick }) {
  return (
    <>
      <p className="text-xs font-semibold text-leaf-700">{story.species}</p>
      <p className="text-sm leading-relaxed text-stone-600">{story.summary}</p>
      {story.caveat && (
        <p className="rounded-lg bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-stone-500">
          <span className="font-bold">Lưu ý: </span>
          {story.caveat}
        </p>
      )}
      {story.message && (
        <blockquote className="border-l-4 border-leaf-500 bg-leaf-50/80 px-3 py-2 text-sm font-semibold italic text-leaf-900">
          {story.message}
        </blockquote>
      )}
      {story.source && <SourceCard source={story.source} onSourceClick={onSourceClick} />}
    </>
  );
}
