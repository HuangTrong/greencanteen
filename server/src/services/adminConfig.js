import { env, envNumber } from './config.js';

const MINUTE_MS = 60 * 1000;

export const adminIdleTimeoutMs = () => envNumber('ADMIN_SESSION_IDLE_MINUTES', 15, { min: 1, max: 120 }) * MINUTE_MS;
export const adminSessionMaxMs = () => envNumber('ADMIN_SESSION_MAX_HOURS', 8, { min: 1, max: 24 }) * 60 * MINUTE_MS;
export const adminReauthWindowMs = () => envNumber('ADMIN_REAUTH_MINUTES', 5, { min: 1, max: 30 }) * MINUTE_MS;

/** ADMIN_MFA_KEY: 32 byte dạng base64 hoặc hex. Thiếu hoặc sai định dạng → khu quản trị bị tắt (fail closed) */
export function adminMfaKey() {
  const raw = env('ADMIN_MFA_KEY');
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

export const isAdminConfigured = () => adminMfaKey() !== null;
