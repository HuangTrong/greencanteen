// Đăng nhập / đăng ký / liên kết bằng Google và Facebook với nhà cung cấp giả lập (thay fetch phía server):
// kiểm thử chuyển trạng thái start → callback → (hoàn tất đăng ký) → phiên, và các nhánh lỗi.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../../src/models/User.js';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { PendingSignup } from '../../src/models/PendingSignup.js';
import { Session } from '../../src/models/Session.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { hashToken } from '../../src/services/session.js';
import { totpCode, totpStep } from '../../src/services/totp.js';
import { createClient, realFetch, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';

const PROVIDERS = {
  GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  FACEBOOK_APP_ID: 'fb-app',
  FACEBOOK_APP_SECRET: 'fb-secret',
  ADMIN_MFA_KEY: 'a'.repeat(64),
};

let ctx;
let identity;
const client = () => createClient(ctx.base);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function googleIdentity(overrides = {}) {
  const suffix = uniqueSuffix();
  return {
    iss: 'https://accounts.google.com',
    aud: PROVIDERS.GOOGLE_CLIENT_ID,
    sub: `g-${suffix}`,
    email: `google.${suffix}@gmail.com`,
    email_verified: true,
    name: 'Người Dùng Google',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

before(async () => {
  setEnv(PROVIDERS);
  ctx = await startTestServer();
  // Nhà cung cấp giả: chỉ request về 127.0.0.1 (server test) được đi qua mạng thật
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
    if (identity.fail) return json({ error: 'invalid_grant', error_description: 'Code was already redeemed.' }, 400);
    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      return json({ id_token: `${base64url({ alg: 'RS256' })}.${base64url(identity.google)}.sig` });
    }
    if (href.startsWith('https://graph.facebook.com/v23.0/oauth/access_token')) return json({ access_token: 'fb-token' });
    if (href.startsWith('https://graph.facebook.com/v23.0/me')) return json(identity.facebook);
    throw new Error(`Chặn request ra ngoài: ${href}`);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv(PROVIDERS);
  identity = { google: googleIdentity(), facebook: { id: `fb-${uniqueSuffix()}`, name: 'Người Dùng Facebook', email: 'fb@example.com' } };
  await RateLimit.deleteMany({});
});

/** Đi hết luồng OAuth trên client c; trả về tham số của trang đích (/profile?...) */
async function oauth(c, provider, { mode, callbackQuery } = {}) {
  const start = await c.get(`/api/auth/${provider}/start${mode ? `?mode=${mode}` : ''}`);
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location'));
  if (location.pathname === '/profile') return location.searchParams;
  const state = location.searchParams.get('state');
  const query = callbackQuery ?? `code=auth-code&state=${encodeURIComponent(state)}`;
  const callback = await c.get(`/api/auth/${provider}/callback?${query}`);
  assert.equal(callback.status, 302);
  assert.ok(!c.jar.has('gc_oauth'), 'cookie state chỉ dùng một lần');
  return new URL(callback.headers.get('location')).searchParams;
}

const PASSWORD = 'mat-khau-an-toan-1';
const reauth = (c, password = PASSWORD) => c.post('/api/auth/reauth', { json: { password } });

describe('đăng ký bằng nhà cung cấp', () => {
  test('Google: danh tính mới → nhập họ tên + mã SV → tài khoản có email Google đã xác minh và phiên đăng nhập', async () => {
    const c = client();
    assert.equal((await oauth(c, 'google')).get('auth'), 'complete_signup');
    assert.ok(!c.jar.has('gc_session'), 'chưa có phiên trước khi hoàn tất');
    const stored = await PendingSignup.findOne({ providerId: identity.google.sub }).lean();
    assert.equal(stored.tokenHash, hashToken(decodeURIComponent(c.jar.get('gc_signup'))), 'DB chỉ lưu băm của token');

    const pending = await c.get('/api/auth/signup/pending');
    assert.deepEqual(pending.data, { provider: 'google', name: 'Người Dùng Google', email: identity.google.email });

    const studentId = `OG${uniqueSuffix()}`;
    const done = await c.post('/api/auth/signup/complete', { json: { name: '  Nguyễn   Google ', studentId } });
    assert.equal(done.status, 201);
    assert.equal(done.data.user.name, 'Nguyễn Google');
    assert.equal(done.data.user.email, identity.google.email);
    assert.deepEqual(done.data.user.authMethods, { password: false, google: true, facebook: false });
    assert.equal((await c.get('/api/auth/me')).status, 200);
    assert.equal(await PendingSignup.countDocuments({ providerId: identity.google.sub }), 0);

    // Lần sau: đăng nhập thẳng bằng tài khoản đã liên kết
    const again = client();
    assert.equal((await oauth(again, 'google')).get('auth'), 'success');
    assert.equal((await again.get('/api/auth/me')).data.user.studentId, studentId);
  });

  test('Google email chưa xác minh / Facebook: email nhà cung cấp không được dùng làm email tài khoản', async () => {
    identity.google = googleIdentity({ email_verified: false });
    const g = client();
    await oauth(g, 'google');
    assert.equal((await g.get('/api/auth/signup/pending')).data.email, '');
    assert.equal((await g.post('/api/auth/signup/complete', { json: { name: 'Chưa Xác Minh', studentId: `UV${uniqueSuffix()}` } })).data.user.email, '');

    const f = client();
    assert.equal((await oauth(f, 'facebook')).get('auth'), 'complete_signup');
    const done = await f.post('/api/auth/signup/complete', { json: { name: 'Bạn Facebook', studentId: `FB${uniqueSuffix()}` } });
    assert.equal(done.status, 201);
    assert.equal(done.data.user.email, '');
    assert.equal(done.data.user.authMethods.facebook, true);
  });

  test('hoàn tất đăng ký không nhận email do client gửi: không thể bỏ qua bước xác minh bằng cách tự khai email', async () => {
    identity.google = googleIdentity({ email_verified: false });
    const c = client();
    await oauth(c, 'google');
    const claimed = `tu-khai-${uniqueSuffix()}@example.edu.vn`;
    const unverified = await c.post('/api/auth/signup/complete', {
      json: { name: 'Tự Khai Email', studentId: `TK${uniqueSuffix()}`, email: claimed, emailVerified: true, emailVerifiedAt: new Date().toISOString() },
    });
    assert.equal(unverified.status, 201);
    assert.equal(unverified.data.user.email, '');
    assert.equal(await User.countDocuments({ email: claimed }), 0);

    const f = client();
    await oauth(f, 'facebook');
    const facebook = await f.post('/api/auth/signup/complete', { json: { name: 'Bạn Facebook', studentId: `FK${uniqueSuffix()}`, email: claimed } });
    assert.equal(facebook.data.user.email, '');
    assert.equal((await User.findById(facebook.data.user.id).lean()).emailVerifiedAt, undefined);
  });

  test('email Google trùng tài khoản sẵn có → email_in_use: không tạo tài khoản trùng, không tự gộp', async () => {
    const { body } = await registerUser(client());
    identity.google = googleIdentity({ email: body.email.toUpperCase() });
    const users = await User.countDocuments();
    const c = client();
    const params = await oauth(c, 'google');
    assert.equal(params.get('auth_error'), 'email_in_use');
    assert.equal(await User.countDocuments(), users);
    assert.equal((await User.findOne({ email: body.email }).lean()).googleId, undefined);
    assert.ok(!c.jar.has('gc_session'));
  });

  test('hoàn tất đăng ký: thiếu phiên tạm, dữ liệu sai, mã SV đã có tài khoản, hủy đăng ký', async () => {
    assert.equal((await client().get('/api/auth/signup/pending')).status, 404);
    assert.equal((await client().post('/api/auth/signup/complete', { json: { name: 'A B', studentId: 'X' } })).status, 410);

    const { body } = await registerUser(client());
    const c = client();
    await oauth(c, 'google');
    const invalid = await c.post('/api/auth/signup/complete', { json: { name: 'A', studentId: '' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.code, 'invalid_input');
    const taken = await c.post('/api/auth/signup/complete', { json: { name: 'Trùng Mã', studentId: body.studentId } });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.code, 'student_id_taken');

    assert.equal((await c.del('/api/auth/signup/pending')).status, 200);
    assert.ok(!c.jar.has('gc_signup'));
    assert.equal(await PendingSignup.countDocuments({ providerId: identity.google.sub }), 0);
    assert.equal((await c.get('/api/auth/signup/pending')).status, 404);
  });
});

describe('liên kết nhà cung cấp vào tài khoản đang đăng nhập', () => {
  test('mode=link → linked; đăng nhập Google sau đó vào đúng tài khoản cũ', async () => {
    const c = client();
    const { data } = await registerUser(c);
    await reauth(c);
    assert.equal((await oauth(c, 'google', { mode: 'link' })).get('auth'), 'linked');
    assert.equal((await c.get('/api/auth/me')).data.user.authMethods.google, true);
    const viaGoogle = client();
    assert.equal((await oauth(viaGoogle, 'google')).get('auth'), 'success');
    assert.equal((await viaGoogle.get('/api/auth/me')).data.user.id, data.user.id);
    assert.equal((await oauth(c, 'google', { mode: 'link' })).get('auth'), 'linked', 'liên kết lại cùng tài khoản: idempotent');
  });

  test('tài khoản đã liên kết đang bị khóa: đăng nhập Google bị từ chối, không có phiên', async () => {
    const c = client();
    const { data } = await registerUser(c);
    await reauth(c);
    await oauth(c, 'google', { mode: 'link' });
    await User.updateOne({ _id: data.user.id }, { $set: { status: 'locked' } });
    const viaGoogle = client();
    assert.equal((await oauth(viaGoogle, 'google')).get('auth_error'), 'account_locked');
    assert.ok(!viaGoogle.jar.has('gc_session'));
  });

  test('tài khoản Google đã gắn người khác / tài khoản đã gắn Google khác → từ chối', async () => {
    const owner = client();
    await registerUser(owner);
    await reauth(owner);
    await oauth(owner, 'google', { mode: 'link' });

    const other = client();
    await registerUser(other);
    await reauth(other);
    assert.equal((await oauth(other, 'google', { mode: 'link' })).get('auth_error'), 'provider_already_linked');

    identity.google = googleIdentity();
    assert.equal((await oauth(owner, 'google', { mode: 'link' })).get('auth_error'), 'different_account_linked');
  });

  test('liên kết khi chưa đăng nhập, hoặc phiên mất giữa chừng → login_required', async () => {
    assert.equal((await oauth(client(), 'google', { mode: 'link' })).get('auth_error'), 'login_required');

    const c = client();
    await registerUser(c);
    await reauth(c);
    const start = await c.get('/api/auth/google/start?mode=link');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await c.post('/api/auth/logout');
    const callback = await c.get(`/api/auth/google/callback?code=x&state=${encodeURIComponent(state)}`);
    assert.equal(new URL(callback.headers.get('location')).searchParams.get('auth_error'), 'login_required');
  });
});

describe('nhánh lỗi của callback', () => {
  test('người dùng hủy → oauth_cancelled; lỗi khác → oauth_failed; không có phiên', async () => {
    const google = client();
    assert.equal((await oauth(google, 'google', { callbackQuery: 'error=access_denied' })).get('auth_error'), 'oauth_cancelled');
    const facebook = client();
    assert.equal(
      (await oauth(facebook, 'facebook', { callbackQuery: 'error=x&error_reason=user_denied' })).get('auth_error'),
      'oauth_cancelled'
    );
    assert.equal((await oauth(client(), 'google', { callbackQuery: 'error=server_error' })).get('auth_error'), 'oauth_failed');
    assert.ok(!google.jar.has('gc_session') && !facebook.jar.has('gc_session'));
  });

  test('nhà cung cấp từ chối đổi code (lỗi phụ thuộc) → oauth_failed', async () => {
    identity.fail = true;
    const c = client();
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal((await oauth(c, 'google')).get('auth_error'), 'oauth_failed');
    } finally {
      console.error = original;
    }
    assert.ok(!c.jar.has('gc_session'));
  });

  test('state của nhà cung cấp khác, thiếu code, hoặc không có cookie → invalid_state', async () => {
    const c = client();
    const start = await c.get('/api/auth/google/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const crossed = await c.get(`/api/auth/facebook/callback?code=x&state=${encodeURIComponent(state)}`);
    assert.match(crossed.headers.get('location'), /auth_error=invalid_state/);

    const noCode = client();
    assert.equal((await oauth(noCode, 'google', { callbackQuery: 'state=abc' })).get('auth_error'), 'invalid_state');
    const noCookie = await client().get('/api/auth/google/callback?code=x&state=y');
    assert.match(noCookie.headers.get('location'), /auth_error=invalid_state/);
  });

  test('cấu hình bị gỡ giữa start và callback → provider_not_configured', async () => {
    const c = client();
    const start = await c.get('/api/auth/google/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    setEnv({});
    const callback = await c.get(`/api/auth/google/callback?code=x&state=${encodeURIComponent(state)}`);
    assert.match(callback.headers.get('location'), /auth_error=provider_not_configured/);
  });

  test('trang đích luôn là CLIENT_ORIGIN/profile (không có open redirect qua tham số)', async () => {
    setEnv({ ...PROVIDERS, CLIENT_ORIGIN: 'https://gc.example.edu.vn' });
    const res = await client().get('/api/auth/google/callback?error=access_denied&redirect=https://evil.example&next=//evil.example');
    const location = new URL(res.headers.get('location'));
    assert.equal(location.origin, 'https://gc.example.edu.vn');
    assert.equal(location.pathname, '/profile');
  });
});

describe('tài khoản đã bật 2FA đăng nhập bằng nhà cung cấp', () => {
  async function linkedWithMfa() {
    const c = client();
    const { body } = await registerUser(c);
    await reauth(c);
    await oauth(c, 'google', { mode: 'link' });
    const { secret } = (await c.post('/api/auth/mfa/setup')).data;
    await c.post('/api/auth/mfa/enable', { json: { code: totpCode(secret, totpStep() - 1) } });
    return { email: body.email, secret };
  }

  test('Google chỉ là bước một: chưa có phiên, phải nhập mã; phiên sau đó được tính là vừa xác thực', async () => {
    const { secret } = await linkedWithMfa();
    const viaGoogle = client();
    assert.equal((await oauth(viaGoogle, 'google')).get('auth'), 'mfa_required');
    assert.ok(!viaGoogle.jar.has('gc_session'));
    assert.equal((await viaGoogle.get('/api/auth/me')).status, 401);
    const done = await viaGoogle.post('/api/auth/mfa/verify', { json: { code: totpCode(secret, totpStep()) } });
    assert.equal(done.status, 200);
    assert.ok(viaGoogle.jar.has('gc_session'));
    assert.ok((await Session.findOne({ tokenHash: hashToken(viaGoogle.jar.get('gc_session')) })).reauthAt);
  });

  test('mã sai ở bước hai: không có phiên', async () => {
    await linkedWithMfa();
    const viaGoogle = client();
    await oauth(viaGoogle, 'google');
    assert.equal((await viaGoogle.post('/api/auth/mfa/verify', { json: { code: '000000' } })).status, 401);
    assert.ok(!viaGoogle.jar.has('gc_session'));
  });
});

describe('F-70: phiên bị đánh cắp không tạo được cửa hậu qua liên kết nhà cung cấp', () => {
  const victim = async () => {
    const c = client();
    const { body } = await registerUser(c);
    return { c, email: body.email };
  };
  const googleIdOf = async (email) => (await User.findOne({ email })).googleId;

  test('chỉ có phiên, chưa nhập lại mật khẩu: bị chặn ở bước bắt đầu, nhà cung cấp không được gọi', async () => {
    const { c, email } = await victim();
    const params = await oauth(c, 'google', { mode: 'link' });
    assert.equal(params.get('auth_error'), 'reauth_required');
    assert.equal(await googleIdOf(email), undefined);
  });

  test('cookie gc_oauth tự dựng với mode=link không vượt được bước bắt đầu', async () => {
    const { c, email } = await victim();
    c.jar.set('gc_oauth', encodeURIComponent(JSON.stringify({ provider: 'google', state: 'x', codeVerifier: 'y'.repeat(43), mode: 'link' })));
    const callback = await c.get('/api/auth/google/callback?code=auth-code&state=x');
    const params = new URL(callback.headers.get('location')).searchParams;
    assert.notEqual(params.get('auth'), 'linked');
    assert.equal(await googleIdOf(email), undefined);
  });

  test('cookie gc_oauth gắn với phiên khác không dùng được, kể cả khi phiên này vừa xác thực lại', async () => {
    const { c, email } = await victim();
    assert.equal((await reauth(c)).status, 200);
    c.jar.set('gc_oauth', encodeURIComponent(JSON.stringify({ provider: 'google', state: 'x', codeVerifier: 'y'.repeat(43), mode: 'link', sessionHash: 'a'.repeat(64) })));
    const callback = await c.get('/api/auth/google/callback?code=auth-code&state=x');
    assert.equal(new URL(callback.headers.get('location')).searchParams.get('auth_error'), 'invalid_state');
    assert.equal(await googleIdOf(email), undefined);
  });

  test('chuỗi cửa hậu: chủ tài khoản đặt lại mật khẩu xong, Google của kẻ tấn công không đăng nhập được', async () => {
    const { c, email } = await victim();
    await oauth(c, 'google', { mode: 'link' });
    const user = await User.findOne({ email });
    const token = 'R'.repeat(43);
    await PasswordReset.create({ tokenHash: hashToken(token), userId: user._id, expiresAt: new Date(Date.now() + 60_000) });
    assert.equal((await client().post('/api/auth/password/reset', { json: { token, password: 'mat-khau-moi-cua-chu-9' } })).status, 200);
    const attacker = client();
    const params = await oauth(attacker, 'google');
    assert.notEqual(params.get('auth'), 'success');
    assert.ok(!attacker.jar.has('gc_session'));
  });

  test('nhập đúng mật khẩu trong vòng 10 phút thì liên kết được; quá hạn thì phải nhập lại', async () => {
    const { c, email } = await victim();
    assert.equal((await reauth(c)).status, 200);
    const session = await Session.findOne({ tokenHash: hashToken(c.jar.get('gc_session')) });
    assert.ok(session.reauthAt, 'lưu thời điểm xác thực lại ở phiên này');
    await Session.updateOne({ _id: session._id }, { $set: { reauthAt: new Date(Date.now() - 11 * 60_000) } });
    assert.equal((await oauth(c, 'google', { mode: 'link' })).get('auth_error'), 'reauth_required');
    assert.equal((await reauth(c)).status, 200);
    assert.equal((await oauth(c, 'google', { mode: 'link' })).get('auth'), 'linked');
    assert.equal(await googleIdOf(email), identity.google.sub);
  });

  test('xác thực lại sai: bị từ chối, bị giới hạn, chưa đăng nhập thì 401', async () => {
    const { c } = await victim();
    assert.equal((await client().post('/api/auth/reauth', { json: { password: PASSWORD } })).status, 401);
    for (let i = 0; i < 5; i += 1) assert.equal((await reauth(c, 'sai-mat-khau-123')).data.code, 'invalid_current_password');
    assert.equal((await reauth(c)).status, 429);
    assert.equal((await oauth(c, 'google', { mode: 'link' })).get('auth_error'), 'reauth_required');
  });

  test('tài khoản không có mật khẩu: phiên vừa đăng nhập từ nhà cung cấp liên kết được; phiên cũ thì không', async () => {
    const c = client();
    await oauth(c, 'google');
    const done = await c.post('/api/auth/signup/complete', { json: { name: 'Không Mật Khẩu', studentId: `OAUTH${uniqueSuffix()}` } });
    assert.equal(done.status, 201);
    assert.equal((await oauth(c, 'facebook', { mode: 'link' })).get('auth'), 'linked');

    await User.updateOne({ googleId: identity.google.sub }, { $unset: { facebookId: 1 } });
    const again = client();
    assert.equal((await oauth(again, 'google')).get('auth'), 'success');
    await Session.updateOne({ tokenHash: hashToken(again.jar.get('gc_session')) }, { $set: { reauthAt: new Date(Date.now() - 11 * 60_000) } });
    assert.equal((await oauth(again, 'facebook', { mode: 'link' })).get('auth_error'), 'reauth_required');
  });

  test('tài khoản không có mật khẩu: phiên nhận qua QR không tính là vừa xác thực', async () => {
    const c = client();
    await oauth(c, 'google');
    await c.post('/api/auth/signup/complete', { json: { name: 'Không Mật Khẩu', studentId: `OAUTH${uniqueSuffix()}` } });
    const device = client();
    const { challengeId, pollToken, matchCode } = (await device.post('/api/auth/qr/start')).data;
    await c.post(`/api/auth/qr/challenge/${challengeId}/approve`, { json: { matchCode } });
    assert.equal((await device.post('/api/auth/qr/poll', { json: { pollToken } })).data.status, 'approved');
    assert.equal((await oauth(device, 'facebook', { mode: 'link' })).get('auth_error'), 'reauth_required');
  });

  test('hủy đồng thời cả hai nhà cung cấp: tài khoản không mật khẩu vẫn còn đúng một phương thức đăng nhập', async () => {
    const c = client();
    await oauth(c, 'google');
    await c.post('/api/auth/signup/complete', { json: { name: 'Hai Liên Kết', studentId: `OAUTH${uniqueSuffix()}` } });
    await oauth(c, 'facebook', { mode: 'link' });
    const results = await Promise.all([c.del('/api/auth/providers/google'), c.del('/api/auth/providers/facebook')]);
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
    const { authMethods } = (await c.get('/api/auth/me')).data.user;
    assert.equal(Number(authMethods.google) + Number(authMethods.facebook), 1);
  });

  test('hủy liên kết: cần xác thực lại, thu hồi phiên khác, không xóa phương thức đăng nhập cuối cùng', async () => {
    const { c, email } = await victim();
    await reauth(c);
    await oauth(c, 'google', { mode: 'link' });
    const other = client();
    assert.equal((await oauth(other, 'google')).get('auth'), 'success');

    await Session.updateOne({ tokenHash: hashToken(c.jar.get('gc_session')) }, { $set: { reauthAt: new Date(0) } });
    assert.equal((await c.del('/api/auth/providers/google')).data.code, 'reauth_required');
    assert.equal((await client().del('/api/auth/providers/google')).status, 401);
    await reauth(c);
    assert.equal((await c.del('/api/auth/providers/twitter')).status, 404);
    const removed = await c.del('/api/auth/providers/google');
    assert.equal(removed.status, 200);
    assert.equal(removed.data.user.authMethods.google, false);
    assert.equal(await googleIdOf(email), undefined);
    assert.equal((await other.get('/api/auth/me')).status, 401, 'phiên mở bằng Google đã bị thu hồi');
    assert.equal((await c.get('/api/auth/me')).status, 200, 'phiên hiện tại vẫn còn');

    const googleOnly = client();
    identity.google = googleIdentity();
    await oauth(googleOnly, 'google');
    await googleOnly.post('/api/auth/signup/complete', { json: { name: 'Chỉ Có Google', studentId: `OAUTH${uniqueSuffix()}` } });
    const last = await googleOnly.del('/api/auth/providers/google');
    assert.equal(last.status, 409);
    assert.equal(last.data.code, 'last_login_method');
    assert.equal((await googleOnly.get('/api/auth/me')).data.user.authMethods.google, true);
  });
});
