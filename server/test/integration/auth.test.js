import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../../src/models/User.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { Session } from '../../src/models/Session.js';
import { generateClaimCode, normalizeClaimCode } from '../../src/services/accounts.js';
import { hashToken } from '../../src/services/session.js';
import { createClient, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';

let ctx;
const client = () => createClient(ctx.base);

before(async () => {
  setEnv();
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv();
  await RateLimit.deleteMany({});
});

/** Bắt nội dung email in ra ở chế độ console để lấy liên kết đặt lại mật khẩu */
async function captureResetLink(trigger) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await trigger();
    for (let i = 0; i < 50 && !lines.some((l) => l.includes('#reset=')); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    console.log = original;
  }
  const match = lines.join('\n').match(/#reset=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

describe('bảo vệ API bằng phiên đăng nhập', () => {
  test('API cá nhân trả 401 khi chưa đăng nhập', async () => {
    const c = client();
    for (const [method, path] of [
      ['GET', '/api/auth/me'],
      ['GET', '/api/checkin/history'],
      ['GET', '/api/gacha/rewards'],
      ['POST', '/api/gacha/spin'],
      ['POST', '/api/checkin'],
      ['POST', '/api/auth/password/change'],
    ]) {
      const res = await c.request(method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.data.code, 'auth_required');
    }
  });

  test('request thay đổi dữ liệu thiếu header chống CSRF bị từ chối', async () => {
    const res = await client().post('/api/auth/login', { json: { email: 'a@b.vn', password: 'x' }, csrf: false });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'csrf_rejected');
  });

  test('mã sinh viên client gửi không phải bằng chứng sở hữu tài khoản', async () => {
    const a = client();
    const b = client();
    const { body: aBody } = await registerUser(a);
    await registerUser(b);

    const history = await b.get(`/api/checkin/history/${encodeURIComponent(aBody.studentId)}`);
    assert.equal(history.status, 403);
    const rewards = await b.get(`/api/gacha/rewards/${encodeURIComponent(aBody.studentId)}`);
    assert.equal(rewards.status, 403);
    const spin = await b.post('/api/gacha/spin', { json: { studentId: aBody.studentId } });
    assert.equal(spin.status, 403);
  });

  test('JSON sai cú pháp và API không tồn tại đều trả lỗi JSON', async () => {
    const bad = await client().post('/api/auth/login', { json: '{oops' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, 'invalid_json');
    const missing = await client().get('/api/khong-co');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.code, 'not_found');
  });
});

describe('đăng ký / đăng nhập email', () => {
  test('đăng ký không lưu Khoa/Viện, Lớp; đăng nhập lại được', async () => {
    const c = client();
    const res = await registerUser(c, { department: 'CNTT', className: 'K65' });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.authMethods.password, true);
    assert.ok(c.jar.has('gc_session'));

    const stored = await User.findOne({ email: res.body.email }).select('+passwordHash').lean();
    assert.equal(stored.department, undefined);
    assert.equal(stored.className, undefined);
    assert.match(stored.passwordHash, /^scrypt\$/);
    assert.ok(!JSON.stringify(stored).includes(res.body.password), 'không lưu mật khẩu dạng rõ');

    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.studentId, res.body.studentId);

    await c.post('/api/auth/logout');
    assert.equal((await c.get('/api/auth/me')).status, 401);

    const wrong = await c.post('/api/auth/login', { json: { email: res.body.email, password: 'sai-mat-khau' } });
    assert.equal(wrong.status, 401);
    const ok = await c.post('/api/auth/login', { json: { email: res.body.email, password: res.body.password } });
    assert.equal(ok.status, 200);
  });

  test('không tạo trùng mã SV (không phân biệt hoa thường) hoặc email', async () => {
    const { body } = await registerUser(client());
    // Từ chối xảy ra ở bước xác minh, sau khi người gửi đã chứng minh email của mình, và không nêu trường nào trùng (F-06)
    const sameId = await registerUser(client(), { studentId: body.studentId.toLowerCase() });
    assert.equal(sameId.status, 409);
    assert.equal(sameId.data.code, 'registration_conflict');
    assert.equal(await User.countDocuments({ studentId: new RegExp(`^${body.studentId}$`, 'i') }), 1);
    // Trùng email: không có liên kết kích hoạt nào được gửi
    const sameEmail = await registerUser(client(), { email: body.email });
    assert.equal(sameEmail.status, 202);
    assert.equal(sameEmail.token, null);
    assert.equal(await User.countDocuments({ email: body.email }), 1);
  });

  test('đăng nhập kiểu cũ chỉ bằng mã SV + họ tên đã bị gỡ', async () => {
    const res = await client().post('/api/auth/login', { json: { studentId: 'SV1', name: 'Ai đó' } });
    assert.equal(res.status, 410);
  });

  test('đăng nhập sai nhiều lần bị giới hạn', async () => {
    const { body } = await registerUser(client());
    const c = client();
    for (let i = 0; i < 10; i += 1) {
      await c.post('/api/auth/login', { json: { email: body.email, password: `sai-${i}` } });
    }
    const limited = await c.post('/api/auth/login', { json: { email: body.email, password: body.password } });
    assert.equal(limited.status, 429);
  });
});

describe('tài khoản cũ (đăng nhập mô phỏng) — nhận lại bằng mã kích hoạt', () => {
  test('không nhận được bằng mã SV; nhận được bằng mã do quản trị viên cấp, giữ nguyên điểm và lịch sử', async () => {
    const studentId = `LEG${uniqueSuffix()}`;
    const legacy = await User.create({
      studentId,
      name: 'Tài khoản cũ',
      department: 'Khoa cũ',
      className: 'Lớp cũ',
      ecoPoints: 120,
      totalCheckIns: 12,
      pendingGachaSpins: 2,
    });
    await CheckIn.create({ userId: legacy._id, studentId, valid: true, pointsEarned: 10 });

    const noCode = await registerUser(client(), { studentId });
    assert.equal(noCode.status, 409);
    assert.equal(noCode.data.code, 'legacy_claim_required');

    const wrongCode = await registerUser(client(), { studentId, claimCode: 'AAAA-BBBB-CCCC' });
    assert.equal(wrongCode.status, 400);
    assert.equal(wrongCode.data.code, 'invalid_claim_code');

    const code = generateClaimCode();
    await User.updateOne(
      { _id: legacy._id },
      { $set: { claimCodeHash: hashToken(normalizeClaimCode(code)), claimCodeExpiresAt: new Date(Date.now() + 3600e3) } }
    );
    const c = client();
    const claimed = await registerUser(c, { studentId, claimCode: code.toLowerCase() });
    assert.equal(claimed.status, 201);
    assert.equal(claimed.data.claimed, true);
    assert.equal(claimed.data.user.id, legacy._id.toString(), 'không tạo tài khoản mới');
    assert.equal(claimed.data.user.ecoPoints, 120);
    assert.equal(claimed.data.user.pendingGachaSpins, 2);
    assert.equal((await c.get('/api/checkin/history')).data.history.length, 1);
    assert.equal(await User.countDocuments({ studentId }), 1);

    const reuse = await registerUser(client(), { studentId, claimCode: code });
    assert.equal(reuse.status, 409, 'mã kích hoạt chỉ dùng một lần');
    assert.equal(reuse.data.code, 'registration_conflict');
  });
});

describe('quên / đặt lại mật khẩu', () => {
  test('thiếu cấu hình email: báo chưa cấu hình, không báo đã gửi', async () => {
    const providers = await client().get('/api/auth/providers');
    assert.equal(providers.data.providers.passwordReset.enabled, false);
    const res = await client().post('/api/auth/password/forgot', { json: { email: 'ai@example.edu.vn' } });
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'email_not_configured');
  });

  test('console transport bị chặn trong production', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console', NODE_ENV: 'production' });
    const res = await client().post('/api/auth/password/forgot', { json: { email: 'ai@example.edu.vn' } });
    assert.equal(res.status, 503);
  });

  test('phản hồi giống nhau dù email có tài khoản hay không; token dùng một lần, lưu dạng băm', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console' });
    const oldDevice = client();
    const { body } = await registerUser(oldDevice);

    const unknown = await client().post('/api/auth/password/forgot', { json: { email: `khong-co-${uniqueSuffix()}@example.edu.vn` } });
    let known;
    const token = await captureResetLink(async () => {
      known = await client().post('/api/auth/password/forgot', { json: { email: body.email } });
    });
    assert.equal(unknown.status, 202);
    assert.equal(known.status, 202);
    assert.deepEqual(known.data, unknown.data);
    assert.ok(token, 'liên kết được "gửi" (in ra log ở chế độ console)');

    const user = await User.findOne({ email: body.email });
    const stored = await PasswordReset.findOne({ userId: user._id }).lean();
    assert.equal(stored.tokenHash, hashToken(token));
    assert.ok(!JSON.stringify(stored).includes(token), 'DB không chứa token gốc');

    const tooShort = await client().post('/api/auth/password/reset', { json: { token, password: '123' } });
    assert.equal(tooShort.status, 400);
    assert.equal(tooShort.data.code, 'invalid_input');

    const newDevice = client();
    const reset = await newDevice.post('/api/auth/password/reset', { json: { token, password: 'mat-khau-moi-123' } });
    assert.equal(reset.status, 200);
    assert.equal((await newDevice.get('/api/auth/me')).status, 200, 'đăng nhập luôn sau khi đặt lại');
    assert.equal((await oldDevice.get('/api/auth/me')).status, 401, 'phiên cũ bị thu hồi');

    const again = await client().post('/api/auth/password/reset', { json: { token, password: 'mat-khau-khac-123' } });
    assert.equal(again.status, 400);
    assert.equal(again.data.code, 'reset_token_invalid');

    const oldLogin = await client().post('/api/auth/login', { json: { email: body.email, password: body.password } });
    assert.equal(oldLogin.status, 401);
    const newLogin = await client().post('/api/auth/login', { json: { email: body.email, password: 'mat-khau-moi-123' } });
    assert.equal(newLogin.status, 200);
  });

  test('token hết hạn bị từ chối; nhiều lần thử sai bị giới hạn', async () => {
    const { body } = await registerUser(client());
    const user = await User.findOne({ email: body.email });
    const token = 'A'.repeat(43);
    await PasswordReset.create({ tokenHash: hashToken(token), userId: user._id, expiresAt: new Date(Date.now() - 1000) });
    const expired = await client().post('/api/auth/password/reset', { json: { token, password: 'mat-khau-moi-123' } });
    assert.equal(expired.status, 400);

    for (let i = 0; i < 10; i += 1) {
      await client().post('/api/auth/password/reset', { json: { token: `${'B'.repeat(40)}${i}xx`, password: 'mat-khau-moi-123' } });
    }
    const limited = await client().post('/api/auth/password/reset', { json: { token, password: 'mat-khau-moi-123' } });
    assert.equal(limited.status, 429);
  });

  test('giới hạn số lần yêu cầu cho cùng một email', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console' });
    const email = `gioi-han-${uniqueSuffix()}@example.edu.vn`;
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await client().post('/api/auth/password/forgot', { json: { email } })).status);
    }
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
  });
});

describe('quản lý tài khoản', () => {
  test('đổi mật khẩu: kiểm tra mật khẩu hiện tại, giữ phiên này, đăng xuất thiết bị khác', async () => {
    const c1 = client();
    const { body } = await registerUser(c1);
    const c2 = client();
    await c2.post('/api/auth/login', { json: { email: body.email, password: body.password } });

    const wrong = await c1.post('/api/auth/password/change', {
      json: { currentPassword: 'khong-dung', newPassword: 'mat-khau-moi-123' },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.data.code, 'invalid_current_password');

    const ok = await c1.post('/api/auth/password/change', {
      json: { currentPassword: body.password, newPassword: 'mat-khau-moi-123' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.revokedSessions, 1);
    assert.equal((await c1.get('/api/auth/me')).status, 200);
    assert.equal((await c2.get('/api/auth/me')).status, 401);
  });

  test('tài khoản chưa có mật khẩu không đổi mật khẩu được; không có API đổi mã SV', async () => {
    const user = await User.create({ studentId: `G${uniqueSuffix()}`, name: 'Google User', googleId: `g-${uniqueSuffix()}` });
    const c = client();
    // Phiên tạo trực tiếp như sau khi đăng nhập Google thành công
    const token = `test-${uniqueSuffix()}`;
    await Session.create({ tokenHash: hashToken(token), userId: user._id, expiresAt: new Date(Date.now() + 3600e3) });
    c.jar.set('gc_session', token);

    const res = await c.post('/api/auth/password/change', { json: { currentPassword: '', newPassword: 'mat-khau-moi-123' } });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'no_password');

    for (const method of ['POST', 'PUT', 'PATCH']) {
      const change = await c.request(method, '/api/auth/me', { json: { studentId: 'HACKED' } });
      assert.equal(change.status, 404, `${method} /api/auth/me`);
    }
    assert.equal((await User.findById(user._id)).studentId, user.studentId);
  });

  test('đăng xuất các thiết bị khác', async () => {
    const c1 = client();
    const { body } = await registerUser(c1);
    const c2 = client();
    await c2.post('/api/auth/login', { json: { email: body.email, password: body.password } });
    const res = await c1.post('/api/auth/sessions/revoke-others');
    assert.equal(res.data.revokedSessions, 1);
    assert.equal((await c1.get('/api/auth/me')).status, 200);
    assert.equal((await c2.get('/api/auth/me')).status, 401);
  });
});

describe('OAuth chưa cấu hình', () => {
  test('nút Google/Facebook báo chưa sẵn sàng và không giả lập đăng nhập', async () => {
    const providers = await client().get('/api/auth/providers');
    assert.equal(providers.data.providers.google.enabled, false);
    assert.equal(providers.data.providers.facebook.enabled, false);
    for (const provider of ['google', 'facebook']) {
      const c = client();
      const res = await c.get(`/api/auth/${provider}/start`);
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /auth_error=provider_not_configured/);
      assert.ok(!c.jar.has('gc_session'));
    }
  });

  test('khi đã cấu hình, chuyển hướng tới nhà cung cấp kèm state và PKCE', async () => {
    setEnv({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret' });
    const c = client();
    const res = await c.get('/api/auth/google/start');
    const location = new URL(res.headers.get('location'));
    assert.equal(location.host, 'accounts.google.com');
    assert.ok(location.searchParams.get('state'));
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(c.jar.has('gc_oauth'));

    const forged = await c.get('/api/auth/google/callback?code=x&state=sai');
    assert.match(forged.headers.get('location'), /auth_error=invalid_state/);
    assert.ok(!c.jar.has('gc_session'));
  });
});

describe('đăng nhập bằng QR', () => {
  test('thử thách dùng một lần, chỉ thiết bị giữ pollToken nhận phiên sau khi được xác nhận', async () => {
    const phone = client();
    const { body } = await registerUser(phone);
    const laptop = client();

    const start = await laptop.post('/api/auth/qr/start');
    assert.equal(start.status, 200);
    const { challengeId, pollToken, matchCode } = start.data;
    assert.notEqual(challengeId, pollToken);

    assert.equal((await laptop.post('/api/auth/qr/poll', { json: { pollToken } })).data.status, 'pending');
    assert.equal((await client().post(`/api/auth/qr/challenge/${challengeId}/approve`)).status, 401);

    const info = await phone.get(`/api/auth/qr/challenge/${challengeId}`);
    assert.equal(info.status, 200);
    assert.ok(info.data.device);
    assert.equal((await phone.post(`/api/auth/qr/challenge/${challengeId}/approve`, { json: { matchCode } })).status, 200);

    // Biết challengeId (nằm trong QR) không đủ để nhận phiên
    const attacker = client();
    const guess = await attacker.post('/api/auth/qr/poll', { json: { pollToken: challengeId } });
    assert.equal(guess.data.status, 'expired');

    const approved = await laptop.post('/api/auth/qr/poll', { json: { pollToken } });
    assert.equal(approved.data.status, 'approved');
    assert.equal(approved.data.user.studentId, body.studentId);
    assert.equal((await laptop.get('/api/auth/me')).status, 200);

    const again = await client().post('/api/auth/qr/poll', { json: { pollToken } });
    assert.equal(again.data.status, 'expired');
    assert.equal((await phone.post(`/api/auth/qr/challenge/${challengeId}/approve`)).status, 410);
  });
});
