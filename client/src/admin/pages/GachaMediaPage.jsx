import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../adminApi';
import { MEDIA_KIND_LABELS, formatDateTime } from '../format';
import { GachaTabs, MediaImage } from '../gacha';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageHeader, SelectField, TextField, inputClass, useLoad, useNotice } from '../ui';

const KINDS = Object.keys(MEDIA_KIND_LABELS);
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_BYTES = 8 * 1024 * 1024;

const KIND_HINTS = {
  keychain: 'Ảnh chụp hoặc thiết kế của móc khóa, hiện trong popup trúng thưởng và trang thể lệ.',
  win: 'Sticker hoặc ảnh động hiện khi trúng. Đang bật nhiều sticker thì mỗi lượt chọn ngẫu nhiên một cái.',
  lose: 'Sticker hoặc ảnh động hiện khi không trúng, nên vui vẻ, động viên quay tiếp.',
};

function UploadForm({ onUploaded }) {
  const notify = useNotice();
  const fileRef = useRef(null);
  const [kind, setKind] = useState('keychain');
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [fields, setFields] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setFields({});
    setMessage('');
    if (!file) return setFields({ image: 'Chọn tệp ảnh.' });
    if (file.size > MAX_BYTES) return setFields({ image: 'Ảnh quá lớn (tối đa 8 MB).' });
    setBusy(true);
    try {
      const media = await adminApi.uploadGachaMedia({ kind, name, file });
      notify(`Đã tải lên «${media.name}».`);
      setName('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      onUploaded(media);
    } catch (err) {
      setFields(err.payload?.fields || {});
      setMessage(err.message || 'Không tải lên được.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Tải ảnh lên">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          <SelectField label="Loại ảnh" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {MEDIA_KIND_LABELS[value]}
              </option>
            ))}
          </SelectField>
          <TextField
            label={kind === 'keychain' ? 'Tên móc khóa (dùng làm chú thích ảnh)' : 'Tên sticker'}
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={fields.name}
          />
          <div className="space-y-1">
            <label htmlFor="gacha-media-file" className="block text-sm font-semibold text-stone-700">
              Tệp ảnh
            </label>
            <input
              id="gacha-media-file"
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              aria-describedby="gacha-media-file-hint"
              aria-invalid={Boolean(fields.image)}
              className={inputClass}
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            {fields.image && <p className="text-xs font-semibold text-red-700">{fields.image}</p>}
          </div>
        </div>
        <p id="gacha-media-file-hint" className="text-xs text-stone-500">
          {KIND_HINTS[kind]} PNG, JPEG, WebP hoặc GIF (giữ chuyển động), tối đa 8 MB. Máy chủ nén lại thành WebP và bỏ thông tin đi kèm
          tệp như vị trí chụp; nội dung ảnh không sửa được sau khi tải, muốn đổi thì tải ảnh mới.
        </p>
        {message && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {message}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? 'Đang tải lên...' : 'Tải lên'}
        </Button>
      </form>
    </Card>
  );
}

function MediaCard({ media, onChanged, onDelete }) {
  const notify = useNotice();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(media.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = async (body, done) => {
    setBusy(true);
    setError('');
    try {
      onChanged(await adminApi.updateGachaMedia(media.id, body));
      notify(done);
      setEditing(false);
    } catch (err) {
      setError(err.payload?.fields?.name || err.message || 'Không lưu được.');
    } finally {
      setBusy(false);
    }
  };

  const sticker = media.kind !== 'keychain';
  return (
    <li className="flex flex-col rounded-2xl border border-stone-200 bg-white p-3">
      <MediaImage url={media.url} alt={media.name} className="mx-auto h-32 w-full" />
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Badge tone={media.kind === 'keychain' ? 'blue' : media.kind === 'win' ? 'green' : 'amber'}>{MEDIA_KIND_LABELS[media.kind]}</Badge>
        {media.animated && <Badge>Ảnh động</Badge>}
        {sticker && !media.active && <Badge tone="stone">Đang tắt</Badge>}
      </div>
      {editing ? (
        <form
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            update({ name }, 'Đã đổi tên ảnh.');
          }}
        >
          <input aria-label={`Tên mới cho ${media.name}`} className={inputClass} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" className="px-3 py-1" disabled={busy}>
              Lưu
            </Button>
            <Button
              tone="secondary"
              className="px-3 py-1"
              onClick={() => {
                setEditing(false);
                setName(media.name);
                setError('');
              }}
            >
              Hủy
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-2 break-words text-sm font-bold text-stone-800">{media.name}</p>
      )}
      <p className="mt-1 text-xs text-stone-500">
        {media.width}×{media.height} · {formatDateTime(media.createdAt)}
        {media.createdByLabel ? ` · ${media.createdByLabel}` : ''}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-3">
        {!editing && (
          <Button tone="secondary" className="px-3 py-1" aria-label={`Đổi tên ${media.name}`} onClick={() => setEditing(true)}>
            Đổi tên
          </Button>
        )}
        {sticker && (
          <Button
            tone="secondary"
            className="px-3 py-1"
            disabled={busy}
            aria-label={`${media.active ? 'Tắt' : 'Bật'} ${media.name}`}
            onClick={() => update({ active: !media.active }, media.active ? 'Đã tắt sticker.' : 'Đã bật sticker.')}
          >
            {media.active ? 'Tắt' : 'Bật'}
          </Button>
        )}
        <Button tone="dangerOutline" className="px-3 py-1" aria-label={`Xóa ${media.name}`} onClick={() => onDelete(media)}>
          Xóa
        </Button>
      </div>
    </li>
  );
}

export default function GachaMediaPage() {
  useEffect(() => {
    document.title = 'Ảnh & sticker quay thưởng · Quản trị GreenCanteen';
  }, []);

  const notify = useNotice();
  const [kind, setKind] = useState('');
  const [deleting, setDeleting] = useState(null);
  const { data, loading, error, reload, setData } = useLoad(() => adminApi.gachaMedia({ kind }), [kind]);
  const items = data?.items || [];

  const replace = (media) => setData({ ...data, items: items.map((item) => (item.id === media.id ? media : item)) });

  return (
    <>
      <PageHeader
        title="Ảnh & sticker"
        description="Ảnh móc khóa dùng trong các phiên bản cấu hình; sticker hiện ở màn hình kết quả quay. Chưa có sticker nào thì giao diện dùng hình mặc định."
      />
      <GachaTabs />
      <div className="space-y-4">
        <UploadForm
          onUploaded={(media) => {
            if (!kind || kind === media.kind) setData({ ...data, items: [media, ...items] });
          }}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <SelectField label="Lọc theo loại" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Tất cả</option>
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {MEDIA_KIND_LABELS[value]}
                </option>
              ))}
            </SelectField>
          </div>
        </div>

        {error && <ErrorState message={error} onRetry={reload} />}
        {!data && loading && <LoadingState />}
        {data && items.length === 0 && !loading && <EmptyState>Chưa có ảnh nào{kind ? ' thuộc loại này' : ''}.</EmptyState>}
        {items.length > 0 && (
          <ul aria-label="Thư viện ảnh quay thưởng" className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 ${loading ? 'opacity-60' : ''}`}>
            {items.map((media) => (
              <MediaCard key={media.id} media={media} onChanged={replace} onDelete={setDeleting} />
            ))}
          </ul>
        )}
      </div>

      {deleting && (
        <ConfirmDialog
          title={`Xóa «${deleting.name}»`}
          description={
            deleting.kind === 'keychain'
              ? 'Ảnh đang được bản nháp hoặc phiên bản còn hiệu lực dùng thì không xóa được. Kết quả quay cũ dùng ảnh này sẽ hiện ô trống.'
              : 'Sticker này sẽ không còn hiện ở màn hình kết quả.'
          }
          confirmLabel="Xóa ảnh"
          onConfirm={async () => {
            await adminApi.deleteGachaMedia(deleting.id);
            setData({ ...data, items: items.filter((item) => item.id !== deleting.id) });
            notify('Đã xóa ảnh.');
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
