// A10 SSRF và lỗi phụ thuộc mạng, kiểm ở tầng socket + DNS (test/egressGuard.js) chứ không chỉ globalThis.fetch như các tệp test khác:
// mọi kết nối rời máy (fetch, http, tls, SMTP, clamd) đều bị chặn và ghi lại. Bổ sung cho security.test.js và attack-matrix.test.js,
// không lặp lại các tình huống đã có ở đó (scheme URL câu chuyện: admin-stories.test.js; nhà cung cấp OAuth trả lỗi: oauth-flow.test.js).
// Chỉ chạy local, DB in-memory, dữ liệu giả; địa chỉ "ngoài" là tên miền và dải IP dành cho tài liệu (example.*, 203.0.113.0/24).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EmailVerification } from '../../src/models/EmailVerification.js';
import { PendingSignup } from '../../src/models/PendingSignup.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { Session } from '../../src/models/Session.js';
import { Story } from '../../src/models/Story.js';
import { User } from '../../src/models/User.js';
import { blockNonLoopbackEgress } from '../egressGuard.js';
import { createClient, imageForm, realFetch, registerUser, setEnv, startTestServer, uniquePng, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV, enrolledAdmin } from '../adminHelpers.js';

let ctx;
let guard;
let admin;
const BASE_ENV = { ...ADMIN_ENV, VISION_SIMULATION: 'true' };
const client = () => createClient(ctx.base);
// Các đích do chính test chủ động gọi để chứng minh bộ chặn có tác dụng; ngoài danh sách này là kết nối ngoài ý muốn
const CONTROL_TARGETS = new Set(['example.com:443', '203.0.113.7:443', 'dns:smtp.example.net', 'oauth2.googleapis.com:443']);

/** Các lần thử ra ngoài phát sinh trong lúc chạy fn */
async function attemptsDuring(fn) {
  const start = guard.attempts.length;
  const value = await fn();
  return { value, attempts: guard.attempts.slice(start) };
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Quá thời gian chờ: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Ghi lại console.log/warn/error từ lúc gọi tới khi stop(): kiểm log của nhánh lỗi phụ thuộc không chứa email hay token */
function captureConsole() {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(args.map(String).join(' '));
  return {
    lines,
    stop() {
      Object.assign(console, saved);
      return lines.join('\n');
    },
  };
}

before(async () => {
  setEnv(BASE_ENV);
  ctx = await startTestServer();
  guard = blockNonLoopbackEgress();
  admin = await enrolledAdmin(ctx.base);
});
after(async () => {
  guard?.restore();
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv(BASE_ENV);
  await RateLimit.deleteMany({});
});

describe('bộ chặn kết nối ra ngoài (đối chứng dương)', () => {
  test('fetch và socket tới máy ngoài bị chặn trước khi phân giải DNS; API test trên 127.0.0.1 vẫn chạy', async () => {
    const { value, attempts } = await attemptsDuring(async () => ({
      fetch: await realFetch('https://example.com/').then(
        () => 'đi ra ngoài',
        (err) => err.cause?.code || err.code
      ),
      socket: await new Promise((resolve) => {
        const socket = net.connect(443, '203.0.113.7');
        socket.on('connect', () => resolve('đi ra ngoài'));
        socket.on('error', (err) => resolve(err.code));
      }),
      health: (await client().get('/api/health')).status,
    }));
    assert.deepEqual(value, { fetch: 'EGRESS_BLOCKED', socket: 'EGRESS_BLOCKED', health: 200 });
    assert.deepEqual(attempts, ['example.com:443', '203.0.113.7:443']);
  });
});

describe('A10 SSRF: URL do quản trị viên nhập không bao giờ được máy chủ tải', () => {
  // URL trỏ vào mạng nội bộ, metadata cloud hay chính máy chủ bị từ chối ngay khi lưu (SEC-04, admin-stories.test.js). Ở đây kiểm phần
  // còn lại: URL công khai được lưu và trả cho trình duyệt dạng dữ liệu, máy chủ không bao giờ tự tải
  test('ảnh và nguồn câu chuyện là URL công khai: lưu được, trả cho sinh viên, máy chủ không kết nối tới', async () => {
    await Story.deleteMany({});
    const { value: story, attempts } = await attemptsDuring(async () => {
      const created = await admin.client.post('/api/admin/stories', {
        json: {
          slug: `cong-khai-${uniqueSuffix()}`,
          title: 'Câu chuyện có ảnh ở máy khác',
          species: 'Rùa biển',
          imageUrl: 'https://images.example.org/rua-bien.jpg',
          summary: 'Tóm tắt.',
          message: 'Thông điệp.',
          source: { title: 'Bài báo', authors: ['Tác giả'], journal: 'Tạp chí', year: 2020, url: 'https://doi.example.org/10.1000/xyz' },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const publish = await admin.client.post(`/api/admin/stories/${created.data.id}/publish`, { json: { revision: created.data.revision } });
      assert.equal(publish.status, 200, JSON.stringify(publish.data));
      // Sinh viên check-in (nhận diện mô phỏng) nhận đúng câu chuyện này: máy chủ chỉ trả URL dạng dữ liệu, trình duyệt mới là nơi tải ảnh
      const student = client();
      assert.equal((await registerUser(student)).status, 201);
      const checkIn = await student.post('/api/checkin', { form: imageForm(uniquePng()) });
      assert.equal(checkIn.status, 200, JSON.stringify(checkIn.data));
      return checkIn.data.story;
    });
    assert.equal(story.imageUrl, 'https://images.example.org/rua-bien.jpg');
    assert.equal(story.source.url, 'https://doi.example.org/10.1000/xyz');
    assert.deepEqual(attempts, [], 'máy chủ không kết nối tới máy chứa ảnh hay nguồn');
  });

  test('URL trỏ vào chính máy chủ hay metadata cloud không lưu được (SEC-04)', async () => {
    const res = await admin.client.post('/api/admin/stories', {
      json: { slug: `noi-bo-${uniqueSuffix()}`, title: 'Nội bộ', imageUrl: 'https://127.0.0.1:27017/x', source: { url: 'https://169.254.169.254/latest/meta-data/' } },
    });
    assert.equal(res.status, 400);
    assert.ok(res.data.fields.imageUrl && res.data.fields['source.url']);
  });
});

describe('lỗi phụ thuộc khi mạng tới nhà cung cấp bị chặn', () => {
  const SMTP_ENV = { EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.net', SMTP_PORT: '587', EMAIL_FROM: 'GreenCanteen <no-reply@example.edu.vn>' };

  test('SMTP không tới được: quên mật khẩu vẫn trả 202 giống hệt cho email có và không có tài khoản; log không chứa email hay liên kết', async () => {
    setEnv({ ...BASE_ENV, ...SMTP_ENV });
    // Tài khoản có sẵn tạo thẳng trong DB: đăng ký qua API cần gửi được thư
    const email = `smtp${uniqueSuffix()}@example.edu.vn`;
    await User.create({ studentId: `SV${uniqueSuffix()}`, name: 'Sinh Viên SMTP', email, passwordChangedAt: new Date() });
    const unknown = `khong-co-${uniqueSuffix()}@example.edu.vn`;
    const output = captureConsole();
    let log;
    let known;
    let stranger;
    let attempts;
    try {
      ({ value: [known, stranger], attempts } = await attemptsDuring(async () => {
        const responses = [
          await client().post('/api/auth/password/forgot', { json: { email } }),
          await client().post('/api/auth/password/forgot', { json: { email: unknown } }),
        ];
        // Thư gửi sau khi đã trả lời: chờ dòng log của nhánh lỗi
        await waitFor(() => output.lines.some((line) => line.includes('Gửi email đặt lại mật khẩu thất bại')), 'nhánh lỗi gửi thư chạy xong');
        return responses;
      }));
    } finally {
      log = output.stop();
    }
    assert.equal(known.status, 202);
    assert.deepEqual(known.data, stranger.data, 'phản hồi không cho biết email nào có tài khoản');
    assert.ok(attempts.length >= 1 && attempts.every((a) => a === 'dns:smtp.example.net'), JSON.stringify(attempts));
    assert.ok(!log.includes(email) && !log.includes(unknown), 'log không chứa địa chỉ email');
    assert.doesNotMatch(log, /#reset=|#verify=/, 'log không chứa liên kết có token');
  });

  test('SMTP không tới được: đăng ký báo 502 rõ ràng, không lưu đăng ký chờ, trả lại lượt giới hạn để thử lại ngay', async () => {
    setEnv({ ...BASE_ENV, ...SMTP_ENV, AUTH_REGISTER_IP_MAX: '1', AUTH_VERIFY_EMAIL_MAX: '1' });
    const email = `dk${uniqueSuffix()}@example.edu.vn`;
    const body = { name: 'Sinh Viên Đăng Ký', studentId: `SV${uniqueSuffix()}`, email, password: 'mat-khau-an-toan-1' };
    const output = captureConsole();
    let log;
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const res = await client().post('/api/auth/register', { json: body });
        assert.equal(res.status, 502, `lần ${attempt}: ${JSON.stringify(res.data)}`);
        // Ngưỡng 1 lần: lần 2 không bị 429 nghĩa là lượt của lần 1 đã được trả lại
        assert.equal(res.data.code, 'email_send_failed', `lần ${attempt}`);
      }
    } finally {
      log = output.stop();
    }
    assert.equal(await EmailVerification.countDocuments({ email }), 0, 'thư chưa đi thì không có gì được lưu');
    assert.ok(!log.includes(email), 'log không chứa địa chỉ email');
  });

  test('OAuth: endpoint đổi code của Google không tới được → oauth_failed, không tạo phiên hay đăng ký chờ', async () => {
    setEnv({ ...BASE_ENV, GOOGLE_CLIENT_ID: 'gia-lap.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'bi-mat-gia-lap' });
    const c = client();
    const start = await c.get('/api/auth/google/start');
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const counts = async () => ({ sessions: await Session.countDocuments(), pending: await PendingSignup.countDocuments() });
    const before = await counts();
    const output = captureConsole();
    let res;
    let attempts;
    try {
      ({ value: res, attempts } = await attemptsDuring(() => c.get(`/api/auth/google/callback?code=ma-gia-lap&state=${encodeURIComponent(state)}`)));
    } finally {
      output.stop();
    }
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('location')).searchParams.get('auth_error'), 'oauth_failed');
    assert.deepEqual(attempts, ['oauth2.googleapis.com:443']);
    assert.deepEqual(await counts(), before);
    assert.equal(c.jar.has('gc_session'), false);
  });
});

describe('hành trình thường ngày không gọi ra ngoài', () => {
  test('đăng ký → check-in → quay thưởng → hồ sơ, bảng xếp hạng, thống kê, QR, passkey, CAPTCHA, khu quản trị: 0 kết nối rời máy', async () => {
    setEnv({ ...BASE_ENV, CAPTCHA_MODE: 'adaptive' });
    const { attempts } = await attemptsDuring(async () => {
      const c = client();
      assert.equal((await registerUser(c)).status, 201);
      assert.equal((await c.post('/api/checkin', { form: imageForm(uniquePng()) })).status, 200);
      const draw = await c.post('/api/gacha/draw');
      // 503 = chưa có phiên bản móc khóa nào đang hiệu lực, lượt quay được giữ
      assert.ok([200, 503].includes(draw.status), `quay thưởng: ${draw.status}`);
      for (const path of [
        '/api/auth/me',
        '/api/auth/security',
        '/api/checkin/history',
        '/api/gacha/results',
        '/api/gacha/rules',
        '/api/stats/school',
        '/api/stats/leaderboard',
        '/api/site/settings',
      ]) {
        assert.equal((await c.get(path)).status, 200, path);
      }
      assert.equal((await c.post('/api/auth/qr/start')).status, 200);
      assert.equal((await c.post('/api/auth/passkeys/login/options')).status, 200);
      assert.equal((await c.post('/api/auth/captcha')).status, 200);
      for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/stories', '/api/admin/gacha/configs', '/api/admin/audit-logs']) {
        assert.equal((await admin.client.get(path)).status, 200, path);
      }
    });
    assert.deepEqual(attempts, []);
  });

  test('tổng hợp cả tệp: mọi lần thử ra ngoài đều là đối chứng do test chủ động gọi', () => {
    assert.deepEqual(
      guard.attempts.filter((target) => !CONTROL_TARGETS.has(target)),
      [],
      `kết nối ngoài ý muốn: ${JSON.stringify(guard.attempts)}`
    );
  });
});
