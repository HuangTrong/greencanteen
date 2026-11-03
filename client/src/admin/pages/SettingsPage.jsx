import { useEffect, useState } from 'react';
import { adminApi } from '../adminApi';
import { formatDateTime } from '../format';
import { Button, Card, ErrorState, LoadingState, PageHeader, TextArea, TextField, useNotice } from '../ui';

const EDITABLE = ['headerTagline', 'heroTitle', 'seoDescription', 'announcementEnabled', 'announcementText', 'supportContact'];

export default function SettingsPage() {
  const notify = useNotice();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [fields, setFields] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    document.title = 'Thiết lập website · Quản trị GreenCanteen';
    adminApi
      .siteSettings()
      .then((data) => {
        setSettings(data);
        setForm(data);
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  if (loadError) return <ErrorState message={loadError} />;
  if (!form) return <LoadingState />;

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setFields({});
    setMessage('');
    try {
      const body = Object.fromEntries(EDITABLE.map((key) => [key, form[key]]));
      const saved = await adminApi.updateSiteSettings({ ...body, revision: settings.revision });
      setSettings(saved);
      setForm(saved);
      notify('Đã lưu thiết lập. Trang công khai cập nhật trong khoảng 1 phút.');
    } catch (err) {
      setFields(err.payload?.fields || {});
      setMessage(err.message || 'Không lưu được.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Thiết lập website"
        description="Chỉ gồm nội dung hiển thị công khai. Khóa bí mật, cấu hình đăng nhập, cơ sở dữ liệu và hạ tầng được quản lý ngoài khu quản trị."
      />
      <form onSubmit={submit} className="max-w-2xl space-y-4">
        <Card title="Nội dung trang">
          <div className="space-y-3">
            <TextField label="Khẩu hiệu đầu trang" required maxLength={120} value={form.headerTagline} onChange={set('headerTagline')} error={fields.headerTagline} />
            <TextField label="Tiêu đề trang chủ" required maxLength={120} value={form.heroTitle} onChange={set('heroTitle')} error={fields.heroTitle} />
            <TextArea label="Mô tả cho công cụ tìm kiếm" required rows={2} maxLength={200} value={form.seoDescription} onChange={set('seoDescription')} error={fields.seoDescription} />
            <TextField label="Thông tin liên hệ hỗ trợ" maxLength={200} value={form.supportContact} onChange={set('supportContact')} error={fields.supportContact} />
          </div>
        </Card>
        <Card title="Thông báo">
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
              <input
                type="checkbox"
                checked={form.announcementEnabled}
                onChange={(e) => setForm((current) => ({ ...current, announcementEnabled: e.target.checked }))}
              />
              Hiển thị thông báo trên mọi trang
            </label>
            <TextArea label="Nội dung thông báo" rows={2} maxLength={300} value={form.announcementText} onChange={set('announcementText')} error={fields.announcementText} />
          </div>
        </Card>
        {message && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Đang lưu...' : 'Lưu thiết lập'}
          </Button>
          {settings.updatedAt && (
            <span className="text-xs text-stone-500">
              Sửa lần cuối {formatDateTime(settings.updatedAt)}
              {settings.updatedByLabel && ` bởi ${settings.updatedByLabel}`}
            </span>
          )}
        </div>
      </form>
    </>
  );
}
