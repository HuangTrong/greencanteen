// API cho kiểm thử hệ thống (Playwright): MongoDB in-memory RIÊNG (không bao giờ kết nối MONGODB_URI), nhận diện ảnh
// mô phỏng, email chế độ console. Thư "gửi" đi được giữ trong bộ nhớ (không in token ra log) và đọc qua hộp thư giả
// trên 127.0.0.1:E2E_MAILBOX_PORT — chỉ có trong mã test, không phải một phần của ứng dụng.
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const API_PORT = Number(process.env.E2E_API_PORT || 3101);
const MAILBOX_PORT = Number(process.env.E2E_MAILBOX_PORT || 3102);

for (const key of ['MONGODB_URI', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'SMTP_HOST']) {
  delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  VISION_SIMULATION: 'true',
  VISION_SIMULATED_CATEGORY: 'reusable_bottle',
  VISION_SIMULATED_CONFIDENCE: '0.99',
  EMAIL_TRANSPORT: 'console',
  QR_LOGIN_ENABLED: 'true',
  CHECKIN_COOLDOWN_MINUTES: '0',
  // Kịch bản check-in nhiều lần trong ngày với cùng một tài khoản: tắt trần lượt thưởng mỗi ngày (mặc định 3)
  CHECKIN_DAILY_MAX: '0',
  // Mọi kịch bản chạy từ cùng một IP 127.0.0.1
  AUTH_REGISTER_IP_MAX: '1000000',
  API_RATE_LIMIT_PER_MINUTE: '0',
  // Trình duyệt giải thật, chỉ giảm độ khó để kịch bản không phải chờ. Ngưỡng toàn cục nới rộng vì các kịch bản chạy cùng một API
  CAPTCHA_MODE: 'adaptive',
  CAPTCHA_ITERATIONS: '100',
  CAPTCHA_DIFFICULTY_BITS: '4',
  CAPTCHA_GLOBAL_FAILURES: '1000000',
  CAPTCHA_GLOBAL_MAIL: '1000000',
  CAPTCHA_IP_FAILURES: '1000000',
  CAPTCHA_ISSUE_PER_10_MINUTES: '1000000',
  CLIENT_ORIGIN: process.env.E2E_CLIENT_ORIGIN || 'http://localhost:5174',
  // Khóa sinh ngẫu nhiên mỗi lần chạy: không có bí mật cố định nào trong mã test
  ADMIN_MFA_KEY: crypto.randomBytes(32).toString('base64'),
  ANALYTICS_ENABLED: 'true',
  ANALYTICS_HASH_KEY: crypto.randomBytes(32).toString('base64'),
});

const mailbox = [];
const log = console.log;
console.log = (...args) => {
  const text = args.join(' ');
  if (text.includes('[EMAIL — chế độ console')) {
    mailbox.push({ to: text.match(/Tới: (.+)/)?.[1]?.trim(), text, at: Date.now() });
    return;
  }
  log(...args);
};

// clamd giả nói đúng giao thức: mọi ảnh trong E2E đều đi qua bước quét như khi chạy thật
const { startFakeClamd } = await import('../fakes/clamd.js');
const clamd = await startFakeClamd();
process.env.CLAMAV_HOST = '127.0.0.1';
process.env.CLAMAV_PORT = String(clamd.port);

const { createApp } = await import('../../src/app.js');
const { syncStories } = await import('../../src/services/stories.js');
const { runMigrations } = await import('../../src/services/migrations.js');
const { createMedia, publishKeychainConfig } = await import('../gachaHelpers.js');
const { issueEnrollCode } = await import('../../src/services/adminMfa.js');
const { hashPassword } = await import('../../src/services/password.js');
const { User } = await import('../../src/models/User.js');
const { AdminSession } = await import('../../src/models/AdminSession.js');

const mem = await MongoMemoryServer.create();
await mongoose.connect(mem.getUri('greencanteen-e2e'));
await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
await runMigrations();
await syncStories();
// Quay thưởng tri ân: một mẫu móc khóa trúng 100% để kịch bản E2E có kết quả xác định, kèm sticker trúng / không trúng
await publishKeychainConfig();
await createMedia('win', 'Pháo hoa E2E');
await createMedia('lose', 'Cỏ bốn lá E2E');

const api = createApp().listen(API_PORT, '127.0.0.1', () => log(`E2E API http://127.0.0.1:${API_PORT} (DB in-memory)`));

const ADMIN_PASSWORD = 'mat-khau-quan-tri-e2e';
let adminCount = 0;

/** Tài khoản admin cho từng kịch bản, kèm mã đăng ký MFA như người được cấp quyền nhận được */
async function createAdminFixture() {
  adminCount += 1;
  const id = `${Date.now().toString(36)}${adminCount}`;
  const user = await User.create({
    name: `Quản trị E2E ${adminCount}`,
    studentId: `ADMIN-E2E-${id}`,
    email: `admin-${id}@example.edu.vn`,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    passwordChangedAt: new Date(),
    role: 'admin',
  });
  const { enrollCode } = await issueEnrollCode(user._id);
  return { email: user.email, password: ADMIN_PASSWORD, enrollCode };
}

async function adminSessionsOf(email) {
  const user = await User.findOne({ email }).select('_id').lean();
  return { userId: user?._id };
}

const fixtures = {
  '/admin-fixture': createAdminFixture,
  // Làm cho lần xác thực gần nhất hết hiệu lực, để kiểm tra hộp thoại xác thực lại mà không phải chờ 5 phút
  '/expire-reauth': async (email) => {
    await AdminSession.updateMany(await adminSessionsOf(email), { $set: { reauthAt: new Date(0) } });
    return { ok: true };
  },
  // Phiên quản trị bị thu hồi / hết hạn phía server
  '/revoke-admin-sessions': async (email) => {
    await AdminSession.deleteMany(await adminSessionsOf(email));
    return { ok: true };
  },
};

const mail = http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const fixture = fixtures[url.pathname];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (fixture) return res.end(JSON.stringify(await fixture(url.searchParams.get('email'))));
    const to = url.searchParams.get('to');
    res.end(JSON.stringify(mailbox.filter((m) => !to || m.to === to)));
  })
  .listen(MAILBOX_PORT, '127.0.0.1');

async function shutdown() {
  api.close();
  mail.close();
  await clamd.close();
  await mongoose.disconnect().catch(() => {});
  await mem.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
