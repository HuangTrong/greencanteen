// F-05: xác minh email trước khi kích hoạt tài khoản; F-06: đăng ký trùng không lộ email hay mã SV. Dùng SMTP giả trên 127.0.0.1.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckIn } from '../../src/models/CheckIn.js';
import { EmailVerification } from '../../src/models/EmailVerification.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { User } from '../../src/models/User.js';
import { generateClaimCode, normalizeClaimCode } from '../../src/services/accounts.js';
import { hashToken } from '../../src/services/session.js';
import { VERIFY_TOKEN, createClient, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { startFakeSmtp } from '../fakes/smtp.js';

let ctx;
let smtp;
let smtpEnv;
const client = () => createClient(ctx.base);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function form(overrides = {}) {
  const suffix = uniqueSuffix();
  return { name: 'Sinh Viên Test', studentId: `SV${suffix}`, email: `sv${suffix}@example.edu.vn`, password: 'mat-khau-an-toan-1', ...overrides };
}

const register = (c, body) => c.post('/api/auth/register', { json: body });
const verify = (c, token, password, extra = {}) => c.post('/api/auth/email/verify', { json: { token, password, ...extra } });
const resend = (c, email) => c.post('/api/auth/email/resend', { json: { email } });
const login = (c, email, password) => c.post('/api/auth/login', { json: { email, password } });
const mailTo = (email) => smtp.messages.filter((m) => m.to.some((rcpt) => rcpt.includes(`<${email}>`)));
const tokenIn = (message) => message?.text.match(VERIFY_TOKEN)?.[1];

/** Đăng ký qua API; trả về form và token trong thư */
async function pendingAccount(overrides, c = client()) {
  const body = form(overrides);
  const res = await register(c, body);
  assert.equal(res.status, 202, JSON.stringify(res.data));
  return { body, token: tokenIn(mailTo(body.email).at(-1)) };
}

async function waitForMail(email, count = 1) {
  for (let i = 0; i < 100 && mailTo(email).length < count; i += 1) await wait(20);
  return mailTo(email);
}

async function captureErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

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

before(async () => {
  smtp = await startFakeSmtp();
  smtpEnv = {
    EMAIL_TRANSPORT: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_ALLOW_PLAINTEXT: 'true',
    EMAIL_FROM: 'GreenCanteen <no-reply@example.edu.vn>',
    CLIENT_ORIGIN: 'https://gc.example.edu.vn',
  };
  setEnv(smtpEnv);
  ctx = await startTestServer();
});
after(async () => {
  await ctx.stop();
  await smtp.close();
});
beforeEach(async () => {
  setEnv(smtpEnv);
  smtp.messages.length = 0;
  smtp.rejectRecipients = false;
  await RateLimit.deleteMany({});
  await EmailVerification.deleteMany({});
});

describe('F-05: đăng ký chỉ kích hoạt sau khi xác minh email', () => {
  test('đăng ký: chưa có tài khoản, chưa có phiên; thư đúng người, token sau dấu #, DB chỉ lưu băm', async () => {
    const c = client();
    const body = form({ name: 'Nguyễn Văn Quảng Cáo http://spam.example' });
    const res = await register(c, body);
    assert.equal(res.status, 202);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.user, undefined, 'không trả thông tin tài khoản');
    assert.ok(!c.jar.has('gc_session'), 'chưa có phiên');
    assert.equal((await c.get('/api/auth/me')).status, 401);
    assert.equal(await User.countDocuments({ email: body.email }), 0, 'chưa có tài khoản');

    const [message] = mailTo(body.email);
    assert.ok(message, 'có thư');
    assert.deepEqual(message.to, [`RCPT TO:<${body.email}>`]);
    const token = tokenIn(message);
    assert.match(message.text, new RegExp(`https://gc\\.example\\.edu\\.vn/profile#verify=${token}`), 'token nằm sau dấu #, không nằm trong query');
    assert.doesNotMatch(message.text, /[?&]token=/);
    assert.ok(!message.text.includes('spam.example'), 'không chèn họ tên do người gửi tự khai vào thư gửi địa chỉ chưa xác minh');

    const stored = await EmailVerification.findOne({ email: body.email }).select('+passwordHash').lean();
    assert.equal(stored.tokenHash, hashToken(token));
    assert.ok(!JSON.stringify(stored).includes(token), 'DB không chứa token gốc');
    assert.ok(!JSON.stringify(stored).includes(body.password), 'DB không chứa mật khẩu gốc');
    assert.match(stored.passwordHash, /^scrypt\$32768\$/);
    const ttl = stored.expiresAt - Date.now();
    assert.ok(ttl <= 24 * 3600e3 && ttl > 23.9 * 3600e3, 'hiệu lực 24 giờ');
  });

  test('email được chuẩn hóa; token dài 256 bit', async () => {
    const body = form();
    await register(client(), { ...body, email: `  ${body.email.toUpperCase()} ` });
    const token = tokenIn(mailTo(body.email)[0]);
    assert.equal(token.length, 43);
    assert.equal(await EmailVerification.countDocuments({ email: body.email }), 1);
  });

  test('đăng nhập trước khi xác minh: giống hệt email không tồn tại, không có phiên', async () => {
    const { body } = await pendingAccount();
    const c = client();
    const pending = await login(c, body.email, body.password);
    const unknown = await login(client(), `khong-co-${uniqueSuffix()}@example.edu.vn`, body.password);
    assert.equal(pending.status, 401);
    assert.deepEqual(pending.data, unknown.data);
    assert.ok(!c.jar.has('gc_session'));
  });

  test('quên mật khẩu trước khi xác minh: giống hệt email không tồn tại, không có thư đặt lại', async () => {
    const { body } = await pendingAccount();
    smtp.messages.length = 0;
    const pending = await client().post('/api/auth/password/forgot', { json: { email: body.email } });
    const unknown = await client().post('/api/auth/password/forgot', { json: { email: `khong-co-${uniqueSuffix()}@example.edu.vn` } });
    await wait(300);
    assert.deepEqual([pending.status, pending.data], [unknown.status, unknown.data]);
    assert.equal(mailTo(body.email).length, 0);
  });

  test('xác minh thành công: tạo tài khoản, cấp phiên, xóa đăng ký chờ; đăng nhập lại bằng mật khẩu đã đặt', async () => {
    const { body, token } = await pendingAccount();
    const c = client();
    const res = await verify(c, token, body.password);
    assert.equal(res.status, 201);
    assert.equal(res.data.claimed, false);
    assert.equal(res.data.user.email, body.email);
    assert.equal(res.data.user.studentId, body.studentId);
    assert.equal(res.data.user.authMethods.password, true);
    assert.equal((await c.get('/api/auth/me')).status, 200);

    const stored = await User.findOne({ email: body.email }).select('+passwordHash').lean();
    assert.ok(stored.emailVerifiedAt, 'ghi nhận thời điểm xác minh');
    assert.equal(stored.role, 'user');
    assert.equal(await EmailVerification.countDocuments({ email: body.email }), 0);
    assert.equal((await login(client(), body.email, body.password)).status, 200);
  });

  test('token sai định dạng, không tồn tại, hết hạn, đã dùng: cùng một lỗi, không có phiên', async () => {
    const used = await pendingAccount();
    assert.equal((await verify(client(), used.token, used.body.password)).status, 201);
    const expired = await pendingAccount();
    await EmailVerification.updateOne({ email: expired.body.email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const results = [];
    for (const token of ['ngan', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, '', 'B'.repeat(43), used.token, expired.token, undefined, 42, { $ne: null }]) {
      const c = client();
      const res = await verify(c, token, 'mat-khau-an-toan-1');
      assert.equal(res.status, 400, String(token));
      assert.ok(!c.jar.has('gc_session'));
      results.push(res.data);
    }
    assert.equal(results[0].code, 'verification_token_invalid');
    for (const data of results) assert.deepEqual(data, results[0]);
    assert.equal(await User.countDocuments({ email: expired.body.email }), 0, 'token hết hạn không tạo tài khoản');
  });

  test('sai mật khẩu ở bước xác minh: không kích hoạt, liên kết vẫn dùng được với đúng mật khẩu', async () => {
    const { body, token } = await pendingAccount();
    const c = client();
    for (const password of ['mat-khau-khac-han', '', undefined, { $ne: null }, 'x'.repeat(300)]) {
      const wrong = await verify(c, token, password);
      assert.equal(wrong.status, 400, String(password));
      assert.equal(wrong.data.code, 'invalid_password');
    }
    assert.ok(!c.jar.has('gc_session'));
    assert.equal(await User.countDocuments({ email: body.email }), 0);
    assert.equal((await verify(c, token, body.password)).status, 201);
  });

  test('chiếm trước email: người nhận thư không kích hoạt được đăng ký mang mật khẩu của kẻ khác; chủ email đăng ký lại được', async () => {
    const email = `nan-nhan-${uniqueSuffix()}@example.edu.vn`;
    const attacker = await pendingAccount({ email, password: 'mat-khau-cua-ke-gian' });

    // Nạn nhân bấm liên kết trong thư nhưng không biết mật khẩu kẻ gian đã đặt
    const victim = client();
    assert.equal((await verify(victim, attacker.token, 'mat-khau-cua-nan-nhan')).data.code, 'invalid_password');
    assert.equal(await User.countDocuments({ email }), 0);

    const owner = await pendingAccount({ email, password: 'mat-khau-cua-nan-nhan' });
    assert.equal(await EmailVerification.countDocuments({ email }), 1, 'mỗi email chỉ một đăng ký chờ');
    assert.equal((await verify(client(), attacker.token, 'mat-khau-cua-ke-gian')).data.code, 'verification_token_invalid', 'đăng ký trước mất hiệu lực');
    assert.equal((await verify(victim, owner.token, 'mat-khau-cua-nan-nhan')).status, 201);
    assert.equal((await login(client(), email, 'mat-khau-cua-ke-gian')).status, 401);
  });

  test('F-66 (ghi nhận, còn mở): đăng ký lại cùng email làm mất hiệu lực liên kết của người đăng ký trước, nhưng không chiếm được gì', async () => {
    const first = await pendingAccount();
    assert.equal((await register(client(), form({ email: first.body.email, password: 'mat-khau-nguoi-khac-9' }))).status, 202);
    const res = await verify(client(), first.token, first.body.password);
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'verification_token_invalid');
    assert.equal(await User.countDocuments({ email: first.body.email }), 0);
  });

  test('liên kết của người khác không làm trình duyệt đăng nhập vào tài khoản của họ', async () => {
    const { token } = await pendingAccount();
    const c = client();
    await verify(c, token, 'khong-biet-mat-khau');
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  test('thử token sai liên tục bị giới hạn theo IP, kể cả khi đến lượt token đúng', async () => {
    const { body, token } = await pendingAccount();
    setEnv({ ...smtpEnv, AUTH_LOGIN_IP_MAX: '3' });
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await verify(client(), `${'C'.repeat(41)}${String(i).padStart(2, '0')}`, 'bat-ky-mat-khau')).status, 400);
    }
    const limited = await verify(client(), token, body.password);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, 'too_many_attempts');
  });

  test('mọi đường dẫn mới đều cần header chống CSRF', async () => {
    for (const path of ['/api/auth/email/verify', '/api/auth/email/resend']) {
      const res = await client().post(path, { json: {}, csrf: false });
      assert.equal(res.status, 403, path);
      assert.equal(res.data.code, 'csrf_rejected');
    }
  });

  test('log không chứa token, mật khẩu hay địa chỉ email trong toàn bộ luồng', async () => {
    const lines = [];
    const originals = { log: console.log, error: console.error, warn: console.warn };
    for (const method of Object.keys(originals)) console[method] = (...args) => lines.push(args.join(' '));
    let body;
    let token;
    try {
      ({ body, token } = await pendingAccount());
      await verify(client(), token, 'sai-mat-khau-mot-lan');
      await verify(client(), token, body.password);
      await resend(client(), body.email);
      await wait(100);
    } finally {
      Object.assign(console, originals);
    }
    const output = lines.join('\n');
    for (const secret of [token, body.password, body.email]) assert.ok(!output.includes(secret));
  });
});

describe('F-05: gửi lại thư xác minh', () => {
  test('gửi lại: thư mới, token mới, token cũ mất hiệu lực, hạn được tính lại', async () => {
    const { body, token } = await pendingAccount();
    await EmailVerification.updateOne({ email: body.email }, { $set: { expiresAt: new Date(Date.now() + 60_000) } });
    const res = await resend(client(), body.email.toUpperCase());
    assert.equal(res.status, 202);
    const mails = await waitForMail(body.email, 2);
    const fresh = tokenIn(mails.at(-1));
    assert.ok(fresh);
    assert.notEqual(fresh, token);
    for (let i = 0; i < 50 && !(await EmailVerification.exists({ tokenHash: hashToken(fresh) })); i += 1) await wait(20);
    assert.ok((await EmailVerification.findOne({ email: body.email }).lean()).expiresAt - Date.now() > 23 * 3600e3);
    assert.equal((await verify(client(), token, body.password)).data.code, 'verification_token_invalid');
    assert.equal((await verify(client(), fresh, body.password)).status, 201);
  });

  test('không có đăng ký chờ: phản hồi giống hệt, không gửi thư cho người lạ hay tài khoản đã kích hoạt', async () => {
    const pending = await pendingAccount();
    const { body: active } = await registerUser(client());
    const known = await resend(client(), pending.body.email);
    await waitForMail(pending.body.email, 2);
    const unknownEmail = `khong-co-${uniqueSuffix()}@example.edu.vn`;
    const unknown = await resend(client(), unknownEmail);
    const activated = await resend(client(), active.email);
    await wait(250);
    for (const res of [unknown, activated]) {
      assert.equal(res.status, known.status);
      assert.deepEqual(res.data, known.data);
    }
    assert.equal(mailTo(unknownEmail).length, 0);
    assert.equal(mailTo(active.email).length, 0);
  });

  test('giới hạn theo email tính chung với /register; email lạ cũng bị đếm nên 429 không lộ gì', async () => {
    setEnv({ ...smtpEnv, AUTH_VERIFY_EMAIL_MAX: '2' });
    const { body } = await pendingAccount();
    assert.equal((await resend(client(), body.email)).status, 202);
    await waitForMail(body.email, 2);
    const limited = await resend(client(), body.email);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, 'too_many_attempts');

    const unknownEmail = `khong-co-${uniqueSuffix()}@example.edu.vn`;
    await resend(client(), unknownEmail);
    await resend(client(), unknownEmail);
    const unknownLimited = await resend(client(), unknownEmail);
    assert.equal(unknownLimited.status, 429);
    assert.deepEqual(unknownLimited.data, limited.data);
    await wait(100);
    assert.equal(mailTo(body.email).length, 2, 'không gửi thêm khi đã chạm giới hạn');
  });

  test('hết cửa sổ thì gửi lại được', async () => {
    setEnv({ ...smtpEnv, AUTH_VERIFY_EMAIL_MAX: '1' });
    const { body } = await pendingAccount();
    assert.equal((await resend(client(), body.email)).status, 429);
    await RateLimit.updateMany({ key: /^verify-mail-email:/ }, { $set: { resetAt: new Date(Date.now() - 1) } });
    assert.equal((await resend(client(), body.email)).status, 202);
    await waitForMail(body.email, 2);
    assert.equal(mailTo(body.email).length, 2);
  });

  test('gửi lại thất bại: không báo đã gửi, token cũ vẫn dùng được, log không chứa email hay token', async () => {
    const { body, token } = await pendingAccount();
    smtp.rejectRecipients = true;
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      const res = await resend(client(), body.email);
      assert.equal(res.status, 202);
      assert.match(res.data.message, /^Nếu/, 'không khẳng định đã gửi');
      for (let i = 0; i < 200 && lines.length === 0; i += 1) await wait(10);
    } finally {
      console.error = original;
    }
    smtp.rejectRecipients = false;
    assert.ok(lines.some((l) => l.startsWith('Gửi lại email xác minh thất bại')), lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes(body.email) && !l.includes(token)));
    assert.equal((await verify(client(), token, body.password)).status, 201);
  });

  test('gửi lại: thông báo trả về có điều kiện, không khẳng định đã gửi; dữ liệu sai bị từ chối; toán tử MongoDB bị từ chối', async () => {
    const res = await resend(client(), `khong-co-${uniqueSuffix()}@example.edu.vn`);
    assert.match(res.data.message, /^Nếu/);
    for (const email of ['khong-phai-email', '', { $ne: null }, ['a@example.edu.vn']]) {
      const bad = await resend(client(), email);
      assert.equal(bad.status, 400);
      assert.equal(bad.data.code, 'invalid_input');
    }
  });
});

describe('F-05: SMTP lỗi hoặc chưa cấu hình', () => {
  test('SMTP từ chối: báo chưa gửi được, không lưu đăng ký, không kích hoạt; log không chứa email hay token', async () => {
    smtp.rejectRecipients = true;
    const body = form();
    const c = client();
    const { result: res, lines } = await captureErrors(() => register(c, body));
    assert.equal(res.status, 502);
    assert.equal(res.data.code, 'email_send_failed');
    assert.doesNotMatch(res.data.error, /đã gửi/i);
    assert.equal(res.data.ok, undefined);
    assert.ok(!c.jar.has('gc_session'));
    assert.equal(await EmailVerification.countDocuments({ email: body.email }), 0);
    assert.equal(await User.countDocuments({ email: body.email }), 0);
    assert.ok(lines.some((l) => l.startsWith('Gửi email xác minh thất bại')), lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes(body.email) && !VERIFY_TOKEN.test(l)));
  });

  test('gửi lỗi không tốn lượt: người dùng thử lại được ngay khi SMTP hoạt động trở lại', async () => {
    setEnv({ ...smtpEnv, AUTH_VERIFY_EMAIL_MAX: '1', AUTH_REGISTER_IP_MAX: '1' });
    smtp.rejectRecipients = true;
    const body = form();
    await captureErrors(() => register(client(), body));
    smtp.rejectRecipients = false;
    assert.equal((await register(client(), body)).status, 202);
  });

  test('chưa cấu hình: báo rõ, không lưu đăng ký, không tạo tài khoản, /providers báo chưa sẵn sàng', async () => {
    setEnv();
    const providers = (await client().get('/api/auth/providers')).data.providers;
    assert.deepEqual(providers.emailVerification, { enabled: false, devConsole: false });
    const body = form();
    const res = await register(client(), body);
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'email_not_configured');
    assert.equal(await EmailVerification.countDocuments(), 0);
    assert.equal(await User.countDocuments({ email: body.email }), 0);
    assert.equal((await resend(client(), body.email)).status, 503);
  });

  test('email console bị chặn trong production; đã cấu hình SMTP thì /providers báo sẵn sàng', async () => {
    assert.deepEqual((await client().get('/api/auth/providers')).data.providers.emailVerification, { enabled: true, devConsole: false });
    setEnv({ EMAIL_TRANSPORT: 'console', NODE_ENV: 'production' });
    assert.equal((await register(client(), form())).status, 503);
  });

  test('chế độ console chỉ để phát triển: có báo devConsole', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console' });
    assert.deepEqual((await client().get('/api/auth/providers')).data.providers.emailVerification, { enabled: true, devConsole: true });
  });
});

describe('F-05: đồng thời và lỗi database', () => {
  test('hai yêu cầu đăng ký cùng email: một đăng ký chờ, không tài khoản; sau xác minh đúng một tài khoản', async () => {
    const body = form();
    const results = await Promise.all([register(client(), body), register(client(), { ...body, studentId: `${body.studentId}B` })]);
    assert.deepEqual(results.map((r) => r.status), [202, 202]);
    assert.equal(await EmailVerification.countDocuments({ email: body.email }), 1);
    assert.equal(await User.countDocuments({ email: body.email }), 0);

    const tokens = mailTo(body.email).map(tokenIn);
    assert.equal(tokens.length, 2);
    const outcomes = [];
    for (const token of tokens) outcomes.push((await verify(client(), token, body.password)).status);
    assert.deepEqual(outcomes.sort(), [201, 400], 'đúng một liên kết còn hiệu lực');
    assert.equal(await User.countDocuments({ email: body.email }), 1);
  });

  test('hai lần xác minh đồng thời cùng token: đúng một tài khoản, liên kết hết tác dụng', async () => {
    const { body, token } = await pendingAccount();
    const results = await Promise.all([verify(client(), token, body.password), verify(client(), token, body.password)]);
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses[0], 201);
    assert.ok(statuses[1] >= 400 && statuses[1] < 500, String(statuses));
    assert.equal(await User.countDocuments({ email: body.email }), 1);
    assert.equal((await verify(client(), token, body.password)).data.code, 'verification_token_invalid');
  });

  test('hai email cùng mã SV khác hoa/thường xác minh đồng thời: đúng một tài khoản, bên kia nhận lỗi chung', async () => {
    const studentId = `RACE${uniqueSuffix()}`.toUpperCase();
    const first = await pendingAccount({ studentId });
    const second = await pendingAccount({ studentId: studentId.toLowerCase() });
    const originalCreate = User.create;
    const waiting = [];
    User.create = function create(...args) {
      return new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) waiting.forEach((release) => release());
      }).then(() => originalCreate.apply(this, args));
    };
    let results;
    try {
      results = await Promise.all([verify(client(), first.token, first.body.password), verify(client(), second.token, second.body.password)]);
    } finally {
      User.create = originalCreate;
    }
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const conflict = results.find((r) => r.status === 409);
    assert.equal(conflict.data.code, 'registration_conflict');
    assert.equal(await User.countDocuments({ studentId: new RegExp(`^${studentId}$`, 'i') }), 1);
  });

  test('DB lỗi khi tạo tài khoản: lỗi chung, không phiên, đăng ký vẫn còn để thử lại', async () => {
    const { body, token } = await pendingAccount();
    const c = client();
    const failed = await withStub(User, 'create', () => Promise.reject(new Error('kết nối DB bị đứt (nội bộ)')), () => verify(c, token, body.password));
    assert.equal(failed.status, 500);
    assert.equal(failed.data.code, 'server_error');
    assert.ok(!JSON.stringify(failed.data).includes('nội bộ'));
    assert.ok(!c.jar.has('gc_session'));
    assert.equal((await verify(c, token, body.password)).status, 201);
  });

  test('DB lỗi khi lưu đăng ký: lỗi chung, không báo đã gửi', async () => {
    const body = form();
    const failed = await withStub(EmailVerification, 'updateOne', () => Promise.reject(new Error('kết nối DB bị đứt (nội bộ)')), () => register(client(), body));
    assert.equal(failed.status, 500);
    assert.equal(failed.data.code, 'server_error');
    assert.equal(failed.data.ok, undefined);
    assert.equal(await EmailVerification.countDocuments({ email: body.email }), 0);
  });

  test('DB lỗi khi tra đăng ký chờ lúc xác minh: lỗi chung, không lộ chi tiết', async () => {
    const res = await withStub(EmailVerification, 'findOne', () => {
      const query = { select: () => query, then: (ok, ko) => Promise.reject(new Error('kết nối DB bị đứt (nội bộ)')).then(ok, ko) };
      return query;
    }, () => verify(client(), 'D'.repeat(43), 'bat-ky-mat-khau'));
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(res.data).includes('nội bộ'));
  });
});

describe('F-05: tài khoản cũ nhận lại bằng mã kích hoạt qua luồng xác minh email', () => {
  async function legacyAccount() {
    const studentId = `LEG${uniqueSuffix()}`;
    const code = generateClaimCode();
    const legacy = await User.create({
      studentId,
      name: 'Tài khoản cũ',
      department: 'Khoa cũ',
      className: 'Lớp cũ',
      ecoPoints: 120,
      totalCheckIns: 12,
      plasticSavedGrams: 144,
      pendingGachaSpins: 2,
      badges: ['first_sip'],
      claimCodeHash: hashToken(normalizeClaimCode(code)),
      claimCodeExpiresAt: new Date(Date.now() + 3600e3),
    });
    await CheckIn.create({ userId: legacy._id, studentId, valid: true, pointsEarned: 10 });
    await GachaReward.create({ userId: legacy._id, studentId, carrier: 'Viettel', amountVnd: 10_000, topUpCode: `CU-${uniqueSuffix()}` });
    return { legacy, studentId, code };
  }

  test('/register không tiết lộ mã SV thuộc tài khoản cũ; bước xác minh mới hỏi mã kích hoạt; giữ nguyên điểm, lịch sử, phần thưởng', async () => {
    const { legacy, studentId, code } = await legacyAccount();
    const fresh = await register(client(), form());
    const body = form({ studentId });
    const res = await register(client(), body);
    assert.equal(res.status, 202);
    assert.deepEqual(res.data, fresh.data);
    const token = tokenIn(mailTo(body.email)[0]);

    const c = client();
    const needCode = await verify(c, token, body.password);
    assert.equal(needCode.status, 409);
    assert.equal(needCode.data.code, 'legacy_claim_required');
    assert.ok(!c.jar.has('gc_session'));

    const wrong = await verify(c, token, body.password, { claimCode: 'AAAA-BBBB-CCCC' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.data.code, 'invalid_claim_code');

    const claimed = await verify(c, token, body.password, { claimCode: code.toLowerCase() });
    assert.equal(claimed.status, 201);
    assert.equal(claimed.data.claimed, true);
    assert.equal(claimed.data.user.id, legacy._id.toString(), 'không tạo tài khoản mới');
    assert.equal(claimed.data.user.ecoPoints, 120);
    assert.equal(claimed.data.user.totalCheckIns, 12);
    assert.equal(claimed.data.user.pendingGachaSpins, 2);
    assert.equal((await c.get('/api/checkin/history')).data.history.length, 1);
    assert.equal((await c.get('/api/gacha/rewards')).data.rewards.length, 1);
    assert.equal(await User.countDocuments({ studentId }), 1);
    const stored = await User.findById(legacy._id).lean();
    assert.equal(stored.department, 'Khoa cũ');
    assert.equal(stored.email, body.email);
    assert.ok(stored.emailVerifiedAt);
    assert.equal((await login(client(), body.email, body.password)).status, 200);
  });

  test('không có mã kích hoạt thì không ai nhận được tài khoản cũ dù đã xác minh email của mình', async () => {
    const { legacy, studentId } = await legacyAccount();
    const { body, token } = await pendingAccount({ studentId });
    assert.equal((await verify(client(), token, body.password)).data.code, 'legacy_claim_required');
    assert.equal(await EmailVerification.countDocuments({ email: body.email }), 1, 'đăng ký chờ còn để nhập mã');
    const stored = await User.findById(legacy._id).select('+passwordHash').lean();
    assert.equal(stored.email, undefined);
    assert.equal(stored.passwordHash, undefined);
  });
});

describe('F-06: đăng ký trùng không lộ email hay mã sinh viên', () => {
  const headersOf = (res) => ({ type: res.headers.get('content-type'), cache: res.headers.get('cache-control') });

  async function activeAccount() {
    const { body } = await registerUser(client());
    smtp.messages.length = 0;
    return body;
  }

  test('email đã có (khác hoa/thường), mã SV đã có (khác hoa/thường), cả hai: giống hệt đăng ký mới', async () => {
    const active = await activeAccount();
    const fresh = await register(client(), form());
    assert.equal(fresh.status, 202);
    for (const [label, body] of [
      ['trùng email', form({ email: active.email })],
      ['trùng email khác hoa/thường', form({ email: active.email.toUpperCase() })],
      ['trùng mã SV', form({ studentId: active.studentId })],
      ['trùng mã SV khác hoa/thường', form({ studentId: active.studentId.toLowerCase() })],
      ['trùng cả hai', form({ email: active.email, studentId: active.studentId })],
    ]) {
      const c = client();
      const res = await register(c, body);
      assert.equal(res.status, fresh.status, label);
      assert.deepEqual(res.data, fresh.data, label);
      assert.deepEqual(headersOf(res), headersOf(fresh), label);
      assert.deepEqual(res.headers.getSetCookie(), [], label);
      assert.equal(c.jar.size, 0, label);
    }
  });

  test('trùng email: người chủ nhận thư báo (không token, không tên, không mã SV), tài khoản không đổi', async () => {
    const active = await activeAccount();
    const before = await User.findOne({ email: active.email }).select('+passwordHash').lean();
    const body = form({ email: active.email, password: 'mat-khau-cua-nguoi-khac', name: 'Tên Người Khác Nhập' });
    await register(client(), body);
    const [notice] = mailTo(active.email);
    assert.ok(notice, 'có thư báo cho chủ email');
    assert.equal(tokenIn(notice), undefined);
    assert.ok(!notice.text.includes(body.name));
    assert.ok(!notice.text.includes(body.studentId));
    assert.ok(!notice.text.includes(active.name));
    assert.equal(await EmailVerification.countDocuments({ email: active.email }), 0);
    assert.deepEqual(await User.findOne({ email: active.email }).select('+passwordHash').lean(), before);
    assert.equal((await login(client(), active.email, body.password)).status, 401);
    assert.equal((await login(client(), active.email, active.password)).status, 200);
  });

  test('trùng mã SV: vẫn gửi thư xác minh như thường; bước xác minh không kích hoạt, không đổi tài khoản, không nêu trường nào trùng', async () => {
    const active = await activeAccount();
    const before = await User.findOne({ email: active.email }).lean();
    const body = form({ studentId: active.studentId.toLowerCase() });
    await register(client(), body);
    const token = tokenIn(mailTo(body.email)[0]);
    assert.ok(token);

    const res = await verify(client(), token, body.password);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'registration_conflict');
    assert.doesNotMatch(res.data.error, /mã sinh viên|mã SV/i);
    assert.deepEqual(await User.findOne({ email: active.email }).lean(), before);
    assert.equal(await User.countDocuments({ email: body.email }), 0);
    assert.equal(await EmailVerification.countDocuments({ email: body.email }), 0, 'đăng ký chờ bị hủy, liên kết không dùng lại được');
    assert.equal((await verify(client(), token, body.password)).data.code, 'verification_token_invalid');
  });

  test('email được người khác đăng ký xong trước khi xác minh: lỗi chung, không có tài khoản trùng', async () => {
    const shared = `tranh-nhau-${uniqueSuffix()}@example.edu.vn`;
    const pending = await pendingAccount({ email: shared });
    await User.create({ studentId: `G${uniqueSuffix()}`, name: 'Vào bằng Google', email: shared, googleId: `g-${uniqueSuffix()}` });
    const res = await verify(client(), pending.token, pending.body.password);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'registration_conflict');
    assert.equal(await User.countDocuments({ email: shared }), 1);
  });

  test('dữ liệu không hợp lệ: cùng một lỗi dù email hay mã SV đã có hay chưa', async () => {
    const active = await activeAccount();
    for (const [label, broken] of [
      ['mật khẩu ngắn', { password: 'ngan' }],
      ['mật khẩu phổ biến', { password: 'password123' }],
      ['thiếu họ tên', { name: '' }],
    ]) {
      const known = await register(client(), form({ email: active.email, studentId: active.studentId, ...broken }));
      const fresh = await register(client(), form(broken));
      assert.equal(known.status, 400, label);
      assert.deepEqual(known.data, fresh.data, label);
    }
    const badEmail = await register(client(), form({ email: 'khong-phai-email' }));
    const badId = await register(client(), form({ studentId: '' }));
    assert.equal(badEmail.status, 400);
    assert.equal(badId.status, 400);
    assert.equal(smtp.messages.length, 0, 'không gửi thư khi dữ liệu sai');
  });

  test('SMTP chưa cấu hình: cùng một lỗi dù đã có hay chưa', async () => {
    const active = await activeAccount();
    setEnv();
    const known = await register(client(), form({ email: active.email }));
    const id = await register(client(), form({ studentId: active.studentId }));
    const fresh = await register(client(), form());
    assert.equal(fresh.status, 503);
    assert.deepEqual([known.status, known.data], [fresh.status, fresh.data]);
    assert.deepEqual([id.status, id.data], [fresh.status, fresh.data]);
  });

  test('SMTP lỗi: cùng một lỗi dù đã có hay chưa', async () => {
    const active = await activeAccount();
    smtp.rejectRecipients = true;
    const { result } = await captureErrors(async () => ({
      known: await register(client(), form({ email: active.email })),
      id: await register(client(), form({ studentId: active.studentId })),
      fresh: await register(client(), form()),
    }));
    assert.equal(result.fresh.status, 502);
    assert.deepEqual([result.known.status, result.known.data], [result.fresh.status, result.fresh.data]);
    assert.deepEqual([result.id.status, result.id.data], [result.fresh.status, result.fresh.data]);
  });

  test('giới hạn theo email: 429 giống nhau cho email đã có và email mới', async () => {
    setEnv({ ...smtpEnv, AUTH_VERIFY_EMAIL_MAX: '1' });
    const active = await activeAccount();
    await RateLimit.deleteMany({});
    const newcomer = form();
    await register(client(), form({ email: active.email }));
    await register(client(), newcomer);
    const known = await register(client(), form({ email: active.email }));
    const fresh = await register(client(), form({ email: newcomer.email }));
    assert.equal(known.status, 429);
    assert.deepEqual(known.data, fresh.data);
    assert.equal(mailTo(active.email).length, 1, 'không gửi thêm thư báo khi đã chạm giới hạn');
  });

  test('đăng ký trùng đồng thời: không tạo tài khoản, không đổi tài khoản đang có', async () => {
    const active = await activeAccount();
    const count = await User.countDocuments();
    const results = await Promise.all(Array.from({ length: 3 }, () => register(client(), form({ email: active.email, studentId: active.studentId }))));
    assert.deepEqual(results.map((r) => r.status), [202, 202, 202]);
    assert.equal(await User.countDocuments(), count);
    assert.equal(await EmailVerification.countDocuments({ email: active.email }), 0);
  });

  test('thời gian phản hồi: đăng ký mới, trùng email, trùng mã SV nằm trong cùng một khoảng', async () => {
    const active = await activeAccount();
    const samples = { fresh: [], email: [], studentId: [] };
    const bodies = { fresh: () => form(), email: () => form({ email: active.email }), studentId: () => form({ studentId: active.studentId }) };
    for (let round = 0; round < 9; round += 1) {
      for (const kind of Object.keys(samples)) {
        await RateLimit.deleteMany({});
        const started = performance.now();
        const res = await register(client(), bodies[kind]());
        samples[kind].push(performance.now() - started);
        assert.equal(res.status, 202);
      }
    }
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const medians = Object.values(samples).map(median);
    const spread = Math.max(...medians) - Math.min(...medians);
    assert.ok(spread < Math.max(40, Math.min(...medians) * 0.25), `trung vị (ms): ${medians.map((m) => m.toFixed(0)).join(', ')}`);
  });

  test('hồi quy: đăng nhập và quên mật khẩu vẫn không lộ email', async () => {
    const active = await activeAccount();
    const unknownEmail = `khong-co-${uniqueSuffix()}@example.edu.vn`;
    const wrongPassword = await login(client(), active.email, 'sai-mat-khau-123');
    const unknown = await login(client(), unknownEmail, 'sai-mat-khau-123');
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.data, unknown.data);
    const forgotKnown = await client().post('/api/auth/password/forgot', { json: { email: active.email } });
    const forgotUnknown = await client().post('/api/auth/password/forgot', { json: { email: unknownEmail } });
    assert.equal(forgotKnown.status, 202);
    assert.deepEqual(forgotKnown.data, forgotUnknown.data);
  });
});
