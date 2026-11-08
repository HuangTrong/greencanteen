// Gửi thư qua API HTTPS (EMAIL_TRANSPORT=brevo | resend) qua đúng các luồng của server: đăng ký, quên mật khẩu bằng mã, thư báo bảo mật.
// Railway gói Free/Trial/Hobby chặn SMTP nên đây là đường gửi thư khi triển khai ở đó. Nhà cung cấp giả: thay globalThis.fetch phía server
// (như oauth-flow.test.js); chỉ request về 127.0.0.1 đi qua mạng thật.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimit } from '../../src/models/RateLimit.js';
import { createClient, realFetch, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV } from '../adminHelpers.js';

const FROM = 'GreenCanteen <no-reply@example.edu.vn>';
const COMMON = { EMAIL_FROM: FROM, CLIENT_ORIGIN: 'https://gc.example.edu.vn', ...ADMIN_ENV };
const BREVO = { ...COMMON, EMAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'xkeysib-thu-nghiem' };
const RESEND = { ...COMMON, EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_thu_nghiem' };
const ENDPOINTS = ['https://api.brevo.com/v3/smtp/email', 'https://api.resend.com/emails'];

let ctx;
let sent;
let providerReply;
const client = () => createClient(ctx.base);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const accepted = () => new Response(JSON.stringify({ messageId: '<1@relay>' }), { status: 201, headers: { 'Content-Type': 'application/json' } });

before(async () => {
  setEnv(BREVO);
  ctx = await startTestServer();
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
    if (ENDPOINTS.includes(href)) {
      sent.push({ url: href, headers: init.headers, body: JSON.parse(init.body) });
      return providerReply();
    }
    throw new Error(`Chặn request ra ngoài: ${href}`);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv(BREVO);
  sent = [];
  providerReply = accepted;
  await RateLimit.deleteMany({});
});

async function nextMail(seen) {
  for (let i = 0; i < 100 && sent.length <= seen; i += 1) await wait(20);
  assert.ok(sent.length > seen, 'có thư được gửi qua API');
  return sent[seen];
}
const textOf = (mail) => mail.body.textContent ?? mail.body.text;
const recipientOf = (mail) => mail.body.to[0]?.email ?? mail.body.to[0];
const codeIn = (mail) => textOf(mail).match(/Mã đặt lại mật khẩu \(hiệu lực 30 phút\): (\d{6})/)?.[1];

describe('gửi thư qua API Brevo', () => {
  test('providers: đăng ký bằng email và "Quên mật khẩu" đều bật, không phải chế độ console', async () => {
    const { providers } = (await client().get('/api/auth/providers')).data;
    assert.deepEqual(providers.passwordReset, { enabled: true, devConsole: false, code: true });
    assert.deepEqual(providers.emailVerification, { enabled: true, devConsole: false });
  });

  test('đăng ký: thư xác minh đi qua API, kích hoạt được tài khoản bằng liên kết trong thư', async () => {
    const suffix = uniqueSuffix();
    const form = { name: 'Sinh Viên API', studentId: `SV${suffix}`, email: `api${suffix}@example.edu.vn`, password: 'mat-khau-an-toan-1' };
    const c = client();
    assert.equal((await c.post('/api/auth/register', { json: form })).status, 202);
    const mail = await nextMail(0);
    assert.equal(mail.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(mail.headers['api-key'], 'xkeysib-thu-nghiem');
    assert.deepEqual(mail.body.sender, { email: 'no-reply@example.edu.vn', name: 'GreenCanteen' });
    assert.equal(recipientOf(mail), form.email);
    assert.ok(mail.body.htmlContent, 'Brevo bắt buộc htmlContent');
    const token = textOf(mail).match(/#verify=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(token, textOf(mail));
    assert.equal((await c.post('/api/auth/email/verify', { json: { token, password: form.password } })).status, 201);
    assert.equal((await c.get('/api/auth/me')).status, 200);
  });

  test('quên mật khẩu: thư có mã và liên kết, đặt lại bằng mã trong thư, chủ tài khoản nhận thư báo', async () => {
    const { body } = await registerUser(client());
    const seen = sent.length;
    const forgot = await client().post('/api/auth/password/forgot', { json: { email: body.email } });
    assert.deepEqual([forgot.status, forgot.data.codeLength, forgot.data.devConsole], [202, 6, false]);
    const mail = await nextMail(seen);
    assert.equal(recipientOf(mail), body.email);
    assert.match(textOf(mail), /https:\/\/gc\.example\.edu\.vn\/profile#reset=[A-Za-z0-9_-]{43}/);
    const code = codeIn(mail);
    assert.ok(code, textOf(mail));

    const c = client();
    const reset = await c.post('/api/auth/password/reset-code', { json: { email: body.email, code, password: 'mat-khau-moi-qua-api-1' } });
    assert.equal(reset.status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 200);
    const notice = await nextMail(seen + 1);
    assert.equal(recipientOf(notice), body.email);
    assert.equal(notice.body.subject, 'Mật khẩu GreenCanteen vừa được đặt lại');
  });

  test('nhà cung cấp từ chối (khóa sai): vẫn trả 202 như thường, log chỉ có mã lỗi, không có email hay token', async (t) => {
    const { body } = await registerUser(client());
    providerReply = () =>
      new Response(JSON.stringify({ code: 'unauthorized', message: `Key not found, recipient ${body.email}` }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
    assert.equal((await client().post('/api/auth/password/forgot', { json: { email: body.email } })).status, 202);
    for (let i = 0; i < 100 && logged.length === 0; i += 1) await wait(20);
    assert.ok(logged.includes('Gửi email đặt lại mật khẩu thất bại: EMAIL_API_401_unauthorized'), logged.join('\n'));
    assert.ok(logged.every((l) => !l.includes(body.email) && !/#reset=|xkeysib/.test(l)), logged.join('\n'));
  });

  test('thiếu khóa API: báo chưa cấu hình, không gọi API', async () => {
    setEnv({ ...BREVO, BREVO_API_KEY: '' });
    assert.equal((await client().get('/api/auth/providers')).data.providers.passwordReset.enabled, false);
    const res = await client().post('/api/auth/password/forgot', { json: { email: `ai${uniqueSuffix()}@example.edu.vn` } });
    assert.deepEqual([res.status, res.data.code], [503, 'email_not_configured']);
    await wait(100);
    assert.equal(sent.length, 0);
  });
});

describe('gửi thư qua API Resend', () => {
  test('quên mật khẩu: header Authorization Bearer, from dạng chuỗi, mã trong thư đặt lại được mật khẩu', async () => {
    setEnv(RESEND);
    const { body } = await registerUser(client());
    const seen = sent.length;
    assert.equal((await client().post('/api/auth/password/forgot', { json: { email: body.email } })).status, 202);
    const mail = await nextMail(seen);
    assert.equal(mail.url, 'https://api.resend.com/emails');
    assert.equal(mail.headers.Authorization, 'Bearer re_thu_nghiem');
    assert.equal(mail.body.from, FROM);
    assert.deepEqual(mail.body.to, [body.email]);
    const res = await client().post('/api/auth/password/reset-code', { json: { email: body.email, code: codeIn(mail), password: 'mat-khau-moi-resend-1' } });
    assert.equal(res.status, 200);
    await nextMail(seen + 1); // thư báo gửi sau khi đã trả lời, không để lọt sang test sau
  });
});
