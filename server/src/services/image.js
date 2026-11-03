import crypto from 'crypto';

// Định dạng ảnh bộ nhận diện tại máy chủ giải mã được. Loại ảnh xác định từ nội dung tệp (magic bytes),
// không tin phần mở rộng hay Content-Type do client khai báo. HEIC/HEIF vẫn được nhận ra để báo lỗi rõ ràng
// (bộ giải mã đi kèm không đọc được HEVC).
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

export function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
  }
  return null;
}

/** Kiểm tra tối thiểu cấu trúc để loại tệp bị cắt cụt / hỏng trước khi gửi cho mô hình */
function looksComplete(buf, type) {
  if (type === 'image/jpeg') return buf.includes(Buffer.from([0xff, 0xd9]), 2); // có marker kết thúc ảnh (EOI)
  if (type === 'image/png') return buf.includes(Buffer.from('IEND', 'latin1'), 8);
  return buf.readUInt32LE(4) + 8 <= buf.length + 1; // WebP: kích thước RIFF khai báo khớp tệp
}

/**
 * Trả về { ok: true, mimeType } hoặc { ok: false, status, code, error } (thông báo tiếng Việt cho người dùng)
 */
export function inspectImage(buf) {
  if (!buf || buf.length === 0) {
    return { ok: false, status: 400, code: 'image_empty', error: 'Ảnh tải lên bị rỗng. Vui lòng chụp lại.' };
  }
  const mimeType = detectImageType(buf);
  if (!mimeType) {
    return {
      ok: false,
      status: 415,
      code: 'image_type_unsupported',
      error: 'Tệp không phải ảnh JPEG, PNG hoặc WebP. Vui lòng chụp hoặc chọn ảnh khác.',
    };
  }
  if (!ACCEPTED_IMAGE_TYPES.includes(mimeType)) {
    return {
      ok: false,
      status: 415,
      code: 'image_type_unsupported',
      error: 'Ảnh HEIC/HEIF chưa được hỗ trợ vì ảnh được nhận diện ngay tại máy chủ. Hãy dùng nút «Mở camera» hoặc chọn ảnh JPEG, PNG, WebP.',
    };
  }
  if (!looksComplete(buf, mimeType)) {
    return { ok: false, status: 400, code: 'image_unreadable', error: 'Ảnh bị hỏng hoặc tải lên chưa trọn vẹn. Vui lòng thử lại.' };
  }
  return { ok: true, mimeType };
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Dùng chung cho mọi nơi giải mã ảnh người dùng gửi: chặn ảnh "bom giải nén" (tệp nhỏ, kích thước khổng lồ)
export const MAX_INPUT_PIXELS = 100_000_000;
const FINGERPRINT_MAX_SIDE = 1024;

/**
 * Băm theo điểm ảnh sau khi giải mã để nhận ra cùng một ảnh dù tệp khác byte (nối thêm byte, đổi metadata, nén lại không mất dữ liệu).
 * Ảnh lớn được thu nhỏ khi giải mã nên bộ nhớ không phụ thuộc kích thước gốc. Ảnh mã hóa lại có mất dữ liệu cho điểm ảnh khác, vẫn là
 * ảnh mới: chặn được cả trường hợp đó phải so khớp gần đúng và chấp nhận chặn nhầm.
 * Không giải mã được → null, nơi gọi dùng lại băm theo byte.
 */
export async function pixelFingerprint(buffer) {
  const { default: sharp } = await import('sharp');
  try {
    const { data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(FINGERPRINT_MAX_SIDE, FINGERPRINT_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    return crypto.createHash('sha256').update(`${info.width}x${info.height}x${info.channels}:`).update(data).digest('hex');
  } catch {
    return null;
  }
}
