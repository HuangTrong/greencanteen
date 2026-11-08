// Ảnh check-in gửi lên máy chủ: thu nhỏ cạnh dài về tối đa MAX_SIDE và nén JPEG khi ảnh lớn. Giao diện đặt ở Vercel / Render chuyển
// tiếp /api sang máy chủ qua proxy có thể giới hạn kích thước request; ảnh nhỏ cũng tải nhanh hơn trên mạng di động. Bộ nhận diện chỉ
// dùng ảnh khoảng 320 px nên 2048 px vẫn dư thông tin. Trình duyệt không giải mã được (định dạng lạ, ảnh hỏng) thì giữ nguyên tệp gốc:
// máy chủ vẫn kiểm tra nội dung và báo lỗi như trước.
export const MAX_SIDE = 2048;
export const JPEG_QUALITY = 0.85;
// Ảnh đã nhỏ hơn MAX_SIDE và nhẹ hơn mức này thì gửi nguyên, không mã hóa lại (tránh mất chất lượng không cần thiết)
export const KEEP_ORIGINAL_BYTES = 1.5 * 1024 * 1024;
// Tệp nặng hơn mức này không giải mã trên trình duyệt (ảnh khổng lồ có thể làm điện thoại hết bộ nhớ)
export const MAX_DECODE_BYTES = 40 * 1024 * 1024;
// Định dạng máy chủ nhận; định dạng khác (vd. HEIC mà trình duyệt đọc được) luôn được chuyển sang JPEG
const SERVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Kích thước đích: cạnh dài tối đa maxSide, giữ tỉ lệ, không phóng to */
export function targetSize(width, height, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/**
 * Giải mã bằng <img>: trình duyệt hiện nay xoay ảnh theo EXIF khi vẽ lên canvas, nên ảnh gửi đi đúng chiều (bản JPEG mới không còn
 * EXIF để máy chủ xoay lần nữa).
 */
async function decodeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodeJpeg(source, width, height, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // Ảnh trong suốt → nền trắng, giống cách máy chủ xử lý
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

const jpegName = (name) => `${(name || '').replace(/\.[^./\\]*$/, '') || 'anh'}.jpg`;

/**
 * Chuẩn bị tệp để gửi. Trả { file, compressed: false } khi giữ nguyên tệp gốc, hoặc
 * { file (JPEG), compressed: true, width, height, originalBytes } khi đã nén. Không bao giờ ném lỗi.
 */
export async function prepareUpload(
  file,
  { maxSide = MAX_SIDE, quality = JPEG_QUALITY, keepBytes = KEEP_ORIGINAL_BYTES, maxDecodeBytes = MAX_DECODE_BYTES, decode = decodeImage, encode = encodeJpeg } = {}
) {
  const original = { file, compressed: false };
  if (!file || !file.size || file.size > maxDecodeBytes) return original;
  let image;
  try {
    image = await decode(file);
  } catch {
    return original;
  }
  try {
    const { width, height, scale } = targetSize(image.width, image.height, maxSide);
    const serverType = SERVER_TYPES.has(file.type);
    if (scale === 1 && serverType && file.size <= keepBytes) return original;
    const blob = await encode(image.source, width, height, quality);
    if (!blob || !blob.size) return original;
    // Không cần thu nhỏ mà bản nén lại nặng hơn → gửi bản gốc
    if (scale === 1 && serverType && blob.size >= file.size) return original;
    return { file: new File([blob], jpegName(file.name), { type: 'image/jpeg' }), compressed: true, width, height, originalBytes: file.size };
  } catch {
    return original;
  } finally {
    image.close?.();
  }
}
