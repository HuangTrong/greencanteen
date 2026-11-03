import { useRef, useState } from 'react';
import { api } from '../lib/api';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

/** Đổi / gỡ ảnh đại diện. Kiểm tra ở đây chỉ để báo sớm, tiết kiệm dữ liệu di động; server kiểm tra lại theo nội dung tệp. */
export default function AvatarControls({ user, onUserChange }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (action, fallback) => {
    setBusy(true);
    setError('');
    try {
      const { user: next } = await action();
      onUserChange(next);
    } catch (err) {
      setError(err.message || fallback);
    } finally {
      setBusy(false);
    }
  };

  const onFileChosen = (event) => {
    const file = event.target.files?.[0];
    // Xóa lựa chọn để chọn lại đúng tệp đó sau khi lỗi vẫn kích hoạt được sự kiện change
    event.target.value = '';
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) return setError('Chỉ nhận ảnh JPEG, PNG hoặc WebP.');
    if (file.size > MAX_BYTES) return setError('Ảnh quá lớn (tối đa 8MB). Vui lòng chọn ảnh nhỏ hơn.');
    run(() => api.uploadAvatar(file), 'Không đổi được ảnh đại diện.');
  };

  return (
    <div className="mt-3">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        aria-label="Chọn ảnh đại diện"
        onChange={onFileChosen}
        className="hidden"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-leaf-800 shadow-sm disabled:opacity-60"
        >
          {busy ? 'Đang tải ảnh...' : 'Đổi ảnh đại diện'}
        </button>
        {user.avatarUrl && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(api.removeAvatar, 'Không gỡ được ảnh đại diện.')}
            className="rounded-lg border border-white/60 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
          >
            Gỡ ảnh
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-leaf-100">JPEG, PNG hoặc WebP, tối đa 8MB. Ảnh hiển thị công khai trên bảng xếp hạng.</p>
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
