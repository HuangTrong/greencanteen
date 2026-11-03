import { SiteSetting } from '../models/SiteSetting.js';
import { invalidInput, versionConflict } from './adminErrors.js';
import { analyticsEnabled } from './analytics.js';

// Giá trị mặc định trùng nội dung đang có của giao diện: chưa ai chỉnh thì trang công khai không đổi
const TEXT_FIELDS = {
  headerTagline: { max: 120, fallback: 'Căn tin xanh — Ly cá nhân, Trái đất vui', required: true },
  heroTitle: { max: 120, fallback: 'Một ly nhựa ít hơn, một đại dương sạch hơn', required: true },
  seoDescription: { max: 200, fallback: 'GreenCanteen — Check-in ly/bình cá nhân tại căn tin, bảo vệ môi trường', required: true },
  announcementText: { max: 300, fallback: '' },
  supportContact: { max: 200, fallback: '' },
};
const EDITABLE_KEYS = new Set([...Object.keys(TEXT_FIELDS), 'announcementEnabled', 'revision']);

function publicFields(doc) {
  const settings = { announcementEnabled: Boolean(doc?.announcementEnabled) };
  for (const [key, { fallback }] of Object.entries(TEXT_FIELDS)) settings[key] = doc?.[key] ?? fallback;
  return settings;
}

/** Thiết lập cho trang công khai: chỉ gồm nội dung hiển thị, không có gì đọc từ biến môi trường ngoài cờ bật thống kê */
export async function getPublicSettings() {
  const doc = await SiteSetting.findById('public').lean();
  return { ...publicFields(doc), analyticsEnabled: analyticsEnabled() };
}

export async function getAdminSettings() {
  const doc = await SiteSetting.findById('public').lean();
  return {
    ...publicFields(doc),
    revision: doc?.__v ?? 0,
    updatedAt: doc?.updatedAt || null,
    updatedByLabel: doc?.updatedByLabel || '',
  };
}

/** Khóa ngoài danh sách bị từ chối thay vì bỏ qua: không có đường nào để ghi cấu hình khác vào đây */
export async function updateSettings(actor, body) {
  const fields = {};
  for (const key of Object.keys(body || {})) {
    if (!EDITABLE_KEYS.has(key)) fields[key] = 'Thiết lập này không được chỉnh trong khu quản trị.';
  }
  const value = { announcementEnabled: body?.announcementEnabled === true };
  for (const [key, { max, required }] of Object.entries(TEXT_FIELDS)) {
    const text = typeof body?.[key] === 'string' ? body[key].trim() : '';
    if (text.length > max) fields[key] = `Tối đa ${max} ký tự.`;
    if (required && !text) fields[key] = 'Không được để trống.';
    value[key] = text;
  }
  if (value.announcementEnabled && !value.announcementText) fields.announcementText = 'Cần nhập nội dung thông báo khi bật.';
  if (Object.keys(fields).length > 0) throw invalidInput(fields);

  const doc = (await SiteSetting.findById('public')) || new SiteSetting({ _id: 'public' });
  if (body.revision !== (doc.__v ?? 0)) throw versionConflict();
  const changed = Object.keys(value).filter((key) => (doc[key] ?? null) !== value[key]);
  doc.set({ ...value, updatedBy: actor.id, updatedByLabel: actor.label });
  await doc.save();
  return { settings: await getAdminSettings(), changed };
}
