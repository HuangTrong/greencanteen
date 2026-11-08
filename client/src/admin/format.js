const TIME_ZONE = 'Asia/Ho_Chi_Minh';

export const formatNumber = (value) => (Number.isFinite(value) ? value.toLocaleString('vi-VN') : '—');

export const formatVnd = (value) => (Number.isFinite(value) ? `${value.toLocaleString('vi-VN')} ₫` : '—');

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE });
}

/** Xác suất lưu bằng số nguyên phần triệu; chuyển đổi bằng phép tính chuỗi để không dính sai số số thực */
export function ppmToPercent(ppm) {
  const whole = Math.floor(ppm / 10_000);
  const fraction = String(ppm % 10_000).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Xác suất ppm → "≈ 1 trên N lượt", kiểu cách nói tỉ lệ của xổ số; 0 → "—" */
export function oddsText(ppm) {
  if (!Number.isFinite(ppm) || ppm <= 0) return '—';
  const n = Math.round(1_000_000 / ppm);
  return n <= 1 ? 'mọi lượt' : `≈ 1 trên ${n.toLocaleString('vi-VN')} lượt`;
}

/** "8.3334" → 83334. Sai định dạng hoặc quá 4 chữ số thập phân → null */
export function percentToPpm(text) {
  const match = /^(\d{1,3})(?:[.,](\d{1,4}))?$/.exec(String(text).trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  return Number(whole) * 10_000 + Number(fraction.padEnd(4, '0'));
}

/** Ô datetime-local theo giờ Việt Nam ↔ ISO, không phụ thuộc múi giờ của máy quản trị viên */
export function isoToLocalInput(iso) {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

export const localInputToIso = (value) => (value ? new Date(`${value}:00+07:00`).toISOString() : null);

/** Ngày YYYY-MM-DD theo giờ Việt Nam, cách hôm nay `offsetDays` ngày */
export function vietnamDate(offsetDays = 0, now = Date.now()) {
  return new Date(now + 7 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** "2026-10-05" → "05/10"; "2026-10" → "10/2026" */
export function formatPeriod(period) {
  const [year, month, day] = period.split('-');
  return day ? `${day}/${month}` : `${month}/${year}`;
}

const SLUG_CHARS = { đ: 'd', Đ: 'd' };

export function slugify(text) {
  return text
    .replace(/[đĐ]/g, (char) => SLUG_CHARS[char])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

export const STORY_STATUS_LABELS = { draft: 'Nháp', published: 'Đã xuất bản', archived: 'Đã gỡ' };
export const CONFIG_STATUS_LABELS = { draft: 'Nháp', published: 'Đã xuất bản', discarded: 'Đã hủy' };
export const MEDIA_KIND_LABELS = { keychain: 'Ảnh móc khóa', win: 'Sticker trúng', lose: 'Sticker không trúng' };
export const DELIVERY_STATUS_LABELS = { pending: 'Chờ trao', delivered: 'Đã trao' };
export const USER_STATUS_LABELS = { active: 'Đang hoạt động', locked: 'Đang khóa' };
export const ROLE_LABELS = { user: 'Người dùng', admin: 'Quản trị viên' };
export const AUDIT_RESULT_LABELS = { success: 'Thành công', failure: 'Thất bại', denied: 'Bị từ chối' };

export const AUDIT_ACTION_LABELS = {
  'admin.bootstrap': 'Khởi tạo admin đầu tiên',
  'admin.login': 'Đăng nhập quản trị',
  'admin.logout': 'Đăng xuất quản trị',
  'admin.mfa_enroll': 'Đăng ký MFA',
  'admin.mfa_reset': 'Đặt lại MFA từ dòng lệnh',
  'admin.password_reset': 'Đặt lại mật khẩu admin từ dòng lệnh',
  'admin.reauth': 'Xác thực lại',
  'admin.reauth_required': 'Thao tác bị chặn vì chưa xác thực lại',
  'account.password_change': 'Sinh viên đổi mật khẩu',
  'account.password_reset': 'Sinh viên đặt lại mật khẩu qua email',
  'account.provider_link': 'Sinh viên liên kết nhà cung cấp đăng nhập',
  'account.provider_unlink': 'Sinh viên hủy liên kết nhà cung cấp đăng nhập',
  'account.sessions_revoked': 'Sinh viên đăng xuất các thiết bị khác',
  'account.mfa_enable': 'Sinh viên bật xác thực hai lớp',
  'account.mfa_disable': 'Sinh viên tắt xác thực hai lớp',
  'account.mfa_recovery_used': 'Sinh viên đăng nhập bằng mã khôi phục',
  'account.mfa_recovery_regenerate': 'Sinh viên tạo mã khôi phục mới',
  'account.passkey_add': 'Sinh viên thêm passkey',
  'account.passkey_remove': 'Sinh viên xóa passkey',
  'account.passkey_login': 'Sinh viên đăng nhập bằng passkey',
  'upload.malware_blocked': 'Chặn tệp tải lên có dấu hiệu mã độc',
  'user.reveal_pii': 'Xem dữ liệu tài khoản đầy đủ',
  'user.status_change': 'Đổi trạng thái tài khoản',
  'user.bulk_status': 'Đổi trạng thái hàng loạt',
  'user.student_id_change': 'Đổi mã sinh viên',
  'user.role_change': 'Đổi quyền truy cập',
  'user.mfa_reset': 'Đặt lại MFA',
  'user.student_mfa_reset': 'Tắt xác thực hai lớp của sinh viên',
  'user.avatar_remove': 'Gỡ ảnh đại diện',
  'story.create': 'Tạo câu chuyện',
  'story.update': 'Sửa câu chuyện',
  'story.publish': 'Xuất bản câu chuyện',
  'story.unpublish': 'Gỡ câu chuyện',
  'gacha.config_create': 'Tạo nháp cấu hình quay thưởng tri ân',
  'gacha.config_update': 'Sửa nháp cấu hình quay thưởng tri ân',
  'gacha.config_publish': 'Xuất bản cấu hình quay thưởng tri ân',
  'gacha.config_end': 'Ngừng cấu hình quay thưởng tri ân',
  'gacha.config_discard': 'Hủy nháp cấu hình quay thưởng tri ân',
  'gacha.media_create': 'Tải ảnh / sticker quay thưởng',
  'gacha.media_update': 'Sửa ảnh / sticker quay thưởng',
  'gacha.media_delete': 'Xóa ảnh / sticker quay thưởng',
  'gacha.reward_deliver': 'Xác nhận đã trao móc khóa',
  'gacha.reward_undeliver': 'Hủy xác nhận đã trao móc khóa',
  'site_settings.update': 'Sửa thiết lập website',
};
