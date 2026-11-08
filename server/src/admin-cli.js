import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { parseArgs } from 'node:util';
import { countAccountData, deleteAccount, findAccountToDelete } from './services/accountDeletion.js';
import { bootstrapFirstAdmin, resetAdminMfaFromCli, resetAdminPasswordFromCli } from './services/adminBootstrap.js';
import { maskEmail } from './services/privacy.js';

dotenv.config();

/**
 * Quản trị từ dòng lệnh trên máy chủ. Đây là đường duy nhất tạo được admin đầu tiên: không có API đăng ký admin.
 *
 *   npm run admin:bootstrap -- --email <email> --name "<họ tên>" [--student-id <mã>]
 *   npm run admin:reset-mfa -- --email <email>
 *   npm run admin:reset-password -- --email <email> [--new-email <email mới>]
 *   npm run admin:delete-user -- --student-id <mã> | --email <email>
 *
 * Mật khẩu chỉ nhập qua dấu nhắc ẩn (hoặc dòng đầu của stdin khi chạy bằng script): không nhận qua tham số dòng lệnh
 * vì sẽ nằm lại trong lịch sử shell và danh sách tiến trình.
 */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => {
        data += chunk;
      });
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      stdin.on('error', reject);
      return;
    }
    stdout.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const finish = (result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      result();
    };
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(value));
        if (char === '\u0003') return finish(() => reject(new Error('Đã hủy.')));
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char;
      }
    }
    stdin.on('data', onData);
  });
}

/** Dấu nhắc ẩn không cho thấy đã gõ gì: hỏi hai lần để một lần gõ nhầm không khóa mất tài khoản */
async function readNewPassword(prompt) {
  const password = await readHidden(prompt);
  if (!process.stdin.isTTY || !password) return password;
  if ((await readHidden('Nhập lại mật khẩu: ')) !== password) throw new Error('Hai lần nhập không khớp, chưa thay đổi gì.');
  // Bộ gõ tiếng Việt đổi "aa" thành "â" mà dấu nhắc ẩn không cho thấy, rồi gõ ở trình duyệt thì không khớp
  if (/[^\x20-\x7e]/.test(password)) console.warn('Lưu ý: mật khẩu có ký tự ngoài bàn phím tiếng Anh. Nếu đang bật bộ gõ tiếng Việt, hãy tắt rồi đặt lại.');
  return password;
}

function printEnrollment({ enrollCode, expiresAt }) {
  console.log(`Mã đăng ký MFA (chỉ hiện một lần): ${enrollCode}`);
  console.log(`Hết hạn: ${expiresAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} (giờ Việt Nam).`);
  console.log('Mở /admin, đăng nhập rồi nhập mã này để gắn ứng dụng xác thực.');
}

async function bootstrap(values) {
  if (!values.email) throw new Error('Thiếu --email.');
  const password = await readNewPassword('Mật khẩu quản trị (ít nhất 12 ký tự, bỏ qua nếu nâng quyền tài khoản có sẵn): ');
  const result = await bootstrapFirstAdmin({
    email: values.email,
    name: values.name,
    studentId: values['student-id'],
    password,
  });
  console.log(result.promotedExisting ? 'Đã cấp quyền admin cho tài khoản có sẵn.' : 'Đã tạo tài khoản admin.');
  printEnrollment(result);
}

async function resetMfa(values) {
  if (!values.email) throw new Error('Thiếu --email.');
  const result = await resetAdminMfaFromCli(values.email);
  console.log('Đã xóa MFA cũ và thu hồi phiên quản trị.');
  printEnrollment(result);
}

async function resetPassword(values) {
  if (!values.email) throw new Error('Thiếu --email.');
  const password = await readNewPassword('Mật khẩu mới (ít nhất 12 ký tự): ');
  const result = await resetAdminPasswordFromCli({ email: values.email, newEmail: values['new-email'], password });
  console.log(`Đã đặt mật khẩu mới cho ${result.email} và thu hồi các phiên đăng nhập.`);
  if (result.enrollCode) printEnrollment(result);
}

/** Không hoàn tác được: in đúng tài khoản sắp xóa và bắt gõ lại mã sinh viên, gõ sai thì không xóa gì */
async function deleteUser(values) {
  const user = await findAccountToDelete({ email: values.email, studentId: values['student-id'] });
  const { checkIns, rewards } = await countAccountData(user);
  console.log(`Tài khoản: ${user.name}, mã SV ${user.studentId}, email ${maskEmail(user.email) || '(không có)'}.`);
  console.log(
    `Sẽ xóa tài khoản, ảnh đại diện, ${checkIns} lượt check-in, ${rewards} kết quả quay thưởng (gồm móc khóa chưa nhận và mã nạp demo cũ), phiên đăng nhập, passkey và 2FA. Nhật ký bảo mật được giữ lại; mã băm các ảnh đã được thưởng được giữ nhưng không còn gắn với tài khoản.`
  );
  const answer = await readHidden('Không hoàn tác được. Gõ lại mã sinh viên (ký tự không hiện ra) rồi Enter để xác nhận: ');
  if (answer.trim() !== user.studentId) throw new Error('Mã không khớp, chưa xóa gì.');
  await deleteAccount(user);
  console.log('Đã xóa tài khoản và dữ liệu gắn với tài khoản.');
}

const COMMANDS = { bootstrap, 'reset-mfa': resetMfa, 'reset-password': resetPassword, 'delete-user': deleteUser };

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      'new-email': { type: 'string' },
      name: { type: 'string' },
      'student-id': { type: 'string' },
    },
  });
  const command = COMMANDS[positionals[0]];
  if (!command) throw new Error('Lệnh hợp lệ: bootstrap, reset-mfa, reset-password, delete-user.');

  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/greencanteen';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
  try {
    await command(values);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
