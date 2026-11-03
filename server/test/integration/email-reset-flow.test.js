// Quên / đặt lại mật khẩu qua SMTP giả (127.0.0.1, không TLS — chỉ cho phép khi SMTP_ALLOW_PLAINTEXT=true):
// nội dung thư, email không tồn tại, gửi thư lỗi, liên kết mới vô hiệu liên kết cũ. Không dùng hộp thư thật.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../../src/models/AuditLog.js';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { User } from '../../src/models/User.js';
import { hashToken } from '../../src/services/session.js';
import { createClient, realFetch, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV, enrolledAdmin } from '../adminHelpers.js';
import { startFakeSmtp } from '../fakes/smtp.js';

let ctx;
let smtp;
let smtpEnv;
const client = () => createClient(ctx.base);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForMessages(count) {
  for (let i = 0; i < 100 && smtp.messages.length < count; i += 1) await wait(20);
  return smtp.messages;
}
const tokenIn = (message) => message.text.match(/#reset=([A-Za-z0-9_-]{43})/)?.[1];

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
});

describe('quên mật khẩu qua SMTP', () => {
  test('đã cấu hình: nút "Quên mật khẩu" bật, không phải chế độ console', async () => {
    assert.deepEqual((await client().get('/api/auth/providers')).data.providers.passwordReset, { enabled: true, devConsole: false });
  });

  test('email có tài khoản: thư tới đúng người, liên kết sau dấu #, tên được thoát HTML, DB chỉ lưu băm', async () => {
    const { body } = await registerUser(client(), { name: '<b>Tên</b> & "Học sinh"' });
    const res = await client().post('/api/auth/password/forgot', { json: { email: body.email.toUpperCase() } });
    assert.equal(res.status, 202);
    const [message] = await waitForMessages(1);
    assert.ok(message, 'có thư được gửi');
    assert.deepEqual(message.to, [`RCPT TO:<${body.email}>`]);
    assert.match(message.raw, /^Subject: =\?UTF-8\?/m);
    const token = tokenIn(message);
    assert.ok(token, 'thư chứa liên kết đặt lại');
    assert.match(message.text, new RegExp(`https://gc\\.example\\.edu\\.vn/profile#reset=${token}`));
    assert.match(message.text, /&lt;b&gt;Tên&lt;\/b&gt; &amp; &quot;Học sinh&quot;/, 'tên được thoát trong phần HTML');
    assert.doesNotMatch(message.text, /<b>Tên<\/b> &amp;/);
    const user = await User.findOne({ email: body.email });
    const stored = await PasswordReset.findOne({ userId: user._id }).lean();
    assert.equal(stored.tokenHash, hashToken(token));
    assert.ok(stored.expiresAt - Date.now() <= 30 * 60 * 1000 && stored.expiresAt - Date.now() > 29 * 60 * 1000, 'hiệu lực 30 phút');
  });

  test('email không có tài khoản: phản hồi giống hệt, không gửi thư nào', async () => {
    const { body } = await registerUser(client());
    const known = await client().post('/api/auth/password/forgot', { json: { email: body.email } });
    await waitForMessages(1);
    smtp.messages.length = 0;
    const unknown = await client().post('/api/auth/password/forgot', { json: { email: `khong-co-${uniqueSuffix()}@example.edu.vn` } });
    await wait(300);
    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.data, known.data);
    assert.equal(smtp.messages.length, 0);
  });

  test('yêu cầu mới vô hiệu liên kết cũ; liên kết mới đặt được mật khẩu và đăng nhập ngay', async () => {
    const { body } = await registerUser(client());
    await client().post('/api/auth/password/forgot', { json: { email: body.email } });
    const first = tokenIn((await waitForMessages(1))[0]);
    await client().post('/api/auth/password/forgot', { json: { email: body.email } });
    const second = tokenIn((await waitForMessages(2))[1]);
    assert.notEqual(first, second);

    const old = await client().post('/api/auth/password/reset', { json: { token: first, password: 'mat-khau-moi-123' } });
    assert.equal(old.data.code, 'reset_token_invalid');
    const c = client();
    assert.equal((await c.post('/api/auth/password/reset', { json: { token: second, password: 'mat-khau-moi-123' } })).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 200);
    await waitForMessages(3); // thư báo gửi sau khi đã trả lời, không để lọt sang test sau
  });

  test('gửi thư thất bại: vẫn 202 (không lộ email), log không chứa email hay token', async () => {
    const { body } = await registerUser(client());
    smtp.rejectRecipients = true;
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      const res = await client().post('/api/auth/password/forgot', { json: { email: body.email } });
      assert.equal(res.status, 202);
      for (let i = 0; i < 100 && lines.length === 0; i += 1) await wait(20);
    } finally {
      console.error = original;
    }
    assert.ok(lines.some((l) => l.startsWith('Gửi email đặt lại mật khẩu thất bại')), lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes(body.email) && !/#reset=/.test(l)));
    assert.equal(smtp.messages.length, 0);
  });
});

describe('F-73: thư báo khi thông tin đăng nhập thay đổi', () => {
  const PASSWORD = 'mat-khau-an-toan-1';
  const NEW_PASSWORD = 'mat-khau-moi-rat-kho-9';
  const noticeTo = (email) => smtp.messages.find((m) => m.to.includes(`RCPT TO:<${email}>`));
  const assertSafeNotice = (message) => {
    assert.doesNotMatch(message.text, /https?:\/\//, 'thư báo không có liên kết để không tập cho người dùng thói quen bấm liên kết trong thư');
    assert.match(message.text, /không phải bạn/i);
  };

  test('đổi mật khẩu: chủ tài khoản nhận thư, thư không chứa mật khẩu hay liên kết', async () => {
    const c = client();
    const { body } = await registerUser(c);
    assert.equal((await c.post('/api/auth/password/change', { json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).status, 200);
    await waitForMessages(1);
    const message = noticeTo(body.email);
    assert.ok(message, 'có thư báo');
    assertSafeNotice(message);
    assert.ok(!message.text.includes(NEW_PASSWORD));
  });

  test('đặt lại mật khẩu: chủ tài khoản nhận thư báo sau thư chứa liên kết', async () => {
    const { body } = await registerUser(client());
    await client().post('/api/auth/password/forgot', { json: { email: body.email } });
    const [mail] = await waitForMessages(1);
    assert.equal((await client().post('/api/auth/password/reset', { json: { token: tokenIn(mail), password: NEW_PASSWORD } })).status, 200);
    const [, notice] = await waitForMessages(2);
    assert.ok(notice, 'có thư báo');
    assertSafeNotice(notice);
  });

  test('máy chủ thư lỗi: đổi mật khẩu vẫn thành công, log không có địa chỉ email', async (t) => {
    const c = client();
    const { body } = await registerUser(c);
    smtp.rejectRecipients = true;
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
    assert.equal((await c.post('/api/auth/password/change', { json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).status, 200);
    await wait(150);
    assert.ok(!logged.join('\n').includes(body.email));
  });

  test('Host và X-Forwarded-Host giả không đổi được liên kết trong thư đặt lại mật khẩu', async () => {
    const { body } = await registerUser(client());
    await client().post('/api/auth/password/forgot', { json: { email: body.email }, headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http', Forwarded: 'host=evil.example' } });
    const [message] = await waitForMessages(1);
    assert.doesNotMatch(message.text, /evil\.example/);
    assert.match(message.text, /https:\/\/gc\.example\.edu\.vn\/profile#reset=/);
  });
});

describe('F-81: nhật ký kiểm toán có sự kiện bảo mật của sinh viên', () => {
  test('đổi mật khẩu được ghi, không có mật khẩu hay địa chỉ email đầy đủ', async () => {
    const c = client();
    const { body, data } = await registerUser(c);
    await c.post('/api/auth/password/change', { json: { currentPassword: body.password, newPassword: 'mat-khau-moi-rat-kho-9' } });
    await waitForMessages(1);
    const entry = await AuditLog.findOne({ action: 'account.password_change', actorId: data.user.id }).lean();
    assert.ok(entry, 'có dòng nhật ký');
    assert.equal(entry.actorType, 'user');
    assert.equal(entry.result, 'success');
    const text = JSON.stringify(entry);
    assert.ok(!text.includes(body.email));
    assert.ok(!text.includes('mat-khau-moi-rat-kho-9'));
  });

  test('đặt lại mật khẩu được ghi', async () => {
    const { body, data } = await registerUser(client());
    await client().post('/api/auth/password/forgot', { json: { email: body.email } });
    const [mail] = await waitForMessages(1);
    await client().post('/api/auth/password/reset', { json: { token: tokenIn(mail), password: 'mat-khau-moi-rat-kho-9' } });
    await waitForMessages(2);
    assert.ok(await AuditLog.exists({ action: 'account.password_reset', actorId: data.user.id, actorType: 'user' }));
  });

  test('F-83: cấp quyền quản trị và đặt lại MFA: mọi quản trị viên nhận thư, thư không có email hay mã của tài khoản liên quan', async () => {
    setEnv({ ...smtpEnv, ...ADMIN_ENV });
    const admin = await enrolledAdmin(ctx.base);
    const { data, body } = await registerUser(client());
    const granted = await admin.client.patch(`/api/admin/users/${data.user.id}/role`, { json: { role: 'admin', reason: 'Bổ nhiệm' } });
    assert.equal(granted.status, 200);
    const [message] = await waitForMessages(1);
    assert.deepEqual(message.to, [`RCPT TO:<${admin.email}>`]);
    assert.match(message.text, /cấp quyền quản trị/);
    assert.ok(!message.text.includes(body.email));
    assert.ok(!message.text.includes(granted.data.enrollCode));

    smtp.messages.length = 0;
    const other = await enrolledAdmin(ctx.base);
    assert.equal((await admin.client.post(`/api/admin/users/${other.user._id}/mfa-reset`, { json: { reason: 'Mất thiết bị' } })).status, 200);
    await waitForMessages(3);
    assert.ok(smtp.messages.every((m) => /Thiết bị xác thực/.test(m.text)));
    assert.equal(smtp.messages.length, 3);
    await User.deleteMany({ role: 'admin' });
  });
});

describe('thư báo khi liên kết nhà cung cấp', () => {
  test('liên kết Google rồi hủy: chủ tài khoản nhận thư ở cả hai bước, nhật ký có dấu vết', async () => {
    const provider = { GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-secret' };
    setEnv({ ...smtpEnv, ...provider });
    const sub = `g-${uniqueSuffix()}`;
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
      assert.match(String(url), /^https:\/\/oauth2\.googleapis\.com\/token/);
      const claims = { iss: 'https://accounts.google.com', aud: provider.GOOGLE_CLIENT_ID, sub, email: `${sub}@gmail.com`, email_verified: true, name: 'Google', exp: Math.floor(Date.now() / 1000) + 600 };
      return new Response(JSON.stringify({ id_token: `${part({ alg: 'RS256' })}.${part(claims)}.sig` }), { headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const c = client();
      const { body, data } = await registerUser(c);
      await c.post('/api/auth/reauth', { json: { password: body.password } });
      const start = await c.get('/api/auth/google/start?mode=link');
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const callback = await c.get(`/api/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`);
      assert.equal(new URL(callback.headers.get('location')).searchParams.get('auth'), 'linked');
      assert.match((await waitForMessages(1))[0].text, /liên kết để đăng nhập/);
      assert.equal((await c.del('/api/auth/providers/google')).status, 200);
      assert.match((await waitForMessages(2))[1].text, /không còn đăng nhập được/);
      assert.ok(await AuditLog.exists({ action: 'account.provider_link', actorId: data.user.id }));
      assert.ok(await AuditLog.exists({ action: 'account.provider_unlink', actorId: data.user.id, 'meta.provider': 'google' }));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('đăng xuất các thiết bị khác được ghi', async () => {
    const c = client();
    const { data } = await registerUser(c);
    await c.post('/api/auth/sessions/revoke-others');
    assert.ok(await AuditLog.exists({ action: 'account.sessions_revoked', actorId: data.user.id }));
  });
});
