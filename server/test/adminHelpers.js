// Trợ giúp kiểm thử khu quản trị: tạo tài khoản admin và đi qua đúng luồng đăng nhập thật (mật khẩu → đăng ký MFA → phiên)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { User } from '../src/models/User.js';
import { AdminMfa } from '../src/models/AdminMfa.js';
import { AdminSession } from '../src/models/AdminSession.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { issueEnrollCode } from '../src/services/adminMfa.js';
import { hashPassword } from '../src/services/password.js';
import { hashToken } from '../src/services/session.js';
import { totpCode, totpStep } from '../src/services/totp.js';
import { createClient, uniqueSuffix } from './helpers.js';

export const MFA_KEY = crypto.randomBytes(32).toString('base64');
export const ADMIN_ENV = { ADMIN_MFA_KEY: MFA_KEY };
export const ADMIN_PASSWORD = 'mat-khau-quan-tri-an-toan-1';

let cachedPasswordHash;

/** Tài khoản đã có vai trò admin, chưa đăng ký MFA */
export async function createAdminUser(overrides = {}) {
  cachedPasswordHash ||= await hashPassword(ADMIN_PASSWORD);
  const suffix = uniqueSuffix();
  const user = await User.create({
    name: 'Quản Trị Viên',
    studentId: `ADMIN-${suffix}`,
    email: `admin${suffix}@example.edu.vn`,
    passwordHash: cachedPasswordHash,
    passwordChangedAt: new Date(),
    role: 'admin',
    ...overrides,
  });
  const { enrollCode } = await issueEnrollCode(user._id);
  return { user, enrollCode, email: user.email };
}

/** Client mang token CSRF như giao diện quản trị: đọc từ phản hồi đăng nhập, gửi kèm mọi request ghi */
export function adminClient(base) {
  const client = createClient(base);
  const withCsrf = (opts = {}) => ({ ...opts, headers: { 'X-CSRF-Token': client.csrf, ...opts.headers } });
  return {
    ...client,
    csrf: '',
    post: (path, opts) => client.post(path, withCsrf(opts)),
    put: (path, opts) => client.put(path, withCsrf(opts)),
    patch: (path, opts) => client.patch(path, withCsrf(opts)),
    del: (path, opts) => client.del(path, withCsrf(opts)),
    setCsrf(token) {
      client.csrf = token;
    },
    raw: client,
  };
}

export const currentCode = (secret, offset = 0) => totpCode(secret, totpStep() + offset);

/** Cho phép dùng lại bước TOTP hiện tại trong test: thực tế mỗi bước chỉ dùng được một lần */
export const clearUsedStep = (userId) => AdminMfa.updateOne({ userId }, { $unset: { lastUsedStep: 1 } });

export async function loginPassword(client, email, password = ADMIN_PASSWORD) {
  const res = await client.raw.post('/api/admin/auth/login', { json: { email, password } });
  if (res.data?.csrfToken) client.setCsrf(res.data.csrfToken);
  return res;
}

/** Đăng nhập trọn vẹn lần đầu: mật khẩu → mã đăng ký → xác nhận TOTP. Trả về client đã có phiên quản trị */
export async function enrolledAdmin(base, overrides = {}) {
  const { user, enrollCode, email } = await createAdminUser(overrides);
  const client = adminClient(base);
  const login = await loginPassword(client, email);
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const setup = await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode } });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const { secret } = setup.data;
  const verify = await client.post('/api/admin/auth/mfa/verify', { json: { code: currentCode(secret) } });
  assert.equal(verify.status, 200, JSON.stringify(verify.data));
  client.setCsrf(verify.data.csrfToken);
  return { client, user, email, secret, recoveryCodes: verify.data.recoveryCodes };
}

export const sessionOf = (client) => AdminSession.findOne({ tokenHash: hashToken(decodeURIComponent(client.jar.get('gc_admin'))) });

/** Làm cho "vừa xác thực lại" hết hiệu lực */
export const expireReauth = (client) =>
  AdminSession.updateOne({ tokenHash: hashToken(decodeURIComponent(client.jar.get('gc_admin'))) }, { $set: { reauthAt: new Date(0) } });

export const auditEntries = (filter = {}) => AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).lean();

/** Xác nhận không có bí mật nào trong phản hồi hoặc bản ghi */
export function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  for (const pattern of [/passwordHash/i, /scrypt\$/, /tokenHash/i, /claimCodeHash/i, /secretEnc/i, /recoveryCodeHashes/i, /enrollCodeHash/i, /googleId/i, /facebookId/i]) {
    assert.doesNotMatch(text, pattern);
  }
}
