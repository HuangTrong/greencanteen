import crypto from 'crypto';
import { clientOrigin, env } from './config.js';

export { clientOrigin };

function providerConfig(provider) {
  if (provider === 'google') {
    return {
      clientId: env('GOOGLE_CLIENT_ID'),
      clientSecret: env('GOOGLE_CLIENT_SECRET'),
      callbackUrl: env('GOOGLE_CALLBACK_URL') || `${clientOrigin()}/api/auth/google/callback`,
    };
  }
  if (provider === 'facebook') {
    return {
      clientId: env('FACEBOOK_APP_ID'),
      clientSecret: env('FACEBOOK_APP_SECRET'),
      callbackUrl: env('FACEBOOK_CALLBACK_URL') || `${clientOrigin()}/api/auth/facebook/callback`,
      graphVersion: env('FACEBOOK_GRAPH_VERSION') || 'v23.0',
    };
  }
  return null;
}

export function isProviderConfigured(provider) {
  const cfg = providerConfig(provider);
  return Boolean(cfg?.clientId && cfg?.clientSecret);
}

export function isQrLoginEnabled() {
  return env('QR_LOGIN_ENABLED') !== 'false';
}

export function logAuthProviderStatus() {
  if (!isProviderConfigured('google')) {
    console.log('Google OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) — Google login disabled.');
  }
  if (!isProviderConfigured('facebook')) {
    console.log('Facebook OAuth not configured (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET) — Facebook login disabled.');
  }
  if (!isQrLoginEnabled()) console.log('QR_LOGIN_ENABLED=false — QR login disabled.');
}

export function buildAuthorizationUrl(provider, { state, codeVerifier }) {
  const cfg = providerConfig(provider);
  if (provider === 'google') {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }
  const url = new URL(`https://www.facebook.com/${cfg.graphVersion}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.callbackUrl,
    response_type: 'code',
    scope: 'public_profile,email',
    state,
  }).toString();
  return url.toString();
}

/** Đổi authorization code lấy danh tính người dùng (gọi trực tiếp server → nhà cung cấp) */
export function fetchProviderProfile(provider, { code, codeVerifier }) {
  return provider === 'google' ? fetchGoogleProfile(code, codeVerifier) : fetchFacebookProfile(code);
}

async function fetchJson(url, init) {
  // Hai điểm cuối này không có lý do chuyển hướng; đi theo sẽ gửi lại client_secret hoặc access token tới địa chỉ khác
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error?.message || `HTTP ${res.status}`);
  }
  return data;
}

async function fetchGoogleProfile(code, codeVerifier) {
  const cfg = providerConfig('google');
  const tokens = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.callbackUrl,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  // id_token nhận trực tiếp từ token endpoint của Google qua TLS nên (OIDC Core 3.1.3.7)
  // không cần kiểm chữ ký, nhưng vẫn phải kiểm issuer, audience và hạn dùng
  const claims = decodeJwtPayload(tokens.id_token);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) ||
    !audiences.includes(cfg.clientId) ||
    !(Number(claims.exp) * 1000 > Date.now()) ||
    !claims.sub
  ) {
    throw new Error('Google ID token không hợp lệ');
  }

  const email = claims.email ? String(claims.email).toLowerCase() : '';
  return {
    providerId: String(claims.sub),
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: String(claims.name || email.split('@')[0] || ''),
  };
}

function decodeJwtPayload(jwt) {
  const payload = String(jwt || '').split('.')[1];
  if (!payload) throw new Error('Thiếu Google ID token');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Không đọc được Google ID token');
  }
}

async function fetchFacebookProfile(code) {
  const cfg = providerConfig('facebook');
  const graph = `https://graph.facebook.com/${cfg.graphVersion}`;

  const tokenUrl = new URL(`${graph}/oauth/access_token`);
  tokenUrl.search = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.callbackUrl,
    code,
  }).toString();
  const { access_token: accessToken } = await fetchJson(tokenUrl);
  if (!accessToken) throw new Error('Facebook không trả về access token');

  const meUrl = new URL(`${graph}/me`);
  meUrl.search = new URLSearchParams({
    fields: 'id,name,email',
    access_token: accessToken,
    appsecret_proof: crypto.createHmac('sha256', cfg.clientSecret).update(accessToken).digest('hex'),
  }).toString();
  const me = await fetchJson(meUrl);
  if (!me.id) throw new Error('Không đọc được hồ sơ Facebook');

  return {
    providerId: String(me.id),
    email: me.email ? String(me.email).toLowerCase() : '',
    // Graph API không cho biết email đã được xác minh → không dùng làm email tài khoản
    emailVerified: false,
    name: String(me.name || ''),
  };
}
