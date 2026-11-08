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

// Dấu gần đúng (SEC-02): dHash ngang (9×8) + dọc (8×9) trên ảnh xám = 128 bit. Đo trên 400 ảnh chụp thật (2026-11-08): bản nén lại
// JPEG 50–95, thu nhỏ một nửa, đổi sang WebP cách ảnh gốc ≤ 7 bit ở 94–99% trường hợp; 79 800 cặp ảnh khác nhau không cặp nào ≤ 16 bit
// ngoài vài ảnh trùng sẵn trong bộ dữ liệu. Cắt bớt mép ảnh làm dấu đổi nhiều nên không bắt được hết.
export const NEAR_DUPLICATE_MAX_BITS = 7;
const PHASH_BANDS = 8; // 8 dải × 16 bit: hai dấu cách ≤ 7 bit chắc chắn trùng nguyên ít nhất một dải (nguyên lý chuồng bồ câu)
// Ảnh gần như đồng màu không đủ chi tiết để so gần đúng (mọi ảnh trơn cho cùng một dấu): bỏ qua, chỉ dùng băm chính xác
const MIN_DETAIL_STDDEV = 3;

function dhashBits(gray, width, height, horizontal) {
  let bits = '';
  for (let y = 0; y < (horizontal ? height : height - 1); y += 1) {
    for (let x = 0; x < (horizontal ? width - 1 : width); x += 1) {
      const here = gray[y * width + x];
      const next = horizontal ? gray[y * width + x + 1] : gray[(y + 1) * width + x];
      bits += here > next ? '1' : '0';
    }
  }
  return bits;
}

const bitsToHex = (bits) => bits.match(/.{4}/g).map((nibble) => parseInt(nibble, 2).toString(16)).join('');

async function perceptualHash(sharp, raw, info) {
  const source = { raw: { width: info.width, height: info.height, channels: info.channels } };
  const [h, v] = await Promise.all([
    sharp(raw, source).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer(),
    sharp(raw, source).greyscale().resize(8, 9, { fit: 'fill' }).raw().toBuffer(),
  ]);
  const mean = h.reduce((sum, value) => sum + value, 0) / h.length;
  const stddev = Math.sqrt(h.reduce((sum, value) => sum + (value - mean) ** 2, 0) / h.length);
  if (stddev < MIN_DETAIL_STDDEV) return null;
  const hash = bitsToHex(dhashBits(h, 9, 8, true) + dhashBits(v, 8, 9, false));
  const width = hash.length / PHASH_BANDS;
  return { hash, bands: Array.from({ length: PHASH_BANDS }, (_, i) => `${i}:${hash.slice(i * width, (i + 1) * width)}`) };
}

/** Số bit khác nhau giữa hai dấu gần đúng (chuỗi hex cùng độ dài) */
export function hammingDistance(a, b) {
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/**
 * Nhận dạng ảnh sau một lần giải mã:
 * - exact: băm theo điểm ảnh, nhận ra cùng một ảnh dù tệp khác byte (nối thêm byte, đổi metadata, nén lại không mất dữ liệu);
 * - perceptual: dấu gần đúng 128 bit để nhận ra ảnh đã nén lại có mất dữ liệu, thu nhỏ hay đổi định dạng; null khi ảnh quá ít chi tiết.
 * Ảnh lớn được thu nhỏ khi giải mã nên bộ nhớ không phụ thuộc kích thước gốc. Không giải mã được → null, nơi gọi dùng băm theo byte.
 */
export async function imageFingerprints(buffer) {
  const { default: sharp } = await import('sharp');
  try {
    const { data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(FINGERPRINT_MAX_SIDE, FINGERPRINT_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const exact = crypto.createHash('sha256').update(`${info.width}x${info.height}x${info.channels}:`).update(data).digest('hex');
    return { exact, perceptual: await perceptualHash(sharp, data, info) };
  } catch {
    return null;
  }
}

/** Chỉ băm theo điểm ảnh (giữ cho nơi gọi cũ) */
export async function pixelFingerprint(buffer) {
  return (await imageFingerprints(buffer))?.exact ?? null;
}
