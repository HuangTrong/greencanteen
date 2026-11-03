import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { StoryBody, StoryHeader } from '../../components/StoryContent';
import { adminApi } from '../adminApi';
import { STORY_STATUS_LABELS, formatDateTime, slugify } from '../format';
import { Badge, Button, Card, ConfirmDialog, ErrorState, LoadingState, PageHeader, TextArea, TextField, useNotice } from '../ui';

const EMPTY = {
  slug: '',
  title: '',
  species: '',
  icon: '🌊',
  imageUrl: '',
  summary: '',
  caveat: '',
  message: '',
  source: { title: '', authors: [], journal: '', year: '', volume: '', issue: '', pages: '', doi: '', url: '' },
};

/** Biểu mẫu dùng chuỗi trong ô nhập; năm và danh sách tác giả được đổi kiểu lúc gửi đi */
function toForm(story) {
  return { ...story, source: { ...story.source, year: story.source.year ?? '', authors: story.source.authors.join('\n') } };
}

function toPayload(form) {
  const { source, ...rest } = form;
  const year = String(source.year).trim();
  return {
    ...rest,
    source: {
      ...source,
      // Giá trị không phải số được gửi nguyên để server báo lỗi đúng trường
      year: /^\d+$/.test(year) ? Number(year) : year,
      authors: String(source.authors).split('\n').map((name) => name.trim()).filter(Boolean),
    },
  };
}

export default function StoryEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const notify = useNotice();
  const [form, setForm] = useState(id ? null : toForm(EMPTY));
  const [story, setStory] = useState(null);
  const [fields, setFields] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    document.title = 'Soạn câu chuyện · Quản trị GreenCanteen';
    if (!id) return undefined;
    let stale = false;
    adminApi
      .story(id)
      .then((data) => {
        if (stale) return;
        setStory(data);
        setForm(toForm(data));
      })
      .catch((err) => {
        if (!stale) setLoadError(err.message);
      });
    return () => {
      stale = true;
    };
  }, [id]);

  if (loadError) return <ErrorState message={loadError} />;
  if (!form) return <LoadingState />;

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setSource = (key) => (event) => setForm((current) => ({ ...current, source: { ...current.source, [key]: event.target.value } }));
  const setTitle = (event) => {
    const title = event.target.value;
    setForm((current) => ({ ...current, title, slug: id || slugTouched ? current.slug : slugify(title) }));
  };

  const fail = (err) => {
    setFields(err.payload?.fields || {});
    setMessage(err.message || 'Không lưu được.');
  };

  /** Lưu trước rồi mới xuất bản: nội dung được kiểm tra đúng như những gì đang thấy trên màn hình */
  const save = async () => {
    const payload = toPayload(form);
    if (!story) return adminApi.createStory(payload);
    return adminApi.updateStory(story.id, { ...payload, revision: story.revision });
  };

  const run = async (action, successText) => {
    setBusy(true);
    setFields({});
    setMessage('');
    try {
      const saved = await action();
      setStory(saved);
      setForm(toForm(saved));
      notify(successText);
      if (!id) navigate(`/stories/${saved.id}`, { replace: true });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => run(save, 'Đã lưu.');
  const onPublish = () =>
    run(async () => {
      const saved = await save();
      setStory(saved);
      return adminApi.publishStory(saved.id, saved.revision);
    }, 'Đã xuất bản câu chuyện.');

  const preview = toPayload(form);
  const status = story?.status || 'draft';

  return (
    <>
      <PageHeader
        title={id ? form.title || 'Câu chuyện' : 'Thêm câu chuyện'}
        description={<Link to="/stories" className="font-semibold text-leaf-800 underline underline-offset-2">Danh sách câu chuyện</Link>}
        actions={<Badge tone={{ draft: 'amber', published: 'green', archived: 'stone' }[status]}>{STORY_STATUS_LABELS[status]}</Badge>}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <Card title="Nội dung">
            <div className="space-y-3">
              <TextField label="Tiêu đề" required maxLength={160} value={form.title} onChange={setTitle} error={fields.title} />
              <TextField
                label="Slug"
                required
                maxLength={80}
                value={form.slug}
                disabled={Boolean(id)}
                hint={id ? 'Slug được giữ nguyên vì lịch sử check-in tham chiếu tới nó.' : 'Tự tạo từ tiêu đề, có thể sửa trước khi lưu lần đầu.'}
                onChange={(event) => {
                  setSlugTouched(true);
                  set('slug')(event);
                }}
                error={fields.slug}
              />
              <TextField label="Loài được đề cập" maxLength={200} value={form.species} onChange={set('species')} error={fields.species} />
              <TextArea label="Tóm tắt" rows={5} maxLength={2000} value={form.summary} onChange={set('summary')} error={fields.summary} />
              <TextArea label="Lưu ý về giới hạn của nghiên cứu" maxLength={1000} value={form.caveat} onChange={set('caveat')} error={fields.caveat} />
              <TextArea label="Thông điệp" rows={2} maxLength={500} value={form.message} onChange={set('message')} error={fields.message} />
              <div className="grid gap-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
                <TextField label="Biểu tượng" maxLength={8} value={form.icon} onChange={set('icon')} error={fields.icon} />
                <TextField label="URL ảnh (HTTPS, tùy chọn)" type="url" maxLength={500} value={form.imageUrl} onChange={set('imageUrl')} error={fields.imageUrl} />
              </div>
            </div>
          </Card>

          <Card title="Nguồn nghiên cứu">
            <div className="space-y-3">
              <TextField label="Tên bài báo" maxLength={300} value={form.source.title} onChange={setSource('title')} error={fields['source.title']} />
              <TextArea label="Tác giả (mỗi dòng một người)" maxLength={4000} value={form.source.authors} onChange={setSource('authors')} error={fields['source.authors']} />
              <TextField label="Tạp chí" maxLength={200} value={form.source.journal} onChange={setSource('journal')} error={fields['source.journal']} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <TextField label="Năm" inputMode="numeric" value={form.source.year} onChange={setSource('year')} error={fields['source.year']} />
                <TextField label="Tập" maxLength={20} value={form.source.volume} onChange={setSource('volume')} error={fields['source.volume']} />
                <TextField label="Số" maxLength={20} value={form.source.issue} onChange={setSource('issue')} error={fields['source.issue']} />
                <TextField label="Trang" maxLength={40} value={form.source.pages} onChange={setSource('pages')} error={fields['source.pages']} />
              </div>
              <TextField label="DOI" value={form.source.doi} onChange={setSource('doi')} error={fields['source.doi']} />
              <TextField label="URL nguồn (HTTPS)" type="url" maxLength={500} value={form.source.url} onChange={setSource('url')} error={fields['source.url']} />
            </div>
          </Card>

          {message && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              {message}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" tone="secondary" disabled={busy}>
              {status === 'published' ? 'Lưu thay đổi' : 'Lưu nháp'}
            </Button>
            {status !== 'published' && (
              <Button disabled={busy} onClick={onPublish}>
                Xuất bản
              </Button>
            )}
            {status === 'published' && (
              <Button tone="dangerOutline" disabled={busy} onClick={() => setConfirmUnpublish(true)}>
                Gỡ câu chuyện
              </Button>
            )}
          </div>
          {story && (
            <p className="text-xs text-stone-500">
              Sửa lần cuối {formatDateTime(story.updatedAt)}
              {story.updatedByLabel && ` bởi ${story.updatedByLabel}`}.
              {story.origin === 'seed' && ' Sau khi được sửa ở đây, câu chuyện này không còn bị dữ liệu ban đầu ghi đè.'}
            </p>
          )}
        </form>

        <aside aria-label="Xem trước" className="xl:sticky xl:top-4 xl:self-start">
          <p className="mb-2 text-sm font-extrabold text-stone-800">Xem trước như trên điện thoại</p>
          <div className="overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm">
            <StoryHeader key={preview.imageUrl} story={preview} />
            <div className="space-y-3 p-5">
              <StoryBody story={preview} />
            </div>
          </div>
        </aside>
      </div>

      {confirmUnpublish && (
        <ConfirmDialog
          title="Gỡ câu chuyện"
          description="Câu chuyện không còn hiển thị sau check-in. Nội dung vẫn được giữ và xuất bản lại được."
          confirmLabel="Gỡ câu chuyện"
          onConfirm={async () => {
            const saved = await adminApi.unpublishStory(story.id, story.revision);
            setStory(saved);
            setForm(toForm(saved));
            notify('Đã gỡ câu chuyện.');
          }}
          onClose={() => setConfirmUnpublish(false)}
        />
      )}
    </>
  );
}
