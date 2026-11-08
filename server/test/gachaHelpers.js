// Dữ liệu mẫu cho quay thưởng tri ân: ảnh nhỏ tạo bằng sharp, mẫu móc khóa, phiên bản đã xuất bản ghi thẳng vào DB
import sharp from 'sharp';
import { GachaConfig } from '../src/models/GachaConfig.js';
import { GachaMedia } from '../src/models/GachaMedia.js';

export const pngImage = (color = { r: 34, g: 197, b: 94 }, size = 16) =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();

/** GIF động 3 khung hình */
export async function animatedGif() {
  const frames = await Promise.all(
    [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ].map(([r, g, b]) => pngImage({ r, g, b }, 24))
  );
  return sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100, 100], loop: 0 }).toBuffer();
}

/** Ảnh có sẵn trong thư viện, ghi thẳng DB (không qua API tải lên) */
export async function createMedia(kind = 'keychain', name = 'Móc khóa lá xanh', active = true) {
  const data = await sharp(await pngImage()).webp().toBuffer();
  return GachaMedia.create({ kind, name, active, data, width: 16, height: 16, bytes: data.length });
}

export const keychain = (overrides = {}) => ({
  prizeId: 'la-xanh',
  label: 'Lá xanh',
  description: '',
  probabilityPpm: 1_000_000,
  enabled: true,
  maxQuantity: 100,
  ...overrides,
});

/** Phiên bản móc khóa đã xuất bản, hiệu lực ngay (ghi thẳng DB, không cần khu quản trị) */
export async function publishKeychainConfig({
  prizes = [keychain()],
  claimInstructions = 'Nhận tại quầy căn tin tầng 1, 11h-13h, mang mã nhận quà.',
  effectiveFrom = new Date(Date.now() - 1000),
  effectiveTo = null,
} = {}) {
  const image = await createMedia();
  const latest = await GachaConfig.findOne().sort({ version: -1 }).select('version').lean();
  return GachaConfig.create({
    version: (latest?.version || 0) + 1,
    status: 'published',
    prizes: prizes.map((prize) => ({ prizeType: 'keychain', imageId: image._id, ...prize })),
    claimInstructions,
    effectiveFrom,
    effectiveTo,
    publishedByLabel: 'kiểm thử',
    publishedAt: new Date(),
  });
}

/** Phiên bản mã nạp demo cũ (dữ liệu trước khi đổi sang móc khóa) */
export function legacyTopUpConfig(overrides = {}) {
  return GachaConfig.collection.insertOne({
    version: 1,
    status: 'published',
    prizes: [{ prizeId: 'topup-10k-viettel', label: 'Mã nạp điện thoại', prizeType: 'phone_topup', carrier: 'Viettel', amountVnd: 10_000, probabilityPpm: 1_000_000, enabled: true, maxQuantity: null }],
    budgetVnd: null,
    effectiveFrom: new Date(0),
    effectiveTo: null,
    note: '',
    __v: 0,
    ...overrides,
  });
}
