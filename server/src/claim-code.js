import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  findUserByStudentId,
  generateClaimCode,
  hasCredentials,
  normalizeClaimCode,
} from './services/accounts.js';
import { hashToken } from './services/session.js';

dotenv.config();

/**
 * Cấp mã kích hoạt dùng một lần cho tài khoản cũ (tạo bằng luồng "mã SV + họ tên" trước đây).
 * Quản trị viên xác minh danh tính sinh viên (thẻ SV...) rồi mới trao mã; sinh viên nhập mã khi đăng ký
 * để gắn email/Google/Facebook vào tài khoản cũ, giữ nguyên điểm, lịch sử check-in và mã nạp.
 *
 *   npm run claim-code -- <mã sinh viên> [số giờ hiệu lực, mặc định 72]
 */
async function main() {
  const studentId = process.argv[2]?.trim();
  if (!studentId) {
    console.error('Cách dùng: npm run claim-code -- <mã sinh viên> [số giờ hiệu lực]');
    process.exit(1);
  }
  const hours = Math.min(Math.max(Number(process.argv[3]) || 72, 1), 720);

  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/greencanteen';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
  try {
    const user = await findUserByStudentId(studentId);
    if (!user) throw new Error(`Không tìm thấy tài khoản có mã sinh viên "${studentId}".`);
    if (hasCredentials(user)) {
      throw new Error('Tài khoản này đã có phương thức đăng nhập — không cần mã kích hoạt.');
    }

    const code = generateClaimCode();
    user.claimCodeHash = hashToken(normalizeClaimCode(code));
    user.claimCodeExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    await user.save();

    console.log(`Mã kích hoạt cho ${user.studentId} (${user.name}): ${code}`);
    console.log(`Hết hạn: ${user.claimCodeExpiresAt.toLocaleString('vi-VN')} — mỗi mã chỉ dùng được một lần.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
