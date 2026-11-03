// Kiểm thử lỗi phụ thuộc: DB lỗi giữa chừng ở từng API → 500 JSON { error, code: 'server_error' },
// không lộ thông điệp lỗi nội bộ, không ghi nhận dữ liệu dở dang.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../../src/models/User.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { QrLogin } from '../../src/models/QrLogin.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { Session } from '../../src/models/Session.js';
import { createClient, registerUser, setEnv, startTestServer } from '../helpers.js';

let ctx;
let account;
const client = () => createClient(ctx.base);
const INTERNAL = 'kết nối DB bị đứt (thông điệp nội bộ)';

before(async () => {
  setEnv();
  ctx = await startTestServer();
  const c = client();
  const { body } = await registerUser(c);
  const profile = await c.get('/api/auth/me');
  account = { c, body, id: profile.data.user.id };
});
after(() => ctx.stop());
beforeEach(() => RateLimit.deleteMany({}));

const failing = () => Promise.reject(new Error(INTERNAL));
/** Truy vấn Mongoose giả: chuỗi .sort().limit().select().lean() rồi thất bại */
const failingQuery = () => {
  const query = { sort: () => query, limit: () => query, select: () => query, lean: failing, then: (ok, ko) => failing().then(ok, ko) };
  return query;
};

async function withStub(target, method, impl, fn) {
  const original = target[method];
  const originalError = console.error;
  target[method] = impl;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    target[method] = original;
    console.error = originalError;
  }
}

function assertServerError(res, label) {
  assert.equal(res.status, 500, `${label}: status`);
  assert.equal(typeof res.data?.error, 'string', `${label}: thiếu error`);
  assert.equal(res.data.code, 'server_error', `${label}: thiếu code`);
  assert.ok(!JSON.stringify(res.data).includes(INTERNAL), `${label}: lộ lỗi nội bộ`);
}

describe('API gặp lỗi DB trả 500 JSON thống nhất', () => {
  const cases = [
    ['GET /api/stats/school', CheckIn, 'countDocuments', failing, (c) => c.get('/api/stats/school')],
    ['GET /api/stats/leaderboard', CheckIn, 'aggregate', failing, (c) => c.get('/api/stats/leaderboard?period=month')],
    ['GET /api/auth/me (xác thực phiên)', Session, 'findOne', failing, () => account.c.get('/api/auth/me')],
    ['GET /api/checkin/history', CheckIn, 'find', failingQuery, () => account.c.get('/api/checkin/history')],
    ['GET /api/gacha/rewards', GachaReward, 'find', failingQuery, () => account.c.get('/api/gacha/rewards')],
    ['POST /api/gacha/spin', User, 'findOneAndUpdate', failing, async () => {
      // Gacha checks the in-memory session user's spin count before querying MongoDB.
      // Give this account a spin so the test reaches the database operation being stubbed.
      await User.updateOne({ _id: account.id }, { $set: { pendingGachaSpins: 1 } });
      try {
        return await account.c.post('/api/gacha/spin');
      } finally {
        await User.updateOne({ _id: account.id }, { $set: { pendingGachaSpins: 0 } });
      }
    }],
    ['POST /api/auth/register', User, 'exists', failing, (c) => registerUser(c)],
    ['POST /api/auth/login', User, 'findOne', failingQuery, (c) => c.post('/api/auth/login', { json: { email: account.body.email, password: 'sai-mat-khau' } })],
    ['POST /api/auth/qr/start', QrLogin, 'create', failing, (c) => c.post('/api/auth/qr/start')],
    ['POST /api/auth/qr/poll', QrLogin, 'findOne', failing, (c) => c.post('/api/auth/qr/poll', { json: { pollToken: 'A'.repeat(43) } })],
    ['GET /api/auth/qr/challenge/:id', QrLogin, 'findOne', failing, () => account.c.get(`/api/auth/qr/challenge/${'A'.repeat(32)}`)],
    ['POST /api/auth/qr/challenge/:id/approve', QrLogin, 'exists', failing, () => account.c.post(`/api/auth/qr/challenge/${'A'.repeat(32)}/approve`)],
    ['POST /api/auth/qr/challenge/:id/reject', QrLogin, 'findOneAndUpdate', failing, () => account.c.post(`/api/auth/qr/challenge/${'A'.repeat(32)}/reject`)],
  ];
  for (const [label, model, method, impl, call] of cases) {
    test(label, async () => {
      const res = await withStub(model, method, impl, () => call(client()));
      assertServerError(res, label);
    });
  }

  test('sau sự cố, API hoạt động lại bình thường và không có dữ liệu dở dang', async () => {
    assert.equal((await account.c.get('/api/auth/me')).status, 200);
    const user = await User.findById((await account.c.get('/api/auth/me')).data.user.id).lean();
    assert.equal(user.pendingGachaSpins, 0);
    assert.equal(await GachaReward.countDocuments({ userId: user._id }), 0);
  });
});

describe('F-58: yêu cầu sai do client trả 4xx JSON, không thành lỗi server trong log', () => {
  const login = (headers, form = '{}') => (c) => c.post('/api/auth/login', { form, headers: { 'Content-Type': 'application/json', ...headers } });
  const cases = [
    ['bảng mã không hỗ trợ', 415, login({ 'Content-Type': 'application/json; charset=khong-co' })],
    ['Content-Encoding không hỗ trợ', 415, login({ 'Content-Encoding': 'khong-co' })],
    ['thân gzip hỏng', 400, login({ 'Content-Encoding': 'gzip' }, 'khong phai gzip')],
    ['tham số URL mã hóa sai ở route công khai', 400, (c) => c.get('/api/avatars/%E0%A4%A')],
    ['tham số URL mã hóa sai ở route cần đăng nhập', 400, (c) => c.get('/api/auth/qr/challenge/%E0%A4%A')],
  ];
  for (const [label, status, call] of cases) {
    test(label, async () => {
      const original = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args);
      try {
        const res = await call(client());
        assert.equal(res.status, status);
        assert.equal(res.data.code, 'bad_request');
        assert.equal(typeof res.data.error, 'string');
        assert.doesNotMatch(JSON.stringify(res.data), /stack|at .*\.js|URIError/);
      } finally {
        console.error = original;
      }
      assert.deepEqual(logged, [], 'không ghi lỗi server');
    });
  }

  test('JSON sai cú pháp và thân quá lớn vẫn giữ mã lỗi riêng', async () => {
    assert.equal((await login({}, '{sai')(client())).data.code, 'invalid_json');
    assert.equal((await login({}, JSON.stringify({ a: 'x'.repeat(200 * 1024) }))(client())).data.code, 'payload_too_large');
  });
});
