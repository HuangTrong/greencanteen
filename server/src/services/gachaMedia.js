import { GachaMedia, MEDIA_KINDS } from '../models/GachaMedia.js';
import { AdminError } from './adminErrors.js';
import { MAX_INPUT_PIXELS, inspectImage } from './image.js';

export { MEDIA_KINDS };

export const MAX_MEDIA_UPLOAD_BYTES = 8 * 1024 * 1024;
// Ảnh động được giải mã toàn bộ các khung hình cùng lúc: giới hạn tổng điểm ảnh (khoảng 100 MB bộ nhớ) và số khung hình
const MAX_ANIMATED_PIXELS = 25_000_000;
const MAX_FRAMES = 300;
// Ảnh móc khóa hiện to trong popup kết quả và trang thể lệ; sticker chỉ là hình trang trí nhỏ
const MAX_SIDE = { keychain: 800, win: 480, lose: 480 };
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;

export const mediaUrl = (id) => (id ? `/api/gacha/media/${id}` : null);

const isGif = (buf) => buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6));

/** Kiểm tra theo nội dung tệp: JPEG, PNG, WebP (qua inspectImage) hoặc GIF. Sai → AdminError có thông báo cho quản trị viên */
export function inspectMedia(buf) {
  if (buf && isGif(buf)) return 'image/gif';
  const inspected = inspectImage(buf);
  if (inspected.ok) return inspected.mimeType;
  if (inspected.code === 'image_type_unsupported') {
    throw new AdminError(415, 'image_type_unsupported', 'Chỉ nhận ảnh PNG, JPEG, WebP hoặc GIF.');
  }
  throw new AdminError(inspected.status, inspected.code, inspected.code === 'image_empty' ? 'Chưa chọn tệp ảnh.' : 'Ảnh bị hỏng hoặc tải lên chưa trọn vẹn.');
}

const unreadable = (message = 'Không đọc được ảnh. Hãy chọn tệp khác.') => new AdminError(400, 'image_unreadable', message);

/**
 * Giải mã rồi mã hóa lại thành WebP: bỏ metadata của tệp gốc (EXIF, vị trí...), thu nhỏ theo loại ảnh, giữ chuyển động của GIF
 * và WebP động. Mọi ảnh phục vụ ra ngoài đều là WebP do máy chủ tạo, không phải byte do người tải lên gửi.
 */
export async function renderMedia(buffer, kind) {
  const { default: sharp } = await import('sharp');
  let meta;
  try {
    meta = await sharp(buffer, { animated: true, limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw unreadable();
  }
  const pages = meta.pages || 1;
  if (pages > MAX_FRAMES) throw unreadable(`Ảnh động có ${pages} khung hình, tối đa ${MAX_FRAMES}. Hãy cắt bớt rồi tải lại.`);
  if (pages > 1 && meta.width * meta.height > MAX_ANIMATED_PIXELS) {
    throw unreadable('Ảnh động quá lớn. Hãy giảm kích thước hoặc số khung hình rồi tải lại.');
  }

  let output;
  try {
    const side = MAX_SIDE[kind];
    output = await sharp(buffer, { animated: pages > 1, limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(side, side, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw unreadable();
  }
  const { data, info } = output;
  if (data.length > MAX_OUTPUT_BYTES) {
    throw unreadable('Ảnh sau khi nén vẫn quá nặng (trên 3 MB). Hãy giảm kích thước hoặc số khung hình rồi tải lại.');
  }
  return {
    data,
    width: info.width,
    height: info.pageHeight || info.height,
    bytes: data.length,
    animated: (info.pages || 1) > 1,
  };
}

export function serializeMedia(media) {
  return {
    id: media._id.toString(),
    kind: media.kind,
    name: media.name,
    active: media.active !== false,
    url: mediaUrl(media._id),
    width: media.width ?? null,
    height: media.height ?? null,
    bytes: media.bytes ?? null,
    animated: Boolean(media.animated),
    createdByLabel: media.createdByLabel || '',
    updatedByLabel: media.updatedByLabel || '',
    createdAt: media.createdAt,
    updatedAt: media.updatedAt,
  };
}

/**
 * Sticker cho màn hình kết quả: chọn ngẫu nhiên một sticker đang bật đúng loại (trúng / không trúng). Chỉ là hình trang trí, chọn
 * sau khi đã có kết quả. Chưa có sticker nào → null, giao diện dùng hình mặc định.
 */
export async function pickSticker(outcome) {
  const [sticker] = await GachaMedia.aggregate([
    { $match: { kind: outcome === 'win' ? 'win' : 'lose', active: true } },
    { $sample: { size: 1 } },
    { $project: { _id: 1, name: 1 } },
  ]);
  return sticker ? { url: mediaUrl(sticker._id), name: sticker.name } : null;
}
