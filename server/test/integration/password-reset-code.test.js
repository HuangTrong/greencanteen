// Mã 6 số trong thư "Quên mật khẩu": đặt mật khẩu mới ngay trong popup, không cần mở liên kết. SMTP giả như email-reset-flow.test.js.
// Kiểm tra: mã chỉ lưu HMAC, dùng một lần, chung hiệu lực với liên kết, giới hạn lượt nhập, không lộ email nào có tài khoản.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../../src/models/AuditLog.js';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { User } from '../../src/models/User.js';
import { hashToken } from '../../src/services/session.js';
import { createClient, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV } from '../adminHelpers.js';
import { startFakeSmtp } from '../fakes/smtp.js';

let ctx;
let smtp;
let smtpEnv;
const client = () => createClient(ctx.base);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NEW_PASSWORD = 'mat-khau-moi-rat-kho-9';

const tokenIn = (message) => message.text.match(/#reset=([A-Za-z0-9_-]{43})/)?.[1];
const codeIn = (message) => message.text.match(/Mã đặt lại mật khẩu \(hiệu lực 30 phút\): (\d{6})/)?.[1];
const otherCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
const resetWithCode = (c, email, code, password = NEW_PASSWORD) => c.post('/api/auth/password/reset-code', { json: { email, code, password } });

async function waitForMessageCount(count) {
  for (let i = 0; i < 100 && smtp.messages.length < count; i += 1) await wait(20);
}

/** Gửi yêu cầu quên mật khẩu và chờ đúng thư của yêu cầu này */
async function requestReset(email) {
  const seen = smtp.messages.length;
  const res = await client().post('/api/auth/password/forgot', { json: { email } });
  assert.equal(res.status, 202);
  await waitForMessageCount(seen + 1);
  const mail = smtp.messages[seen];
  assert.ok(mail, 'có thư đặt lại');
  return { res, mail, code: codeIn(mail), token: tokenIn(mail) };
}

/** Đặt lại thành công thì thư báo gửi sau khi đã trả lời: chờ để thư không lọt sang test sau */
const settleNotice = () => waitForMessageCount(smtp.messages.length + 1);

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
  setEnv({ ...smtpEnv, ...ADMIN_ENV });
  ctx = await startTestServer();
});
after(async () => {
  await ctx.stop();
  await smtp.close();
});
beforeEach(async () => {
  setEnv({ ...smtpEnv, ...ADMIN_ENV });
  smtp.messages.length = 0;
  smtp.rejectRecipients = false;
  await RateLimit.deleteMany({});
});

describe('mã đặt lại mật khẩu trong thư', () => {
  test('có khóa: providers và phản hồi báo có mã, thư có cả mã và liên kết, DB chỉ lưu HMAC của mã', async () => {
    assert.deepEqual((await client().get('/api/auth/providers')).data.providers.passwordReset, { enabled: true, devConsole: false, code: true });
    const { body } = await registerUser(client());
    const { res, mail, code, token } = await requestReset(body.email);
    assert.equal(res.data.codeLength, 6);
    assert.match(res.data.message, /mã 6 số và liên kết/);
    assert.ok(code, 'thư có mã 6 số');
    assert.ok(token, 'thư vẫn có liên kết');
    assert.match(mail.text, /Không đưa mã cho bất kỳ ai/);
    assert.doesNotMatch(mail.raw, new RegExp(`^Subject:.*${code}`, 'm'), 'mã không nằm ở tiêu đề (hiện trên màn hình khóa)');

    const user = await User.findOne({ email: body.email });
    const stored = await PasswordReset.findOne({ userId: user._id }).lean();
    assert.match(stored.codeHash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.codeHash, hashToken(code), 'không phải SHA-256 trần (dò được một triệu khả năng)');
    assert.notEqual(stored.codeHash, hashToken(`${user._id}:${code}`));
    assert.ok(!JSON.stringify(stored).includes(code));
    assert.equal(stored.codeAttempts, 0);
  });

  test('đúng mã: đặt được mật khẩu và đăng nhập ngay; mã và liên kết cùng thư đều hết hiệu lực; nhật ký ghi cách đặt lại', async () => {
    const { body, data } = await registerUser(client());
    const { code, token } = await requestReset(body.email);
    const c = client();
    // Email gõ hoa, mã có dấu cách như khi chép từ thư
    const res = await resetWithCode(c, body.email.toUpperCase(), `${code.slice(0, 3)} ${code.slice(3)}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.user.id, data.user.id);
    assert.equal((await c.get('/api/auth/me')).status, 200);
    await settleNotice();

    assert.equal((await resetWithCode(client(), body.email, code, 'mat-khau-khac-han-7')).data.code, 'reset_code_invalid');
    assert.equal((await client().post('/api/auth/password/reset', { json: { token, password: 'mat-khau-khac-han-7' } })).data.code, 'reset_token_invalid');
    assert.equal((await client().post('/api/auth/login', { json: { email: body.email, password: NEW_PASSWORD } })).status, 200);
    assert.equal((await client().post('/api/auth/login', { json: { email: body.email, password: body.password } })).status, 401);

    const entry = await AuditLog.findOne({ action: 'account.password_reset', actorId: data.user.id }).lean();
    assert.equal(entry?.meta?.method, 'code');
    assert.ok(!JSON.stringify(entry).includes(code));
  });

  test('yêu cầu mới làm mã cũ mất hiệu lực', async () => {
    const { body } = await registerUser(client());
    const first = await requestReset(body.email);
    const second = await requestReset(body.email);
    assert.equal((await resetWithCode(client(), body.email, first.code === second.code ? otherCode(second.code) : first.code)).data.code, 'reset_code_invalid');
    assert.equal((await resetWithCode(client(), body.email, second.code)).status, 200);
    await settleNotice();
  });

  test('sai mã, mã sai định dạng, email không có tài khoản: cùng một phản hồi', async () => {
    const { body } = await registerUser(client());
    const { code } = await requestReset(body.email);
    const wrong = await resetWithCode(client(), body.email, otherCode(code));
    const malformed = await resetWithCode(client(), body.email, '12ab56');
    const unknown = await resetWithCode(client(), `khong-co-${uniqueSuffix()}@example.edu.vn`, code);
    for (const res of [wrong, malformed, unknown]) {
      assert.equal(res.status, 400);
      assert.deepEqual(res.data, wrong.data);
    }
    assert.equal(wrong.data.code, 'reset_code_invalid');
  });

  test('5 lần sai thì mã bị khóa kể cả khi sau đó nhập đúng; liên kết trong cùng thư vẫn đặt được mật khẩu', async () => {
    const { body, data } = await registerUser(client());
    const { code, token } = await requestReset(body.email);
    for (let i = 0; i < 5; i += 1) assert.equal((await resetWithCode(client(), body.email, otherCode(code))).status, 400);
    assert.equal((await resetWithCode(client(), body.email, code)).data.code, 'reset_code_invalid');
    assert.equal((await PasswordReset.findOne({ userId: data.user.id }).lean()).codeAttempts, 5);

    assert.equal((await client().post('/api/auth/password/reset', { json: { token, password: NEW_PASSWORD } })).status, 200);
    await settleNotice();
    const entry = await AuditLog.findOne({ action: 'account.password_reset', actorId: data.user.id }).lean();
    assert.equal(entry?.meta?.method, 'link');
  });

  test('nhiều lần nhập sai gửi đồng thời không vượt quá 5 lượt', async () => {
    const { body, data } = await registerUser(client());
    const { code } = await requestReset(body.email);
    const results = await Promise.all(Array.from({ length: 8 }, () => resetWithCode(client(), body.email, otherCode(code))));
    assert.ok(results.every((r) => r.status === 400));
    assert.equal((await PasswordReset.findOne({ userId: data.user.id }).lean()).codeAttempts, 5);
  });

  test('đúng mã gửi đồng thời: chỉ một lần thành công', async () => {
    const { body } = await registerUser(client());
    const { code } = await requestReset(body.email);
    const results = await Promise.all(
      ['mat-khau-dong-thoi-1', 'mat-khau-dong-thoi-2', 'mat-khau-dong-thoi-3'].map((password) => resetWithCode(client(), body.email, code, password))
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400, 400]);
    await settleNotice();
  });

  test('đúng mã nhưng mật khẩu chứa thông tin cá nhân: báo lỗi, không tiêu mã, không mất lượt; sai mã thì không lộ lỗi này', async () => {
    const { body, data } = await registerUser(client());
    const { code } = await requestReset(body.email);
    const personal = `${body.email.split('@')[0]}-moi-nam-nay`;

    // Sai mã: chỉ báo sai mã — báo "mật khẩu chứa thông tin cá nhân" sẽ lộ email có tài khoản và họ tên chủ tài khoản
    assert.equal((await resetWithCode(client(), body.email, otherCode(code), personal)).data.code, 'reset_code_invalid');
    const rejected = await resetWithCode(client(), body.email, code, personal);
    assert.deepEqual([rejected.status, rejected.data.code], [400, 'invalid_input']);
    assert.equal((await PasswordReset.findOne({ userId: data.user.id }).lean()).codeAttempts, 1, 'chỉ lần sai mã bị tính');

    assert.equal((await resetWithCode(client(), body.email, code)).status, 200);
    await settleNotice();
  });

  test('10 lần sai trong ngày với một email: chặn nhập mã kể cả mã mới đúng; liên kết vẫn dùng được', async () => {
    const { body } = await registerUser(client());
    const { code, token } = await requestReset(body.email);
    await RateLimit.create({ key: `reset-code-fail-email:${hashToken(body.email)}`, count: 10, resetAt: new Date(Date.now() + 60 * 60 * 1000) });
    const blocked = await resetWithCode(client(), body.email, code);
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error, /mở liên kết trong email/);
    assert.equal((await client().post('/api/auth/password/reset', { json: { token, password: NEW_PASSWORD } })).status, 200);
    await settleNotice();
  });

  test('đặt lại bằng mã thành công thì xóa bộ đếm sai mã của email đó', async () => {
    const { body } = await registerUser(client());
    const { code } = await requestReset(body.email);
    await resetWithCode(client(), body.email, otherCode(code));
    assert.ok(await RateLimit.exists({ key: `reset-code-fail-email:${hashToken(body.email)}` }));
    assert.equal((await resetWithCode(client(), body.email, code)).status, 200);
    assert.equal(await RateLimit.exists({ key: `reset-code-fail-email:${hashToken(body.email)}` }), null);
    await settleNotice();
  });
});

describe('máy chủ chưa có ADMIN_MFA_KEY', () => {
  test('thư chỉ có liên kết, phản hồi không có mã, API nhập mã trả 503', async () => {
    setEnv(smtpEnv);
    assert.equal((await client().get('/api/auth/providers')).data.providers.passwordReset.code, false);
    const { body } = await registerUser(client());
    const { res, mail, code, token } = await requestReset(body.email);
    assert.equal(res.data.codeLength, 0);
    assert.doesNotMatch(res.data.message, /mã 6 số/);
    assert.equal(code, undefined);
    assert.doesNotMatch(mail.text, /Mã đặt lại mật khẩu/);
    assert.ok(token);
    const user = await User.findOne({ email: body.email });
    assert.equal((await PasswordReset.findOne({ userId: user._id }).lean()).codeHash, undefined);

    const res503 = await resetWithCode(client(), body.email, '123456');
    assert.deepEqual([res503.status, res503.data.code], [503, 'reset_code_unavailable']);
  });

  test('bật khóa sau khi thư đã gửi: bản ghi cũ không có mã nên không nhập mã được', async () => {
    setEnv(smtpEnv);
    const { body } = await registerUser(client());
    await requestReset(body.email);
    setEnv({ ...smtpEnv, ...ADMIN_ENV });
    assert.equal((await resetWithCode(client(), body.email, '000000')).data.code, 'reset_code_invalid');
  });
});
