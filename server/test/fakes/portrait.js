import sharp from 'sharp';

/** Ảnh chân dung giả cho kiểm thử giao diện: PNG 320×320, màu theo hue (0-360) */
export function portrait(hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="hsl(${hue},70%,78%)"/><circle cx="160" cy="125" r="62" fill="hsl(${hue},45%,35%)"/><circle cx="160" cy="335" r="125" fill="hsl(${hue},45%,35%)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
