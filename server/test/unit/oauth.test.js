// OAuth Google / Facebook với nhà cung cấp giả lập (thay fetch) — không cần client ID/secret thật, không gọi mạng
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildAuthorizationUrl,
  fetchProviderProfile,
  isProviderConfigured,
  isQrLoginEnabled,
  logAuthProviderStatus,
} from '../../src/services/oauth.js';
import { realFetch, setEnv } from '../helpers.js';

const GOOGLE = { GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-secret' };
const FACEBOOK = { FACEBOOK_APP_ID: 'fb-app', FACEBOOK_APP_SECRET: 'fb-secret' };

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (claims) => `${base64url({ alg: 'RS256' })}.${base64url(claims)}.chu-ky-khong-kiem-tra`;
const validClaims = () => ({
  iss: 'https://accounts.google.com',
  aud: GOOGLE.GOOGLE_CLIENT_ID,
  sub: '1098765',
  email: 'An.Nguyen@Gmail.com',
  email_verified: true,
  name: 'Nguyễn An',
  exp: Math.floor(Date.now() / 1000) + 600,
});

/** Thay fetch toàn cục: routes = { 'https://...': (url, init) => Response } — URL không khai báo thì báo lỗi */
function fakeProvider(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    const route = Object.keys(routes).find((prefix) => href.startsWith(prefix));
    if (!route) throw new Error(`fetch ngoài dự kiến: ${href}`);
    const { status = 200, body } = routes[route](href, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setEnv();
});

describe('cấu hình nhà cung cấp', () => {
  test('thiếu ID hoặc secret → chưa cấu hình', () => {
    assert.equal(isProviderConfigured('google'), false);
    setEnv({ GOOGLE_CLIENT_ID: 'id' });
    assert.equal(isProviderConfigured('google'), false);
    setEnv(GOOGLE);
    assert.equal(isProviderConfigured('google'), true);
    setEnv({ FACEBOOK_APP_SECRET: 'x' });
    assert.equal(isProviderConfigured('facebook'), false);
    assert.equal(isProviderConfigured('github'), false, 'nhà cung cấp lạ');
  });

  test('QR bật mặc định, chỉ tắt khi QR_LOGIN_ENABLED=false', () => {
    assert.equal(isQrLoginEnabled(), true);
    setEnv({ QR_LOGIN_ENABLED: 'false' });
    assert.equal(isQrLoginEnabled(), false);
    setEnv({ QR_LOGIN_ENABLED: '0' });
    assert.equal(isQrLoginEnabled(), true, 'chỉ đúng chuỗi "false" mới tắt');
  });

  test('log trạng thái khi khởi động', () => {
    setEnv({ QR_LOGIN_ENABLED: 'false' });
    const lines = [];
    const original = console.log;
    console.log = (msg) => lines.push(msg);
    try {
      logAuthProviderStatus();
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 3);
    assert.match(lines.join('\n'), /Google OAuth not configured[\s\S]*Facebook OAuth not configured[\s\S]*QR login disabled/);
  });
});

describe('URL ủy quyền', () => {
  test('Google: state, PKCE S256 đúng chuẩn, callback mặc định theo CLIENT_ORIGIN', () => {
    setEnv({ ...GOOGLE, CLIENT_ORIGIN: 'https://gc.example.edu.vn' });
    const url = new URL(buildAuthorizationUrl('google', { state: 'st', codeVerifier: 'verifier-abc' }));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('state'), 'st');
    assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256').update('verifier-abc').digest('base64url'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://gc.example.edu.vn/api/auth/google/callback');
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.ok(!url.href.includes('google-secret'), 'secret không bao giờ nằm trên URL trình duyệt');
  });

  test('Facebook: phiên bản Graph cấu hình được, có state', () => {
    setEnv({ ...FACEBOOK, FACEBOOK_GRAPH_VERSION: 'v99.0', FACEBOOK_CALLBACK_URL: 'https://x.vn/cb' });
    const url = new URL(buildAuthorizationUrl('facebook', { state: 'st', codeVerifier: 'v' }));
    assert.equal(url.pathname, '/v99.0/dialog/oauth');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://x.vn/cb');
    assert.equal(url.searchParams.get('state'), 'st');
    assert.ok(!url.href.includes('fb-secret'));
  });
});

describe('Google — kiểm tra ID token', () => {
  const tokenEndpoint = (claims) => ({ 'https://oauth2.googleapis.com/token': () => ({ body: { id_token: idToken(claims) } }) });

  test('hợp lệ → hồ sơ (email chữ thường, đã xác minh); gửi code_verifier và secret qua body POST', async () => {
    setEnv(GOOGLE);
    const calls = fakeProvider(tokenEndpoint(validClaims()));
    const profile = await fetchProviderProfile('google', { code: 'auth-code', codeVerifier: 'verifier' });
    assert.deepEqual(profile, { providerId: '1098765', email: 'an.nguyen@gmail.com', emailVerified: true, name: 'Nguyễn An' });
    assert.equal(calls[0].init.method, 'POST');
    const body = new URLSearchParams(String(calls[0].init.body));
    assert.equal(body.get('code_verifier'), 'verifier');
    assert.equal(body.get('client_secret'), 'google-secret');
    assert.ok(!calls[0].href.includes('google-secret'));
  });

  test('aud dạng mảng, iss không có https, email_verified dạng chuỗi', async () => {
    setEnv(GOOGLE);
    fakeProvider(tokenEndpoint({ ...validClaims(), aud: ['khac', GOOGLE.GOOGLE_CLIENT_ID], iss: 'accounts.google.com', email_verified: 'true' }));
    const profile = await fetchProviderProfile('google', { code: 'c', codeVerifier: 'v' });
    assert.equal(profile.emailVerified, true);
  });

  for (const [label, claims] of [
    ['issuer giả mạo', { iss: 'https://evil.example.com' }],
    ['audience của ứng dụng khác', { aud: 'other-app.apps.googleusercontent.com' }],
    ['token hết hạn', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['thiếu sub', { sub: '' }],
  ]) {
    test(`từ chối: ${label}`, async () => {
      setEnv(GOOGLE);
      fakeProvider(tokenEndpoint({ ...validClaims(), ...claims }));
      await assert.rejects(fetchProviderProfile('google', { code: 'c', codeVerifier: 'v' }), /Google ID token không hợp lệ/);
    });
  }

  test('lỗi từ token endpoint / thiếu hoặc hỏng ID token', async () => {
    setEnv(GOOGLE);
    fakeProvider({ 'https://oauth2.googleapis.com/token': () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } }) });
    await assert.rejects(fetchProviderProfile('google', { code: 'c', codeVerifier: 'v' }), /Bad Request/);
    fakeProvider({ 'https://oauth2.googleapis.com/token': () => ({ body: {} }) });
    await assert.rejects(fetchProviderProfile('google', { code: 'c', codeVerifier: 'v' }), /Thiếu Google ID token/);
    fakeProvider({ 'https://oauth2.googleapis.com/token': () => ({ body: { id_token: 'a.khong-phai-base64-json.c' } }) });
    await assert.rejects(fetchProviderProfile('google', { code: 'c', codeVerifier: 'v' }), /Không đọc được Google ID token/);
    fakeProvider({ 'https://oauth2.googleapis.com/token': () => ({ status: 502, body: 'not json' }) });
    await assert.rejects(fetchProviderProfile('google', { code: 'c', codeVerifier: 'v' }), /HTTP 502/);
  });
});

describe('Facebook — đổi code lấy hồ sơ', () => {
  test('gửi appsecret_proof đúng HMAC; email Facebook không được coi là đã xác minh', async () => {
    setEnv(FACEBOOK);
    const calls = fakeProvider({
      'https://graph.facebook.com/v23.0/oauth/access_token': () => ({ body: { access_token: 'fb-access-token' } }),
      'https://graph.facebook.com/v23.0/me': () => ({ body: { id: '777', name: 'Trần Bình', email: 'Binh@Example.com' } }),
    });
    const profile = await fetchProviderProfile('facebook', { code: 'fb-code' });
    assert.deepEqual(profile, { providerId: '777', email: 'binh@example.com', emailVerified: false, name: 'Trần Bình' });
    const me = new URL(calls[1].href);
    assert.equal(me.searchParams.get('appsecret_proof'), crypto.createHmac('sha256', 'fb-secret').update('fb-access-token').digest('hex'));
    assert.equal(me.searchParams.get('fields'), 'id,name,email');
  });

  test('F-53: gọi nhà cung cấp không đi theo chuyển hướng: client_secret và access token không bị gửi tới địa chỉ khác', async () => {
    setEnv(FACEBOOK);
    const calls = fakeProvider({
      'https://graph.facebook.com/v23.0/oauth/access_token': () => ({ body: { access_token: 'fb-access-token' } }),
      'https://graph.facebook.com/v23.0/me': () => ({ body: { id: '777', name: 'Trần Bình' } }),
    });
    await fetchProviderProfile('facebook', { code: 'fb-code' });
    assert.deepEqual(calls.map(({ init }) => init.redirect), ['error', 'error']);
  });

  test('thiếu access token / thiếu id / lỗi Graph API', async () => {
    setEnv(FACEBOOK);
    fakeProvider({ 'https://graph.facebook.com/v23.0/oauth/access_token': () => ({ body: {} }) });
    await assert.rejects(fetchProviderProfile('facebook', { code: 'c' }), /không trả về access token/);
    fakeProvider({
      'https://graph.facebook.com/v23.0/oauth/access_token': () => ({ body: { access_token: 't' } }),
      'https://graph.facebook.com/v23.0/me': () => ({ body: { name: 'Không có id' } }),
    });
    await assert.rejects(fetchProviderProfile('facebook', { code: 'c' }), /Không đọc được hồ sơ Facebook/);
    fakeProvider({
      'https://graph.facebook.com/v23.0/oauth/access_token': () => ({ status: 400, body: { error: { message: 'Invalid verification code' } } }),
    });
    await assert.rejects(fetchProviderProfile('facebook', { code: 'c' }), /Invalid verification code/);
  });
});
