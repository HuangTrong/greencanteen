import { GachaConfig } from '../models/GachaConfig.js';
import { SystemMarker } from '../models/SystemMarker.js';
import { User } from '../models/User.js';
import { GACHA_PRIZE_TYPE } from './gacha.js';

/**
 * Migration dữ liệu chạy lúc khởi động, trước khi nhận request. Mỗi bước phải chạy lại được nhiều lần và không xóa dữ liệu.
 * Mã đọc dữ liệu vẫn chấp nhận bản ghi chưa migrate nên thứ tự triển khai nhiều tiến trình không quan trọng.
 */
const MIGRATIONS = [
  {
    id: '2026-10-user-role-status',
    async run() {
      await User.updateMany({ role: { $exists: false } }, { $set: { role: 'user' } });
      await User.updateMany({ status: { $exists: false } }, { $set: { status: 'active' } });
    },
  },
  {
    // Quay thưởng tri ân thay mã nạp demo bằng móc khóa: phiên bản cũ còn giải mã nạp đang (hoặc sắp) hiệu lực được ngừng như khi quản
    // trị viên bấm "Ngừng hiệu lực". Không xóa phiên bản, kết quả hay mã đã phát; quay thưởng tạm dừng tới khi có phiên bản móc khóa
    id: '2026-11-gacha-keychain',
    async run() {
      const now = new Date();
      await GachaConfig.updateMany(
        {
          status: 'published',
          prizes: { $elemMatch: { prizeType: { $ne: GACHA_PRIZE_TYPE } } },
          $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
        },
        { $set: { effectiveTo: now, endedByLabel: 'hệ thống (chuyển sang móc khóa)' }, $inc: { __v: 1 } }
      );
    },
  },
];

export async function runMigrations() {
  const applied = [];
  for (const { id, run } of MIGRATIONS) {
    const marker = `migration:${id}`;
    if (await SystemMarker.exists({ _id: marker })) continue;
    await run();
    try {
      await SystemMarker.create({ _id: marker });
    } catch (err) {
      if (Number(err?.code) !== 11000) throw err; // tiến trình khác vừa chạy xong cùng bước này
    }
    applied.push(id);
  }
  return applied;
}
