// CAPTCHA tự chứa kiểu proof-of-work: chỉ đòi khi có dấu hiệu bất thường, không gọi dịch vụ ngoài. Lời giải dùng đúng một lần,
// sai hay hết hạn đều bị từ chối, và việc bị đòi CAPTCHA không cho biết email có tài khoản hay không.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CaptchaChallenge } from '../../src/models/CaptchaChallenge.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { hashToken } from '../../src/services/session.js';
import { createClient, realFetch, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';

const FAST = { CAPTCHA_MODE: 'adaptive', CAPTCHA_ITERATIONS: '10', CAPTCHA_DIFFICULTY_BITS: '2', EMAIL_TRANSPORT: 'console' };
const WRONG = 'sai-mat-khau-123';

// Email kiểu console in cả liên kết xác minh: lọc đi để token không nằm trong log test
const consoleLog = console.log;
console.log = (...args) => {
  if (!String(args[0]).includes('[EMAIL — chế độ console')) consoleLog(...args);
};

let ctx;
let outbound;
const client = () => createClient(ctx.base);
const stranger = () => `la-${uniqueSuffix()}@example.edu.vn`;
const login = (c, email, password = WRONG, extra = {}) => c.post('/api/auth/login', { json: { email, password, ...extra } });

const leadingZeroBits = (bytes) => {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
};

/** Giải như trình duyệt: PBKDF2 trên từng nonce tới khi đủ số bit 0 đầu */
function solve({ challenge, iterations, bits }) {
  for (let nonce = 0; ; nonce += 1) {
    const derived = crypto.pbkdf2Sync(String(nonce), challenge, iterations, 32, 'sha256');
    if (leadingZeroBits(derived) >= bits) return { challenge, nonce: String(nonce) };
  }
}

/** Nonce cố tình sai: chuỗi băm không đủ số bit 0 đầu */
function wrongSolution({ challenge, iterations, bits }) {
  for (let nonce = 0; ; nonce += 1) {
    const derived = crypto.pbkdf2Sync(String(nonce), challenge, iterations, 32, 'sha256');
    if (leadingZeroBits(derived) < bits) return { challenge, nonce: String(nonce) };
  }
}

const newChallenge = async (c = client()) => {
  const res = await c.post('/api/auth/captcha');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
};

before(async () => {
  setEnv(FAST);
  ctx = await startTestServer();
  outbound = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    outbound.push(String(url));
    throw new Error('Chặn request ra ngoài trong test');
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv(FAST);
  await Promise.all([RateLimit.deleteMany({}), CaptchaChallenge.deleteMany({})]);
});

describe('chế độ thích ứng khi đăng nhập', () => {
  test('sai dưới ngưỡng không bị đòi; sai đủ 3 lần trên một email thì lần sau phải có lời giải, kể cả mật khẩu đúng', async () => {
    const owner = client();
    const { body } = await registerUser(owner);
    const c = client();
    for (let i = 0; i < 3; i += 1) assert.equal((await login(c, body.email)).status, 401, `lần ${i + 1}`);

    const blocked = await login(c, body.email, body.password);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'captcha_required');
    assert.ok(!c.jar.has('gc_session'));

    const passed = await login(c, body.email, body.password, { captcha: solve(await newChallenge(c)) });
    assert.equal(passed.status, 200);
    assert.ok(c.jar.has('gc_session'));
  });

  test('bị đòi CAPTCHA không tốn scrypt và không tăng bộ đếm thử mật khẩu', async () => {
    const c = client();
    const email = stranger();
    for (let i = 0; i < 3; i += 1) await login(c, email);
    const before_ = await RateLimit.findOne({ key: `login-fail:${email}` }).lean();
    const started = performance.now();
    for (let i = 0; i < 5; i += 1) assert.equal((await login(c, email)).data.code, 'captcha_required');
    assert.ok(performance.now() - started < 200, 'không băm mật khẩu');
    assert.equal((await RateLimit.findOne({ key: `login-fail:${email}` }).lean()).count, before_.count);
  });

  test('không lộ email tồn tại: email có tài khoản và email lạ cùng bị đòi ở đúng lượt thứ 4, phản hồi giống hệt', async () => {
    const { body } = await registerUser(client());
    const lookups = [];
    for (const email of [body.email, stranger()]) {
      const c = client();
      for (let i = 0; i < 3; i += 1) await login(c, email);
      lookups.push(await login(c, email));
    }
    assert.deepEqual(lookups[0].data, lookups[1].data);
    assert.equal(lookups[0].status, lookups[1].status);
  });

  test('F-85: dò rải mỗi lượt một IP, một email: vượt ngưỡng toàn cục thì mọi đăng nhập đều phải có lời giải', async () => {
    setEnv({ ...FAST, CAPTCHA_GLOBAL_FAILURES: '4', TRUST_PROXY: 'loopback' });
    const { createApp } = await import('../../src/app.js');
    const { once } = await import('node:events');
    const server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const from = (i) => ({ headers: { 'X-Forwarded-For': `203.0.113.${i}` } });
      const attempt = (i) => createClient(base).post('/api/auth/login', { json: { email: stranger(), password: WRONG }, ...from(i) });
      for (let i = 1; i <= 4; i += 1) assert.equal((await attempt(i)).status, 401, `lượt ${i}`);
      assert.equal((await attempt(5)).data.code, 'captcha_required');
      assert.equal((await attempt(6)).data.code, 'captcha_required');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('một IP sai nhiều lần ở nhiều email cũng bị đòi, IP khác không ảnh hưởng', async () => {
    setEnv({ ...FAST, CAPTCHA_IP_FAILURES: '3' });
    const c = client();
    for (let i = 0; i < 3; i += 1) assert.equal((await login(c, stranger())).status, 401);
    assert.equal((await login(c, stranger())).data.code, 'captcha_required');
  });

  test('đăng nhập đúng không làm tăng bộ đếm: lớp học dùng chung IP không bị đòi', async () => {
    const { body } = await registerUser(client());
    for (let i = 0; i < 6; i += 1) assert.equal((await login(client(), body.email, body.password)).status, 200);
  });
});

describe('kiểm tra lời giải', () => {
  const forced = async (extra) => {
    setEnv({ ...FAST, CAPTCHA_MODE: 'always' });
    return login(client(), stranger(), WRONG, extra);
  };

  test('lời giải đúng chỉ dùng được một lần; yêu cầu đồng thời chỉ một yêu cầu qua', async () => {
    setEnv({ ...FAST, CAPTCHA_MODE: 'always' });
    const captcha = solve(await newChallenge());
    const results = await Promise.all(Array.from({ length: 8 }, () => login(client(), stranger(), WRONG, { captcha })));
    assert.equal(results.filter((res) => res.status === 401).length, 1, 'đúng một yêu cầu tới bước chấm mật khẩu');
    assert.equal(results.filter((res) => res.data.code === 'captcha_required').length, 7);
  });

  test('nonce sai: bị từ chối và thử thách bị tiêu, không thử lại được trên cùng thử thách', async () => {
    setEnv({ ...FAST, CAPTCHA_MODE: 'always' });
    const issued = await newChallenge();
    assert.equal((await login(client(), stranger(), WRONG, { captcha: wrongSolution(issued) })).data.code, 'captcha_required');
    assert.equal((await login(client(), stranger(), WRONG, { captcha: solve(issued) })).data.code, 'captcha_required');
  });

  test('độ khó vượt qua ranh giới byte như mặc định 8 bit: đủ 9 bit thì qua, đúng 8 bit thì không', async () => {
    setEnv({ ...FAST, CAPTCHA_MODE: 'always', CAPTCHA_ITERATIONS: '1', CAPTCHA_DIFFICULTY_BITS: '9' });
    const issued = await newChallenge();
    let nonce = 0;
    while (leadingZeroBits(crypto.pbkdf2Sync(String(nonce), issued.challenge, 1, 32, 'sha256')) !== 8) nonce += 1;
    assert.equal((await login(client(), stranger(), WRONG, { captcha: { challenge: issued.challenge, nonce: String(nonce) } })).data.code, 'captcha_required');
    assert.equal((await login(client(), stranger(), WRONG, { captcha: solve(await newChallenge()) })).status, 401, 'lời giải đúng tới được bước chấm mật khẩu');
  });

  test('thử thách tự chế, hết hạn hoặc lấy lại từ DB bằng băm đều không dùng được', async () => {
    assert.equal((await forced({ captcha: { challenge: 'A'.repeat(43), nonce: '1' } })).data.code, 'captcha_required');
    const issued = await newChallenge();
    await CaptchaChallenge.updateOne({ _id: hashToken(issued.challenge) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await forced({ captcha: solve(issued) })).data.code, 'captcha_required');
    const stored = await CaptchaChallenge.findOne({ _id: hashToken((await newChallenge()).challenge) }).lean();
    assert.ok(stored, 'DB chỉ giữ băm của thử thách');
    assert.equal((await forced({ captcha: { challenge: stored._id, nonce: '1' } })).data.code, 'captcha_required');
  });

  test('toán tử, kiểu lạ, chuỗi rất dài ở lời giải đều bị từ chối, không lỗi máy chủ', async () => {
    for (const captcha of [{ challenge: { $ne: null }, nonce: '1' }, { challenge: 'a', nonce: { $gt: '' } }, [], 'x', 1, null, { challenge: 'A'.repeat(5000), nonce: '1' }, { challenge: 'A'.repeat(43), nonce: '9'.repeat(5000) }]) {
      assert.equal((await forced({ captcha })).data.code, 'captcha_required', JSON.stringify(captcha)?.slice(0, 60));
    }
  });

  test('tham số thử thách lấy từ cấu hình, phản hồi không có lời giải; thử thách hết hạn tự xóa nhờ TTL', async () => {
    const issued = await newChallenge();
    assert.equal(issued.iterations, 10);
    assert.equal(issued.bits, 2);
    assert.ok(new Date(issued.expiresAt) > new Date());
    const indexes = await CaptchaChallenge.collection.indexes();
    assert.ok(indexes.some((index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0));
  });

  test('tạo thử thách hàng loạt bị giới hạn theo IP', async () => {
    setEnv({ ...FAST, CAPTCHA_ISSUE_PER_10_MINUTES: '3' });
    const c = client();
    for (let i = 0; i < 3; i += 1) assert.equal((await c.post('/api/auth/captcha')).status, 200);
    assert.equal((await c.post('/api/auth/captcha')).status, 429);
  });
});

describe('các luồng gửi thư', () => {
  const account = () => ({ name: 'Sinh Viên Test', studentId: `SV${uniqueSuffix()}`, email: stranger(), password: 'mat-khau-an-toan-1' });

  test('chế độ luôn đòi: đăng ký, quên mật khẩu, gửi lại thư đều cần lời giải và qua được khi có', async () => {
    setEnv({ ...FAST, CAPTCHA_MODE: 'always' });
    for (const [path, json] of [
      ['/api/auth/register', account()],
      ['/api/auth/password/forgot', { email: stranger() }],
      ['/api/auth/email/resend', { email: stranger() }],
    ]) {
      const c = client();
      assert.equal((await c.post(path, { json })).data.code, 'captcha_required', path);
      assert.equal((await c.post(path, { json: { ...json, captcha: solve(await newChallenge(c)) } })).status, 202, path);
    }
  });

  test('chế độ thích ứng: chưa có dấu hiệu bất thường thì không đòi; quá ngưỡng thư toàn cục thì đòi', async () => {
    setEnv({ ...FAST, CAPTCHA_GLOBAL_MAIL: '2' });
    const c = client();
    for (let i = 0; i < 2; i += 1) assert.equal((await c.post('/api/auth/password/forgot', { json: { email: stranger() } })).status, 202);
    assert.equal((await c.post('/api/auth/password/forgot', { json: { email: stranger() } })).data.code, 'captcha_required');
    assert.equal((await c.post('/api/auth/register', { json: account() })).data.code, 'captcha_required');
  });

  test('dữ liệu sai vẫn báo lỗi dữ liệu trước, không tốn thử thách', async () => {
    setEnv({ ...FAST, CAPTCHA_MODE: 'always' });
    assert.equal((await client().post('/api/auth/password/forgot', { json: { email: 'khong-hop-le' } })).data.code, 'invalid_input');
  });
});

describe('tắt và phạm vi', () => {
  test('CAPTCHA_MODE=off: không bao giờ đòi, kể cả sau nhiều lần sai', async () => {
    setEnv({ ...FAST, CAPTCHA_MODE: 'off' });
    const c = client();
    const email = stranger();
    for (let i = 0; i < 6; i += 1) assert.equal((await login(c, email)).status, 401);
  });

  test('không có request nào ra ngoài: toàn bộ chạy trên máy chủ của trường', async () => {
    setEnv({ ...FAST, CAPTCHA_MODE: 'always' });
    await login(client(), stranger(), WRONG, { captcha: solve(await newChallenge()) });
    assert.deepEqual(outbound, []);
  });
});
