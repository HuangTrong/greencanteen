import sharp from 'sharp';

/**
 * Ảnh chụp giả cỡ điện thoại cho kiểm thử tải ảnh: JPEG có nhiễu (khó nén) và cờ xoay EXIF. Mặc định 6000×4000 điểm ảnh lưu ngang,
 * EXIF orientation 6 → hiển thị dọc 4000×6000, tệp nặng hơn giới hạn 8 MB của máy chủ.
 */
export function bigPhoto({ width = 6000, height = 4000, orientation = 6, quality = 95 } = {}) {
  return sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .jpeg({ quality })
    .withMetadata({ orientation })
    .toBuffer();
}
