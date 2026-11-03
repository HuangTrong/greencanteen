import { SystemMarker } from '../models/SystemMarker.js';
import { User } from '../models/User.js';

/**
 * Migration dữ liệu chạy lúc khởi động, trước khi nhận request. Mỗi bước phải chạy lại được nhiều lần và chỉ thêm trường,
 * không xóa dữ liệu. Mã đọc dữ liệu vẫn chấp nhận bản ghi chưa migrate nên thứ tự triển khai nhiều tiến trình không quan trọng.
 */
const MIGRATIONS = [
  {
    id: '2026-10-user-role-status',
    async run() {
      await User.updateMany({ role: { $exists: false } }, { $set: { role: 'user' } });
      await User.updateMany({ status: { $exists: false } }, { $set: { status: 'active' } });
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
