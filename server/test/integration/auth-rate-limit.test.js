// F-04: giới hạn theo IP cho đăng nhập sai rải nhiều email và đăng ký hàng loạt. Biên ngưỡng, hết cửa sổ, đồng thời, NAT trường học,
// giả mạo X-Forwarded-For, không lộ email tồn tại, bộ đếm lỗi thì từ chối (không bỏ qua). Ngưỡng mặc định kiểm ở security.test.js.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { EmailVerification } from '../../src/models/EmailVerification.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { User } from '../../src/models/User.js';
import { hashPassword } from '../../src/services/password.js';
import { createClient, registerUser, setEnv, startTestServer, submitRegistration, uniqueSuffix } from '../helpers.js';

let ctx;
const client = () => createClient(ctx.base);
const stranger = () => `la-${uniqueSuffix()}@example.edu.vn`;
const WRONG = 'sai-mat-khau-123';
const login = (c, email, password = WRONG, opts = {}) => c.post('/api/auth/login', { json: { email, password }, ...opts });
const counter = (name) => RateLimit.findOne({ key: new RegExp(`^${name}:`) }).lean();

before(async () => {
  setEnv();
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv();
  await RateLimit.deleteMany({});
});

/** App riêng để đọc TRUST_PROXY lúc tạo: có `TRUST_PROXY=loopback` thì test giả làm reverse proxy, tự chọn IP của "học sinh" */
async function startApp(trustProxy) {
  setEnv({ TRUST_PROXY: trustProxy });
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });

describe('đăng nhập sai rải nhiều email từ một IP', () => {
  test('biên: đúng N lần sai với N email khác nhau vẫn được chấm; lần N+1 bị chặn, kể cả mật khẩu đúng', async () => {
    const { body } = await registerUser(client());
    setEnv({ AUTH_LOGIN_IP_MAX: '3' });
    const c = client();
    for (let i = 0; i < 3; i += 1) assert.equal((await login(c, stranger())).status, 401, `lần ${i + 1}`);
    const blocked = await login(c, body.email, body.password);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, 'too_many_attempts');
    assert.ok(!c.jar.has('gc_session'));
  });

  test('đã vượt ngưỡng: từ chối trước khi băm mật khẩu, không tốn CPU scrypt', async () => {
    setEnv({ AUTH_LOGIN_IP_MAX: '1' });
    const c = client();
    await login(c, stranger());
    const started = performance.now();
    await hashPassword('mot-lan-bam-de-so-sanh');
    const hashMs = performance.now() - started;
    const again = performance.now();
    assert.equal((await login(c, stranger())).status, 429);
    assert.ok(performance.now() - again < hashMs, 'nhanh hơn một lần băm');
  });

  test('hết cửa sổ: được chấm lại và đếm từ đầu', async () => {
    setEnv({ AUTH_LOGIN_IP_MAX: '2' });
    const c = client();
    await login(c, stranger());
    await login(c, stranger());
    assert.equal((await login(c, stranger())).status, 429);
    await RateLimit.updateOne({ key: /^login-fail-ip:/ }, { $set: { resetAt: new Date(Date.now() - 1) } });
    assert.equal((await login(c, stranger())).status, 401);
    assert.equal((await counter('login-fail-ip')).count, 1);
  });

  test('cửa sổ cấu hình được qua AUTH_LOGIN_IP_WINDOW_MINUTES', async () => {
    setEnv({ AUTH_LOGIN_IP_WINDOW_MINUTES: '2' });
    await login(client(), stranger());
    const remainingMs = (await counter('login-fail-ip')).resetAt - Date.now();
    assert.ok(remainingMs > 110_000 && remainingMs <= 120_000, `${remainingMs} ms`);
  });

  test('đồng thời: N+5 yêu cầu sai cùng lúc chỉ N yêu cầu được chấm', async () => {
    setEnv({ AUTH_LOGIN_IP_MAX: '4' });
    const c = client();
    const results = await Promise.all(Array.from({ length: 9 }, () => login(c, stranger())));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429, 429, 429, 429]);
  });

  test('bộ đếm nằm trong MongoDB: app khác trên cùng DB (tiến trình thứ hai, sau khởi động lại) vẫn thấy giới hạn', async () => {
    setEnv({ AUTH_LOGIN_IP_MAX: '2' });
    await login(client(), stranger());
    await login(client(), stranger());
    const second = await startApp('');
    try {
      setEnv({ AUTH_LOGIN_IP_MAX: '2' });
      assert.equal((await login(createClient(second.base), stranger())).status, 429);
    } finally {
      await second.close();
    }
  });

  test('giới hạn theo email vẫn còn: đồng thời nhiều lần sai một email chỉ 10 lần được chấm', async () => {
    const email = stranger();
    const results = await Promise.all(Array.from({ length: 13 }, () => login(client(), email)));
    assert.equal(results.filter((r) => r.status === 401).length, 10);
    assert.equal(results.filter((r) => r.status === 429).length, 3);
  });
});

describe('NAT trường học: nhiều học sinh dùng chung một IP', () => {
  test('đăng nhập đúng không tiêu ngân sách của IP dù nhiều hơn ngưỡng', async () => {
    const accounts = [];
    for (let i = 0; i < 4; i += 1) accounts.push((await registerUser(client())).body);
    setEnv({ AUTH_LOGIN_IP_MAX: '2' });
    for (let round = 0; round < 2; round += 1) {
      for (const { email, password } of accounts) assert.equal((await login(client(), email, password)).status, 200);
    }
    assert.equal((await counter('login-fail-ip'))?.count ?? 0, 0);
  });

  test('học sinh gõ nhầm rồi đăng nhập đúng: lần sai vẫn được tính, lần đúng không bị tính thêm', async () => {
    const { body } = await registerUser(client());
    setEnv({ AUTH_LOGIN_IP_MAX: '5' });
    assert.equal((await login(client(), body.email)).status, 401);
    assert.equal((await login(client(), body.email, body.password)).status, 200);
    assert.equal((await counter('login-fail-ip')).count, 1);
  });

  test('sai dưới ngưỡng từ nhiều bạn cùng lớp không làm người khác bị chặn', async () => {
    const { body } = await registerUser(client());
    setEnv({ AUTH_LOGIN_IP_MAX: '5' });
    for (let i = 0; i < 4; i += 1) assert.equal((await login(client(), stranger())).status, 401);
    assert.equal((await login(client(), body.email, body.password)).status, 200);
  });

  test('IP bị chặn chỉ mất đăng nhập mật khẩu: phiên đang mở và tạo mã QR vẫn dùng được', async () => {
    const student = client();
    await registerUser(student);
    setEnv({ AUTH_LOGIN_IP_MAX: '1' });
    await login(client(), stranger());
    assert.equal((await login(client(), stranger())).status, 429);
    assert.equal((await student.get('/api/auth/me')).status, 200);
    assert.equal((await client().post('/api/auth/qr/start')).status, 200);
  });

  test('thông báo khi IP bị chặn nêu rõ là do cả mạng và chỉ cách đăng nhập khác', async () => {
    setEnv({ AUTH_LOGIN_IP_MAX: '1', AUTH_LOGIN_IP_WINDOW_MINUTES: '20' });
    await login(client(), stranger());
    const blocked = await login(client(), stranger());
    assert.match(blocked.data.error, /mạng/i);
    assert.match(blocked.data.error, /20 phút/);
    assert.match(blocked.data.error, /QR/);
  });

  test('IP khác không bị ảnh hưởng', async () => {
    const proxied = await startApp('loopback');
    try {
      setEnv({ TRUST_PROXY: 'loopback', AUTH_LOGIN_IP_MAX: '2' });
      const c = createClient(proxied.base);
      await login(c, stranger(), WRONG, from('203.0.113.1'));
      await login(c, stranger(), WRONG, from('203.0.113.1'));
      assert.equal((await login(c, stranger(), WRONG, from('203.0.113.1'))).status, 429);
      assert.equal((await login(c, stranger(), WRONG, from('203.0.113.2'))).status, 401);
    } finally {
      await proxied.close();
    }
  });
});

describe('không lộ email nào tồn tại qua giới hạn', () => {
  test('email có tài khoản và email lạ: phản hồi giống hệt nhau tại và sau ngưỡng theo email', async () => {
    const { body } = await registerUser(client());
    const unknown = stranger();
    const proxied = await startApp('loopback');
    try {
      const c = createClient(proxied.base);
      for (let i = 0; i < 11; i += 1) {
        // Mỗi cặp từ một IP riêng để chỉ có giới hạn theo email tác động
        const known = await login(c, body.email, WRONG, from(`203.0.113.${i + 1}`));
        const other = await login(c, unknown, WRONG, from(`198.51.100.${i + 1}`));
        assert.equal(known.status, other.status, `lần ${i + 1}`);
        assert.deepEqual(known.data, other.data, `lần ${i + 1}`);
      }
    } finally {
      await proxied.close();
    }
  });

  test('email có tài khoản và email lạ: phản hồi giống hệt nhau tại và sau ngưỡng theo IP', async () => {
    const { body } = await registerUser(client());
    const proxied = await startApp('loopback');
    try {
      setEnv({ TRUST_PROXY: 'loopback', AUTH_LOGIN_IP_MAX: '2' });
      const c = createClient(proxied.base);
      for (let i = 0; i < 3; i += 1) {
        const known = await login(c, body.email, WRONG, from('203.0.113.7'));
        const other = await login(c, stranger(), WRONG, from('203.0.113.8'));
        assert.equal(known.status, other.status, `lần ${i + 1}`);
        assert.deepEqual(known.data, other.data, `lần ${i + 1}`);
      }
    } finally {
      await proxied.close();
    }
  });

  test('đăng ký bị giới hạn: email có tài khoản và email mới cùng nhận 429 giống hệt', async () => {
    const { body } = await registerUser(client());
    setEnv({ AUTH_REGISTER_IP_MAX: '1' });
    await submitRegistration(client());
    const known = await submitRegistration(client(), { email: body.email });
    const fresh = await submitRegistration(client());
    assert.equal(known.status, 429);
    assert.equal(fresh.status, 429);
    assert.deepEqual(known.data, fresh.data);
  });
});

describe('req.ip và TRUST_PROXY', () => {
  test('mặc định không tin proxy: X-Forwarded-For giả không vượt được giới hạn', async () => {
    setEnv({ AUTH_LOGIN_IP_MAX: '2' });
    const c = client();
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await login(c, stranger(), WRONG, from(`10.9.8.${i + 1}`))).status);
    assert.deepEqual(statuses, [401, 401, 429, 429]);
    assert.equal(await RateLimit.countDocuments({ key: /^login-fail-ip:10\.9\.8\./ }), 0);
  });

  for (const [label, value] of [
    ['TRUST_PROXY=true (tin mọi nguồn) bị coi là cấu hình sai', 'true'],
    ['TRUST_PROXY=* bị coi là cấu hình sai', '*'],
    ['TRUST_PROXY=0.0.0.0/0 bị coi là cấu hình sai', '0.0.0.0/0'],
    ['danh sách có lẫn dải tin mọi nguồn', 'loopback, ::/0'],
    ['proxy khai báo khác máy đang kết nối', '10.0.0.5'],
  ]) {
    test(`${label}: X-Forwarded-For giả không vượt được giới hạn`, async () => {
      const originalError = console.error;
      console.error = () => {};
      const app = await startApp(value);
      console.error = originalError;
      try {
        setEnv({ TRUST_PROXY: value, AUTH_LOGIN_IP_MAX: '2' });
        const c = createClient(app.base);
        const statuses = [];
        for (let i = 0; i < 4; i += 1) statuses.push((await login(c, stranger(), WRONG, from(`172.16.5.${i + 1}`))).status);
        assert.deepEqual(statuses, [401, 401, 429, 429]);
      } finally {
        await app.close();
      }
    });
  }

  test('TRUST_PROXY=1: chỉ lấy địa chỉ do proxy gần nhất thêm, phần client tự gửi phía trước bị bỏ qua', async () => {
    const app = await startApp('1');
    try {
      setEnv({ TRUST_PROXY: '1', AUTH_LOGIN_IP_MAX: '2' });
      const c = createClient(app.base);
      const statuses = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await login(c, stranger(), WRONG, from(`8.8.8.${i + 1}, 203.0.113.50`))).status);
      assert.deepEqual(statuses, [401, 401, 429, 429]);
      assert.equal((await RateLimit.findOne({ key: 'login-fail-ip:203.0.113.50' }).lean()).count, 4);
    } finally {
      await app.close();
    }
  });

  test('proxy tin cậy theo địa chỉ: mỗi học sinh sau proxy có bộ đếm riêng, khóa theo IPv6 gộp theo /64', async () => {
    const app = await startApp('loopback');
    try {
      setEnv({ TRUST_PROXY: 'loopback', AUTH_LOGIN_IP_MAX: '2' });
      const c = createClient(app.base);
      const statuses = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await login(c, stranger(), WRONG, from(`2001:db8:abcd:12::${(i + 1).toString(16)}`))).status);
      assert.deepEqual(statuses, [401, 401, 429], 'đổi địa chỉ trong cùng /64 không vượt được giới hạn');
      assert.equal((await login(c, stranger(), WRONG, from('2001:db8:abcd:13::1'))).status, 401);
    } finally {
      await app.close();
    }
  });
});

describe('đăng ký hàng loạt từ một IP', () => {
  test('biên: N lần được nhận, lần N+1 bị chặn, không gửi thư, không lưu đăng ký', async () => {
    setEnv({ AUTH_REGISTER_IP_MAX: '3' });
    await EmailVerification.deleteMany({});
    for (let i = 0; i < 3; i += 1) assert.equal((await submitRegistration(client())).status, 202, `lần ${i + 1}`);
    const blocked = await submitRegistration(client());
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, 'too_many_attempts');
    assert.equal(blocked.mail, null, 'không gửi thư');
    assert.equal(await EmailVerification.countDocuments(), 3);
  });

  test('hết cửa sổ: đăng ký lại được; cửa sổ cấu hình được', async () => {
    setEnv({ AUTH_REGISTER_IP_MAX: '1', AUTH_REGISTER_IP_WINDOW_MINUTES: '3' });
    assert.equal((await submitRegistration(client())).status, 202);
    assert.equal((await submitRegistration(client())).status, 429);
    const remainingMs = (await counter('register-ip')).resetAt - Date.now();
    assert.ok(remainingMs > 170_000 && remainingMs <= 180_000, `${remainingMs} ms`);
    await RateLimit.updateOne({ key: /^register-ip:/ }, { $set: { resetAt: new Date(Date.now() - 1) } });
    assert.equal((await submitRegistration(client())).status, 202);
  });

  test('dữ liệu sai không tốn lượt của cả mạng: bạn gõ thiếu ở lớp bên cạnh không chặn người khác', async () => {
    setEnv({ AUTH_REGISTER_IP_MAX: '2' });
    for (let i = 0; i < 6; i += 1) assert.equal((await submitRegistration(client(), { password: 'ngan' })).status, 400);
    assert.equal((await submitRegistration(client())).status, 202);
    assert.equal((await submitRegistration(client())).status, 202);
  });

  test('đồng thời: N+5 yêu cầu cùng lúc chỉ N được nhận', async () => {
    setEnv({ AUTH_REGISTER_IP_MAX: '3' });
    await EmailVerification.deleteMany({});
    const results = await Promise.all(Array.from({ length: 8 }, () => submitRegistration(client())));
    assert.deepEqual(results.map((r) => r.status).sort(), [202, 202, 202, 429, 429, 429, 429, 429]);
    assert.equal(await EmailVerification.countDocuments(), 3);
    assert.equal(await User.countDocuments({ email: { $in: results.map((r) => r.body.email) } }), 0);
  });

  test('hoàn tất đăng ký qua Google/Facebook cũng tính vào giới hạn theo IP', async () => {
    const { PendingSignup } = await import('../../src/models/PendingSignup.js');
    const { hashToken } = await import('../../src/services/session.js');
    setEnv({ AUTH_REGISTER_IP_MAX: '1' });
    const c = client();
    const token = `pending-${uniqueSuffix()}`;
    await PendingSignup.create({ tokenHash: hashToken(token), provider: 'google', providerId: `g-${uniqueSuffix()}`, name: 'Bạn Google', expiresAt: new Date(Date.now() + 60_000) });
    c.jar.set('gc_signup', encodeURIComponent(token));
    const first = await c.post('/api/auth/signup/complete', { json: { name: '', studentId: '' } });
    assert.equal(first.status, 400, 'dữ liệu sai không tính');
    const taken = await registerTaken(c);
    assert.equal(taken.status, 409, 'mã SV đã có: tính một lượt');
    const blocked = await c.post('/api/auth/signup/complete', { json: { name: 'Bạn Google', studentId: `G${uniqueSuffix()}` } });
    assert.equal(blocked.status, 429);
  });

  async function registerTaken(c) {
    const limit = process.env.AUTH_REGISTER_IP_MAX;
    process.env.AUTH_REGISTER_IP_MAX = '1000000';
    const { body } = await registerUser(client());
    process.env.AUTH_REGISTER_IP_MAX = limit;
    await RateLimit.deleteMany({ key: /^register-ip:/ });
    return c.post('/api/auth/signup/complete', { json: { name: 'Bạn Google', studentId: body.studentId } });
  }
});

describe('bộ đếm lỗi: từ chối, không bỏ qua biện pháp bảo vệ', () => {
  const INTERNAL = 'E11000 dup key: { key: "login-fail:nan-nhan@example.edu.vn" } tại mongodb://noi-bo:27017';

  async function withBrokenCounter(fn) {
    const originals = { findOne: RateLimit.findOne, findOneAndUpdate: RateLimit.findOneAndUpdate };
    const originalError = console.error;
    const logs = [];
    const broken = () => {
      const query = { lean: () => Promise.reject(new Error(INTERNAL)), then: (ok, ko) => Promise.reject(new Error(INTERNAL)).then(ok, ko) };
      return query;
    };
    RateLimit.findOne = broken;
    RateLimit.findOneAndUpdate = broken;
    console.error = (...args) => logs.push(args.join(' '));
    try {
      return { res: await fn(), logs };
    } finally {
      Object.assign(RateLimit, originals);
      console.error = originalError;
    }
  }

  function assertSafeFailure({ res, logs }) {
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'rate_limit_unavailable');
    assert.ok(!JSON.stringify(res.data).includes('mongodb'), 'không lộ chi tiết DB');
    assert.ok(!JSON.stringify(res.data).includes('E11000'), 'không lộ chi tiết DB');
    assert.ok(logs.length > 0, 'có ghi log cho người vận hành');
    assert.ok(logs.every((line) => !line.includes('nan-nhan@example.edu.vn')), 'log không chứa email');
  }

  test('đăng nhập: mật khẩu đúng vẫn bị từ chối, không có phiên', async () => {
    const { body } = await registerUser(client());
    const c = client();
    const result = await withBrokenCounter(() => login(c, body.email, body.password));
    assertSafeFailure(result);
    assert.ok(!c.jar.has('gc_session'));
  });

  test('đăng ký: không gửi thư, không lưu đăng ký, không tạo tài khoản', async () => {
    await EmailVerification.deleteMany({});
    const result = await withBrokenCounter(() => submitRegistration(client()));
    assertSafeFailure(result);
    assert.equal(result.res.mail, null);
    assert.equal(await EmailVerification.countDocuments(), 0);
    assert.equal(await User.countDocuments({ email: result.res.body.email }), 0);
  });

  test('gửi lại thư xác minh và xác minh token cũng từ chối khi bộ đếm lỗi', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console' });
    assertSafeFailure(await withBrokenCounter(() => client().post('/api/auth/email/resend', { json: { email: stranger() } })));
    assertSafeFailure(await withBrokenCounter(() => client().post('/api/auth/email/verify', { json: { token: 'A'.repeat(43), password: 'bat-ky-mat-khau' } })));
  });

  test('sau sự cố hoạt động lại bình thường', async () => {
    const { body } = await registerUser(client());
    await withBrokenCounter(() => login(client(), body.email, body.password));
    assert.equal((await login(client(), body.email, body.password)).status, 200);
  });
});

describe('F-52: đổi mật khẩu — gửi đồng thời không vượt được giới hạn thử', () => {
  const change = (c, currentPassword, newPassword = 'mat-khau-moi-an-toan-9') => c.post('/api/auth/password/change', { json: { currentPassword, newPassword } });

  test('phiên bị đánh cắp: 12 mật khẩu sai cùng lúc chỉ 5 lần được chấm', async () => {
    const c = client();
    await registerUser(c);
    const results = await Promise.all(Array.from({ length: 12 }, () => change(c, WRONG)));
    assert.equal(results.filter((res) => res.data.code === 'invalid_current_password').length, 5);
    assert.equal(results.filter((res) => res.status === 429).length, 7);
  });

  test('mật khẩu mới không đạt yêu cầu không tiêu lượt thử; mật khẩu mới trùng mật khẩu cũ trả lại lượt', async () => {
    const c = client();
    const { body } = await registerUser(c);
    for (let i = 0; i < 6; i += 1) assert.equal((await change(c, WRONG, 'ngan')).status, 400);
    for (let i = 0; i < 6; i += 1) assert.equal((await change(c, body.password, body.password)).status, 400);
    assert.equal((await change(c, body.password)).status, 200);
  });
});

describe('F-57: mọi giới hạn theo IP gộp IPv6 theo mạng /64', () => {
  const KEY = crypto.randomBytes(32).toString('base64');
  const expectOneBucket = async (name) => {
    const buckets = await RateLimit.find({ key: new RegExp(`^${name}:`) }).lean();
    assert.equal(buckets.length, 1, `${name}: ${buckets.map((bucket) => bucket.key).join(', ')}`);
    assert.equal(buckets[0].key, `${name}:2001:db8:1:2::/64`);
    assert.equal(buckets[0].count, 2);
  };

  for (const [name, send] of [
    ['qr-start-ip', (c, opts) => c.post('/api/auth/qr/start', opts)],
    ['admin-login-ip', (c, opts) => c.post('/api/admin/auth/login', { json: { email: stranger(), password: WRONG }, ...opts })],
    ['analytics-ip', (c, opts) => c.post('/api/analytics/events', { json: { type: 'page_view', page: 'home', visitId: 'a'.repeat(16) }, ...opts })],
  ]) {
    test(`${name}: đổi địa chỉ trong cùng dải /64 không thoát giới hạn`, async () => {
      const app = await startApp('loopback');
      Object.assign(process.env, { ADMIN_MFA_KEY: KEY, ANALYTICS_ENABLED: 'true' });
      try {
        const c = createClient(app.base);
        await send(c, from('2001:db8:1:2::1'));
        await send(c, from('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
        await expectOneBucket(name);
      } finally {
        await app.close();
      }
    });
  }
});

describe('F-76: mã kích hoạt và xác minh đăng ký — gửi đồng thời không vượt được giới hạn thử', () => {
  test('mã kích hoạt sai gửi cùng lúc chỉ 10 lần được chấm', async () => {
    const studentId = `CU${uniqueSuffix()}`;
    await User.create({ name: 'Tài Khoản Cũ', studentId });
    const pending = [];
    for (let i = 0; i < 25; i += 1) {
      const { token, body } = await submitRegistration(client(), { studentId });
      pending.push({ token, password: body.password });
    }
    const results = await Promise.all(pending.map(({ token, password }) => client().post('/api/auth/email/verify', { json: { token, password, claimCode: 'AAAA-BBBB-CCCC' } })));
    assert.equal(results.filter((res) => res.data.code === 'invalid_claim_code').length, 10);
    assert.equal(results.filter((res) => res.status === 429).length, 15);
  });

  test('giữ liên kết nhưng dò mật khẩu đã đặt: gửi đồng thời vẫn dừng ở ngưỡng theo IP', async () => {
    setEnv({ AUTH_LOGIN_IP_MAX: '5' });
    const { token, body } = await submitRegistration(client());
    const results = await Promise.all(Array.from({ length: 12 }, () => client().post('/api/auth/email/verify', { json: { token, password: `${body.password}-sai` } })));
    assert.equal(results.filter((res) => res.data.code === 'invalid_password').length, 5);
    assert.equal(results.filter((res) => res.status === 429).length, 7);
  });

  test('kích hoạt đúng không tiêu ngân sách của cả mạng', async () => {
    setEnv({ AUTH_LOGIN_IP_MAX: '2' });
    for (let i = 0; i < 4; i += 1) {
      const c = client();
      const { token, body } = await submitRegistration(c);
      assert.equal((await c.post('/api/auth/email/verify', { json: { token, password: body.password } })).status, 201);
    }
  });
});
