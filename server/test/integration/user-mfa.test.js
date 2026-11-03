// 2FA cho sinh viên: TOTP và mã khôi phục, tự bật. Trọng tâm là không có đường nào vòng qua bước thứ hai sau khi đã bật,
// và kẻ chỉ giữ cookie phiên không tự bật, tắt hay đổi được 2FA của chủ tài khoản.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../../src/models/AuditLog.js';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { PendingMfaLogin } from '../../src/models/PendingMfaLogin.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { Session } from '../../src/models/Session.js';
import { User } from '../../src/models/User.js';
import { UserMfa } from '../../src/models/UserMfa.js';
import { hashToken } from '../../src/services/session.js';
import { totpCode, totpStep } from '../../src/services/totp.js';
import { ADMIN_ENV, auditEntries, enrolledAdmin, expireReauth } from '../adminHelpers.js';
import { startFakeSmtp } from '../fakes/smtp.js';
import { createClient, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';

const PASSWORD = 'mat-khau-an-toan-1';
let ctx;
let smtp;
let env;
const client = () => createClient(ctx.base);
const reauth = (c, password = PASSWORD, mfaCode) => c.post('/api/auth/reauth', { json: { password, code: mfaCode } });
const code = (secret, offset = 0) => totpCode(secret, totpStep() + offset);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const login = (c, email, password = PASSWORD) => c.post('/api/auth/login', { json: { email, password } });

async function waitForMail(email, pattern) {
  for (let i = 0; i < 100; i += 1) {
    const found = smtp.messages.find((m) => m.to.includes(`RCPT TO:<${email}>`) && pattern.test(m.text));
    if (found) return found;
    await wait(20);
  }
  return null;
}

/** Tài khoản đã bật 2FA, client có phiên. Dùng bước kế tiếp để lần xác minh sau trong test không trùng bước đã dùng */
async function withMfa() {
  const c = client();
  const { body, data } = await registerUser(c);
  assert.equal((await reauth(c)).status, 200);
  const { secret, otpauthUri } = (await c.post('/api/auth/mfa/setup')).data;
  const enabled = await c.post('/api/auth/mfa/enable', { json: { code: code(secret, -1) } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  return { c, email: body.email, id: data.user.id, secret, otpauthUri, recoveryCodes: enabled.data.recoveryCodes };
}

/** Cho phép dùng lại bước thời gian trong test: ngoài đời mỗi mã chỉ dùng được một lần */
const forgetStep = (id) => UserMfa.updateOne({ userId: id }, { $unset: { lastUsedStep: 1 } });

before(async () => {
  smtp = await startFakeSmtp();
  env = { ...ADMIN_ENV, EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_ALLOW_PLAINTEXT: 'true', EMAIL_FROM: 'no-reply@example.edu.vn', CLIENT_ORIGIN: 'https://gc.example.edu.vn' };
  setEnv(env);
  ctx = await startTestServer();
});
after(async () => {
  await ctx.stop();
  await smtp.close();
});
beforeEach(async () => {
  setEnv(env);
  smtp.messages.length = 0;
  await RateLimit.deleteMany({});
});

describe('bật 2FA', () => {
  test('mặc định chưa bật; thiếu khóa máy chủ thì báo chưa sẵn sàng, không giả vờ bật được', async () => {
    const c = client();
    await registerUser(c);
    assert.deepEqual((await c.get('/api/auth/security')).data.mfa, { available: true, enabled: false, recoveryCodesLeft: 0 });
    setEnv({ ...env, ADMIN_MFA_KEY: '' });
    assert.equal((await c.get('/api/auth/security')).data.mfa.available, false);
    await reauth(c);
    const setup = await c.post('/api/auth/mfa/setup');
    assert.equal(setup.status, 503);
    assert.equal(setup.data.code, 'mfa_not_configured');
  });

  test('kẻ chỉ giữ cookie phiên không tự bật 2FA được: phải xác thực lại trong 10 phút', async () => {
    const c = client();
    await registerUser(c);
    const res = await c.post('/api/auth/mfa/setup');
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'reauth_required');
    assert.equal((await client().post('/api/auth/mfa/setup')).status, 401);
  });

  test('chỉ bật sau khi nhập đúng mã từ ứng dụng; mã sai không bật và không cấp mã khôi phục', async () => {
    const c = client();
    const { data } = await registerUser(c);
    await reauth(c);
    const { secret, otpauthUri } = (await c.post('/api/auth/mfa/setup')).data;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(otpauthUri, /^otpauth:\/\/totp\/GreenCanteen:/);
    const wrong = await c.post('/api/auth/mfa/enable', { json: { code: '000000' } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.data.code, 'invalid_mfa_code');
    assert.equal((await c.get('/api/auth/security')).data.mfa.enabled, false);
    assert.equal((await c.post('/api/auth/mfa/enable', { json: { code: code(secret) } })).data.recoveryCodes.length, 8);
    assert.deepEqual((await c.get('/api/auth/security')).data.mfa, { available: true, enabled: true, recoveryCodesLeft: 8 });
    assert.ok(await AuditLog.exists({ action: 'account.mfa_enable', actorId: data.user.id, actorType: 'user' }));
  });

  test('đoán mã ở bước bật cũng bị giới hạn: 5 lần sai rồi mã đúng cũng bị chặn', async () => {
    const c = client();
    await registerUser(c);
    await reauth(c);
    const { secret } = (await c.post('/api/auth/mfa/setup')).data;
    for (let i = 0; i < 5; i += 1) assert.equal((await c.post('/api/auth/mfa/enable', { json: { code: '000000' } })).status, 400);
    assert.equal((await c.post('/api/auth/mfa/enable', { json: { code: code(secret) } })).status, 429);
    assert.equal((await c.get('/api/auth/security')).data.mfa.enabled, false);
  });

  test('DB không có secret hay mã khôi phục nguyên văn; bản mã không dùng được cho tài khoản khác', async () => {
    const { id, secret, recoveryCodes } = await withMfa();
    const stored = await UserMfa.findOne({ userId: id }).lean();
    const text = JSON.stringify(stored);
    assert.ok(!text.includes(secret));
    for (const recovery of recoveryCodes) assert.ok(!text.includes(recovery));
    const other = await withMfa();
    await UserMfa.updateOne({ userId: other.id }, { $set: { secretEnc: stored.secretEnc } });
    await forgetStep(other.id);
    const c = client();
    await login(c, other.email);
    assert.equal((await c.post('/api/auth/mfa/verify', { json: { code: code(secret) } })).status, 401);
  });

  test('bật xong đăng xuất các thiết bị khác, có thư báo; kẻ đang giữ phiên cũ bị đẩy ra', async () => {
    const stolen = client();
    const { body } = await registerUser(stolen);
    const owner = client();
    await login(owner, body.email);
    await reauth(owner);
    const { secret } = (await owner.post('/api/auth/mfa/setup')).data;
    await owner.post('/api/auth/mfa/enable', { json: { code: code(secret) } });
    assert.equal((await stolen.get('/api/auth/me')).status, 401);
    assert.equal((await owner.get('/api/auth/me')).status, 200);
    const mail = await waitForMail(body.email, /Xác thực hai lớp/);
    assert.ok(mail);
    assert.doesNotMatch(mail.text, /https?:\/\//);
  });

  test('đang bật thì không chạy lại bước thiết lập được để đổi secret', async () => {
    const { c, secret } = await withMfa();
    await reauth(c, PASSWORD, code(secret));
    const res = await c.post('/api/auth/mfa/setup');
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'mfa_already_enabled');
  });
});

describe('đăng nhập khi đã bật', () => {
  test('mật khẩu đúng chưa cho phiên; mã đúng mới cho phiên; mã dùng lại bị từ chối', async () => {
    const { email, secret } = await withMfa();
    const c = client();
    const first = await login(c, email);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { mfaRequired: true });
    assert.ok(!c.jar.has('gc_session'));
    assert.equal((await c.get('/api/auth/me')).status, 401);

    const value = code(secret);
    const passed = await c.post('/api/auth/mfa/verify', { json: { code: value } });
    assert.equal(passed.status, 200);
    assert.equal(passed.data.user.email, email);
    assert.ok(c.jar.has('gc_session'));
    assert.ok(!c.jar.has('gc_mfa'));

    const again = client();
    await login(again, email);
    assert.equal((await again.post('/api/auth/mfa/verify', { json: { code: value } })).status, 401, 'mỗi mã chỉ dùng một lần');
  });

  test('mật khẩu sai không tới bước hai, phản hồi không lộ tài khoản có 2FA', async () => {
    const { email } = await withMfa();
    const res = await login(client(), email, 'sai-mat-khau-123');
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'invalid_credentials');
  });

  test('không có cookie chờ, cookie giả hoặc đã hết hạn: không qua được bước hai', async () => {
    const { email, secret, id } = await withMfa();
    await forgetStep(id);
    assert.equal((await client().post('/api/auth/mfa/verify', { json: { code: code(secret) } })).data.code, 'mfa_expired');
    const c = client();
    c.jar.set('gc_mfa', 'A'.repeat(43));
    assert.equal((await c.post('/api/auth/mfa/verify', { json: { code: code(secret) } })).data.code, 'mfa_expired');
    const real = client();
    await login(real, email);
    await PendingMfaLogin.updateOne({ tokenHash: hashToken(real.jar.get('gc_mfa')) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await real.post('/api/auth/mfa/verify', { json: { code: code(secret) } })).data.code, 'mfa_expired');
  });

  test('đoán mã: 5 lần sai rồi bị chặn kể cả mã đúng; gửi đồng thời không vượt ngưỡng; giới hạn theo tài khoản, không theo trình duyệt', async () => {
    const { email, secret, id } = await withMfa();
    await forgetStep(id);
    const c = client();
    await login(c, email);
    const guesses = await Promise.all(Array.from({ length: 12 }, (_, i) => c.post('/api/auth/mfa/verify', { json: { code: String(100000 + i) } })));
    assert.equal(guesses.filter((res) => res.status === 401).length, 5);
    assert.equal(guesses.filter((res) => res.status === 429).length, 7);
    assert.equal((await c.post('/api/auth/mfa/verify', { json: { code: code(secret) } })).status, 429);
    const other = client();
    await login(other, email);
    assert.equal((await other.post('/api/auth/mfa/verify', { json: { code: code(secret) } })).status, 429);
  });

  test('toán tử hay kiểu lạ ở mã không qua được, không lỗi máy chủ', async () => {
    const { email } = await withMfa();
    for (const value of [{ $ne: null }, ['123456'], 123456, null, '', 'x'.repeat(5000)]) {
      await RateLimit.deleteMany({});
      const c = client();
      await login(c, email);
      assert.equal((await c.post('/api/auth/mfa/verify', { json: { code: value } })).status, 401, JSON.stringify(value)?.slice(0, 30));
    }
  });

  test('mã khôi phục dùng được đúng một lần, gửi đồng thời cũng một lần; có thư báo và nhật ký', async () => {
    const { email, recoveryCodes, id } = await withMfa();
    const [recovery] = recoveryCodes;
    const pending = await Promise.all(Array.from({ length: 3 }, async () => {
      const c = client();
      await login(c, email);
      return c;
    }));
    const results = await Promise.all(pending.map((c) => c.post('/api/auth/mfa/verify', { json: { code: recovery.toLowerCase() } })));
    assert.equal(results.filter((res) => res.status === 200).length, 1);
    const [winner] = pending.filter((c) => c.jar.has('gc_session'));
    assert.equal((await winner.get('/api/auth/security')).data.mfa.recoveryCodesLeft, 7);
    assert.ok(await AuditLog.exists({ action: 'account.mfa_recovery_used', actorId: id }));
    assert.ok(await waitForMail(email, /mã khôi phục/i));
  });

  test('tài khoản bị khóa giữa hai bước: mã đúng cũng không cho phiên', async () => {
    const { email, secret, id } = await withMfa();
    await forgetStep(id);
    const c = client();
    await login(c, email);
    await User.updateOne({ _id: id }, { $set: { status: 'locked' } });
    const res = await c.post('/api/auth/mfa/verify', { json: { code: code(secret) } });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'account_locked');
    assert.ok(!c.jar.has('gc_session'));
    await User.updateOne({ _id: id }, { $set: { status: 'active' } });
  });

  test('thu hồi phiên cũng hủy lượt đăng nhập đang chờ bước hai', async () => {
    const { c: owner, email, secret, id } = await withMfa();
    await forgetStep(id);
    const attacker = client();
    await login(attacker, email);
    await owner.post('/api/auth/sessions/revoke-others');
    assert.equal((await attacker.post('/api/auth/mfa/verify', { json: { code: code(secret) } })).data.code, 'mfa_expired');
  });
});

describe('không có đường vòng qua bước hai', () => {
  const resetToken = async (email) => {
    const user = await User.findOne({ email });
    const token = `${uniqueSuffix()}`.padEnd(43, 'M');
    await PasswordReset.create({ tokenHash: hashToken(token), userId: user._id, expiresAt: new Date(Date.now() + 60_000) });
    return token;
  };

  test('đặt lại mật khẩu qua email: đổi được mật khẩu nhưng chưa cho phiên, vẫn phải qua bước hai', async () => {
    const { email, secret, id } = await withMfa();
    await forgetStep(id);
    const c = client();
    const res = await c.post('/api/auth/password/reset', { json: { token: await resetToken(email), password: 'mat-khau-moi-rat-kho-9' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { mfaRequired: true });
    assert.ok(!c.jar.has('gc_session'));
    assert.equal((await c.post('/api/auth/mfa/verify', { json: { code: code(secret) } })).status, 200);
    assert.ok(c.jar.has('gc_session'));
  });

  test('phiên chờ bước hai không gọi được API cần đăng nhập', async () => {
    const { email } = await withMfa();
    const c = client();
    await login(c, email);
    for (const [method, path] of [['GET', '/api/auth/me'], ['GET', '/api/auth/security'], ['GET', '/api/checkin/history'], ['POST', '/api/gacha/spin'], ['POST', '/api/auth/mfa/setup']]) {
      assert.equal((await c.request(method, path)).status, 401, path);
    }
  });
});

describe('có phiên và mật khẩu nhưng không có thiết bị 2FA', () => {
  test('xác thực lại phải có mã 2FA: không thêm được passkey hay liên kết để vòng qua 2FA', async () => {
    const { c, id, secret } = await withMfa();
    await Session.updateMany({ userId: id }, { $set: { reauthAt: new Date(0) } });

    const onlyPassword = await reauth(c);
    assert.equal(onlyPassword.status, 400);
    assert.equal(onlyPassword.data.code, 'invalid_mfa_code');
    assert.equal((await reauth(c, PASSWORD, '000000')).data.code, 'invalid_mfa_code');
    assert.equal((await c.post('/api/auth/passkeys/register/options')).data.code, 'reauth_required');

    assert.equal((await reauth(c, PASSWORD, code(secret))).status, 200);
    assert.equal((await c.post('/api/auth/passkeys/register/options')).status, 200);
  });

  test('thử mật khẩu và mã qua xác thực lại chung một giới hạn: phiên bị đánh cắp không có thêm chỗ đoán mã', async () => {
    const { c, secret, id } = await withMfa();
    await forgetStep(id);
    for (let i = 0; i < 5; i += 1) await reauth(c, PASSWORD, '000000');
    assert.equal((await reauth(c, PASSWORD, code(secret))).status, 429);
  });
});

describe('tắt 2FA, mã khôi phục mới', () => {
  test('phiên bị đánh cắp không tắt được: cần xác thực lại và cả mã 2FA', async () => {
    const { c, id, secret } = await withMfa();
    await Session.updateMany({ userId: id }, { $set: { reauthAt: new Date(0) } });
    assert.equal((await c.post('/api/auth/mfa/disable', { json: { code: code(secret) } })).data.code, 'reauth_required');
    await reauth(c, PASSWORD, code(secret));
    assert.equal((await c.post('/api/auth/mfa/disable', { json: { code: '000000' } })).status, 400);
    assert.equal((await c.get('/api/auth/security')).data.mfa.enabled, true);
    await forgetStep(id);
    assert.equal((await c.post('/api/auth/mfa/disable', { json: { code: code(secret) } })).status, 200);
    assert.equal((await c.get('/api/auth/security')).data.mfa.enabled, false);
    assert.ok(await AuditLog.exists({ action: 'account.mfa_disable', actorId: id }));
    assert.equal(await UserMfa.countDocuments({ userId: id }), 0);
  });

  test('tắt xong đăng nhập trở lại một bước', async () => {
    const { c, email, id, secret } = await withMfa();
    await reauth(c, PASSWORD, code(secret));
    await forgetStep(id);
    await c.post('/api/auth/mfa/disable', { json: { code: code(secret) } });
    const fresh = client();
    assert.ok((await login(fresh, email)).data.user);
  });

  test('tạo mã khôi phục mới: mã cũ hết tác dụng, cần xác thực lại và mã 2FA', async () => {
    const { c, id, email, secret, recoveryCodes } = await withMfa();
    await Session.updateMany({ userId: id }, { $set: { reauthAt: new Date(0) } });
    assert.equal((await c.post('/api/auth/mfa/recovery-codes', { json: { code: code(secret) } })).data.code, 'reauth_required');
    await reauth(c, PASSWORD, code(secret));
    await forgetStep(id);
    const fresh = await c.post('/api/auth/mfa/recovery-codes', { json: { code: code(secret) } });
    assert.equal(fresh.data.recoveryCodes.length, 8);
    const other = client();
    await login(other, email);
    assert.equal((await other.post('/api/auth/mfa/verify', { json: { code: recoveryCodes[0] } })).status, 401);
    assert.equal((await other.post('/api/auth/mfa/verify', { json: { code: fresh.data.recoveryCodes[0] } })).status, 200);
  });

  for (const path of ['/api/auth/mfa/disable', '/api/auth/mfa/recovery-codes']) {
    test(`${path}: mật khẩu đi cùng mã trong một yêu cầu, không phải chờ mã kế tiếp`, async () => {
      const { c, id, secret } = await withMfa();
      await Session.updateMany({ userId: id }, { $set: { reauthAt: new Date(0) } });

      assert.equal((await c.post(path, { json: { password: 'sai-mat-khau', code: code(secret) } })).data.code, 'invalid_current_password');
      assert.equal((await c.post(path, { json: { password: { $ne: 1 }, code: code(secret) } })).data.code, 'invalid_current_password');
      assert.equal((await c.post(path, { json: { password: PASSWORD, code: '000000' } })).data.code, 'invalid_mfa_code');
      assert.equal((await c.post(path, { json: { password: PASSWORD } })).data.code, 'invalid_mfa_code');
      assert.equal((await c.get('/api/auth/security')).data.mfa.enabled, true);

      assert.equal((await c.post(path, { json: { password: PASSWORD, code: code(secret) } })).status, 200);
    });

    test(`${path}: đoán mật khẩu chung giới hạn với xác thực lại`, async () => {
      const { c, id, secret } = await withMfa();
      await Session.updateMany({ userId: id }, { $set: { reauthAt: new Date(0) } });
      for (let i = 0; i < 5; i += 1) await c.post(path, { json: { password: 'sai-mat-khau', code: '000000' } });
      assert.equal((await c.post(path, { json: { password: PASSWORD, code: code(secret) } })).status, 429);
      assert.equal((await reauth(c, PASSWORD, code(secret))).status, 429);
    });
  }

  test('mã khôi phục dùng khi xác thực lại hay khi tắt 2FA cũng có thư báo và nhật ký như lúc đăng nhập', async () => {
    const { c, email, id, recoveryCodes } = await withMfa();
    await Session.updateMany({ userId: id }, { $set: { reauthAt: new Date(0) } });
    assert.equal((await reauth(c, PASSWORD, recoveryCodes[0])).status, 200);
    assert.equal(await AuditLog.countDocuments({ action: 'account.mfa_recovery_used', actorId: id }), 1);
    assert.ok(await waitForMail(email, /mã khôi phục/i));

    smtp.messages.length = 0;
    assert.equal((await c.post('/api/auth/mfa/recovery-codes', { json: { code: recoveryCodes[1] } })).status, 200);
    assert.equal(await AuditLog.countDocuments({ action: 'account.mfa_recovery_used', actorId: id }), 2);
    assert.ok(await waitForMail(email, /mã khôi phục/i));
  });

  test('tài khoản chưa có mật khẩu: gửi mật khẩu kèm theo không mở được thao tác', async () => {
    const { c, id, secret } = await withMfa();
    await User.updateOne({ _id: id }, { $unset: { passwordHash: 1 } });
    await Session.updateMany({ userId: id }, { $set: { reauthAt: new Date(0) } });
    assert.equal((await c.post('/api/auth/mfa/disable', { json: { password: PASSWORD, code: code(secret) } })).data.code, 'invalid_current_password');
    assert.equal((await c.get('/api/auth/security')).data.mfa.enabled, true);
  });
});

describe('quản trị viên hỗ trợ khi mất thiết bị', () => {
  test('tắt 2FA của sinh viên: cần xác thực lại, có lý do, thu hồi phiên, ghi nhật ký, báo chủ tài khoản', async () => {
    const admin = await enrolledAdmin(ctx.base);
    const { id, email, c } = await withMfa();
    assert.equal((await admin.client.get(`/api/admin/users/${id}`)).data.userMfaEnabled, true);
    assert.equal((await admin.client.post(`/api/admin/users/${id}/student-mfa-reset`, { json: {} })).data.code, 'invalid_input');
    const res = await admin.client.post(`/api/admin/users/${id}/student-mfa-reset`, { json: { reason: 'Đã xác minh thẻ sinh viên' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.userMfaEnabled, false);
    assert.equal((await c.get('/api/auth/me')).status, 401, 'phiên cũ bị thu hồi');
    const [entry] = await auditEntries({ action: 'user.student_mfa_reset', targetId: id });
    assert.equal(entry.result, 'success');
    assert.ok(await waitForMail(email, /Xác thực hai lớp/));
    await User.deleteMany({ role: 'admin' });
  });

  test('phiên quản trị đã quá hạn xác thực lại: không tắt được 2FA của sinh viên', async () => {
    const admin = await enrolledAdmin(ctx.base);
    const { id } = await withMfa();
    await expireReauth(admin.client);
    const res = await admin.client.post(`/api/admin/users/${id}/student-mfa-reset`, { json: { reason: 'Thử khi chưa xác thực lại' } });
    assert.deepEqual([res.status, res.data.code], [403, 'reauth_required']);
    assert.equal(await UserMfa.countDocuments({ userId: id, enabledAt: { $ne: null } }), 1);
    await User.deleteMany({ role: 'admin' });
  });

  test('tài khoản chưa bật 2FA: báo không có gì để tắt', async () => {
    const admin = await enrolledAdmin(ctx.base);
    const { data } = await registerUser(client());
    const res = await admin.client.post(`/api/admin/users/${data.user.id}/student-mfa-reset`, { json: { reason: 'Thử nhầm tài khoản' } });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'no_change');
    await User.deleteMany({ role: 'admin' });
  });
});
