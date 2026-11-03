// Đăng nhập quản trị: mật khẩu + MFA, đăng ký MFA, xác thực lại, giới hạn thử, khởi tạo admin đầu tiên
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { User } from '../../src/models/User.js';
import { AdminMfa } from '../../src/models/AdminMfa.js';
import { AdminSession } from '../../src/models/AdminSession.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { SystemMarker } from '../../src/models/SystemMarker.js';
import { bootstrapFirstAdmin, logAdminStatus, resetAdminMfaFromCli } from '../../src/services/adminBootstrap.js';
import { generateClaimCode } from '../../src/services/accounts.js';
import { createClient, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import {
  ADMIN_ENV,
  ADMIN_PASSWORD,
  adminClient,
  auditEntries,
  clearUsedStep,
  createAdminUser,
  currentCode,
  enrolledAdmin,
  expireReauth,
  loginPassword,
  sessionOf,
} from '../adminHelpers.js';

let ctx;

before(async () => {
  setEnv(ADMIN_ENV);
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(ADMIN_ENV);
  await RateLimit.deleteMany({});
});

const verify = (client, code) => client.post('/api/admin/auth/mfa/verify', { json: { code } });

describe('bước mật khẩu', () => {
  test('email lạ, sai mật khẩu, tài khoản không phải admin, admin bị khóa: phản hồi giống hệt nhau', async () => {
    const { email: lockedEmail } = await createAdminUser({ status: 'locked' });
    const { email } = await createAdminUser();
    const student = await registerUser(createClient(ctx.base));
    const attempts = [
      [`khong-co-${uniqueSuffix()}@example.edu.vn`, 'mat-khau-sai-123'],
      [email, 'mat-khau-sai-123'],
      [student.body.email, student.body.password],
      [lockedEmail, ADMIN_PASSWORD],
    ];
    const responses = [];
    for (const [address, password] of attempts) {
      responses.push(await loginPassword(adminClient(ctx.base), address, password));
    }
    for (const res of responses) {
      assert.equal(res.status, 401);
      assert.deepEqual(res.data, responses[0].data);
      assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('gc_admin=')), 'không cấp phiên');
    }
    const logged = await auditEntries({ action: 'admin.login', result: 'failure' });
    for (const reason of ['invalid_credentials', 'not_admin', 'account_locked']) {
      assert.ok(logged.some((entry) => entry.reason === reason), reason);
    }
  });

  test('sai 5 lần theo cặp email + IP bị chặn, kể cả khi mật khẩu đúng ở lần sau; đúng trước đó thì đặt lại bộ đếm', async () => {
    const { email } = await createAdminUser();
    for (let i = 0; i < 4; i += 1) assert.equal((await loginPassword(adminClient(ctx.base), email, 'sai-mat-khau-123')).status, 401);
    assert.equal((await loginPassword(adminClient(ctx.base), email)).status, 200);
    for (let i = 0; i < 5; i += 1) assert.equal((await loginPassword(adminClient(ctx.base), email, 'sai-mat-khau-123')).status, 401);
    const limited = await loginPassword(adminClient(ctx.base), email);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, 'too_many_attempts');
  });

  test('dữ liệu sai kiểu → 400, không chạy băm mật khẩu', async () => {
    for (const json of [{}, { email: 'a@b.vn' }, { email: 'khong-phai-email', password: 'x' }, { email: 'a@b.vn', password: 'x'.repeat(300) }]) {
      assert.equal((await adminClient(ctx.base).raw.post('/api/admin/auth/login', { json })).status, 400);
    }
  });
});

describe('đăng ký MFA', () => {
  test('cần mã đăng ký đúng: mật khẩu bị lộ không đủ để gắn thiết bị của kẻ khác', async () => {
    const { user, email, enrollCode } = await createAdminUser();
    const client = adminClient(ctx.base);
    const login = await loginPassword(client, email);
    assert.deepEqual([login.data.stage, login.data.mfaEnrolled], ['mfa', false]);

    const wrong = await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode: generateClaimCode() } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.data.code, 'invalid_enroll_code');
    assert.equal((await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode: { $ne: null } } })).status, 400);

    const ok = await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode } });
    assert.equal(ok.status, 200);
    assert.match(ok.data.secret, /^[A-Z2-7]{32}$/);
    assert.match(ok.data.otpauthUri, /^otpauth:\/\/totp\//);

    const stored = await AdminMfa.findOne({ userId: user._id }).lean();
    assert.match(stored.pendingSecretEnc, /^v1\./, 'secret được mã hóa');
    assert.ok(!JSON.stringify(stored).includes(ok.data.secret), 'secret không lưu dạng rõ');
    assert.ok(!JSON.stringify(stored).includes(enrollCode), 'mã đăng ký không lưu dạng rõ');
  });

  test('mã đăng ký hết hạn bị từ chối; sai 5 lần bị khóa tạm', async () => {
    const { user, email, enrollCode } = await createAdminUser();
    const client = adminClient(ctx.base);
    await loginPassword(client, email);
    await AdminMfa.updateOne({ userId: user._id }, { $set: { enrollCodeExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode } })).data.code, 'invalid_enroll_code');
    for (let i = 0; i < 4; i += 1) await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode: 'SAI' } });
    assert.equal((await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode } })).status, 429);
  });

  test('xác nhận sai không kích hoạt; xác nhận đúng trả mã khôi phục một lần, phiên được đổi token', async () => {
    const { user, email, enrollCode } = await createAdminUser();
    const client = adminClient(ctx.base);
    await loginPassword(client, email);
    const { secret } = (await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode } })).data;
    assert.equal((await verify(client, '000000')).status, 401);
    assert.equal(await AdminMfa.countDocuments({ userId: user._id, enabledAt: { $ne: null } }), 0);

    const pendingToken = client.jar.get('gc_admin');
    const done = await verify(client, currentCode(secret));
    assert.equal(done.status, 200);
    assert.equal(done.data.stage, 'active');
    assert.equal(done.data.recoveryCodes.length, 8);
    assert.notEqual(client.jar.get('gc_admin'), pendingToken, 'chống cố định phiên');
    assert.notEqual(done.data.csrfToken, undefined);

    const replay = createClient(ctx.base);
    replay.jar.set('gc_admin', pendingToken);
    assert.equal((await replay.get('/api/admin/users')).status, 401, 'token bước chờ không còn dùng được');
  });

  test('đã đăng ký thì không đăng ký lại được (kể cả có mã cũ)', async () => {
    const { email } = await enrolledAdmin(ctx.base);
    const client = adminClient(ctx.base);
    assert.equal((await loginPassword(client, email)).data.mfaEnrolled, true);
    const res = await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode: generateClaimCode() } });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'mfa_already_enrolled');
  });
});

describe('bước MFA khi đăng nhập', () => {
  test('mã đúng mở phiên; mã đã dùng không dùng lại được; sai 5 lần bị khóa', async () => {
    const { user, email, secret } = await enrolledAdmin(ctx.base);
    await clearUsedStep(user._id);
    const first = adminClient(ctx.base);
    await loginPassword(first, email);
    const code = currentCode(secret);
    assert.equal((await verify(first, code)).status, 200);

    const second = adminClient(ctx.base);
    await loginPassword(second, email);
    const replay = await verify(second, code);
    assert.equal(replay.status, 401);
    assert.equal(replay.data.code, 'invalid_mfa_code');

    for (let i = 0; i < 4; i += 1) assert.equal((await verify(second, '000000')).status, 401);
    await clearUsedStep(user._id);
    assert.equal((await verify(second, currentCode(secret))).status, 429, 'bị khóa cả khi mã đúng');
  });

  test('hai yêu cầu đồng thời cùng một mã: chỉ một phiên được cấp', async () => {
    const { user, email, secret } = await enrolledAdmin(ctx.base);
    await clearUsedStep(user._id);
    const clients = [adminClient(ctx.base), adminClient(ctx.base)];
    for (const client of clients) await loginPassword(client, email);
    const code = currentCode(secret);
    const results = await Promise.all(clients.map((client) => verify(client, code)));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  });

  test('mã khôi phục dùng được đúng một lần và thay được mã TOTP', async () => {
    const { email, recoveryCodes } = await enrolledAdmin(ctx.base);
    const [code] = recoveryCodes;
    const first = adminClient(ctx.base);
    await loginPassword(first, email);
    assert.equal((await verify(first, code.toLowerCase().replaceAll('-', ''))).status, 200, 'không phân biệt hoa thường, dấu gạch');
    const second = adminClient(ctx.base);
    await loginPassword(second, email);
    assert.equal((await verify(second, code)).status, 401);
    assert.equal((await verify(second, { $ne: null })).status, 401);
  });

  test('đổi ADMIN_MFA_KEY: mã TOTP và mã khôi phục cũ đều bị từ chối, không tự nới lỏng, log không lộ secret', async () => {
    const { email, secret, recoveryCodes } = await enrolledAdmin(ctx.base);
    setEnv({ ADMIN_MFA_KEY: crypto.randomBytes(32).toString('base64') });
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      const client = adminClient(ctx.base);
      assert.equal((await loginPassword(client, email)).status, 200);
      const totp = await verify(client, currentCode(secret));
      assert.deepEqual([totp.status, totp.data.code], [401, 'invalid_mfa_code']);
      assert.equal((await verify(client, recoveryCodes[0])).status, 401);
      assert.equal((await client.get('/api/admin/users')).status, 401);
    } finally {
      console.error = original;
    }
    assert.ok(logged.some((line) => line.includes('Không giải mã được secret MFA')));
    assert.ok(!logged.join('\n').includes(secret));
  });

  test('mỗi tài khoản một phiên: đăng nhập nơi mới đẩy phiên cũ ra', async () => {
    const { client, user, email, secret } = await enrolledAdmin(ctx.base);
    await clearUsedStep(user._id);
    const newer = adminClient(ctx.base);
    await loginPassword(newer, email);
    assert.equal((await verify(newer, currentCode(secret))).status, 200);
    assert.equal((await client.get('/api/admin/users')).status, 401);
    assert.equal(await AdminSession.countDocuments({ userId: user._id }), 1);
  });

  test('phiên chờ MFA hết hạn sau 5 phút', async () => {
    const { user, email, secret } = await enrolledAdmin(ctx.base);
    await clearUsedStep(user._id);
    const client = adminClient(ctx.base);
    await loginPassword(client, email);
    await AdminSession.updateOne({ userId: user._id, stage: 'mfa' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await verify(client, currentCode(secret))).status, 401);
  });
});

describe('thông tin phiên và đăng xuất', () => {
  test('GET /session: không phiên → none; chờ MFA → mfa; đầy đủ → có token CSRF, email đã che', async () => {
    assert.deepEqual((await createClient(ctx.base).get('/api/admin/auth/session')).data, { stage: 'none' });
    const { client, email } = await enrolledAdmin(ctx.base);
    const active = (await client.get('/api/admin/auth/session')).data;
    assert.equal(active.stage, 'active');
    assert.ok(active.csrfToken);
    assert.doesNotMatch(active.admin.email, new RegExp(email.split('@')[0]));
    const pending = adminClient(ctx.base);
    await loginPassword(pending, email);
    assert.equal((await pending.get('/api/admin/auth/session')).data.stage, 'mfa');
  });

  test('phiên quản trị và phiên end-user độc lập: đăng xuất admin không ảnh hưởng end-user và ngược lại', async () => {
    const { client, email } = await enrolledAdmin(ctx.base);
    assert.equal((await client.raw.post('/api/auth/login', { json: { email, password: ADMIN_PASSWORD } })).status, 200);
    assert.equal((await client.get('/api/auth/me')).status, 200);
    await client.raw.post('/api/auth/logout');
    assert.equal((await client.get('/api/admin/users')).status, 200, 'đăng xuất end-user không chạm phiên quản trị');
    assert.equal((await client.raw.post('/api/admin/auth/logout')).status, 200);
    assert.equal((await client.get('/api/admin/users')).status, 401);
    assert.ok((await auditEntries({ action: 'admin.logout' })).length >= 1);
  });

  test('đổi mật khẩu thu hồi phiên quản trị', async () => {
    const { client, email } = await enrolledAdmin(ctx.base);
    await client.raw.post('/api/auth/login', { json: { email, password: ADMIN_PASSWORD } });
    const change = await client.raw.post('/api/auth/password/change', { json: { currentPassword: ADMIN_PASSWORD, newPassword: 'mat-khau-moi-rat-dai-123' } });
    assert.equal(change.status, 200);
    assert.equal((await client.get('/api/admin/users')).status, 401);
  });

  test('đặt hạn nhàn rỗi rất ngắn: phiên đang dùng vẫn được gia hạn trước khi hết hạn', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    setEnv({ ...ADMIN_ENV, ADMIN_SESSION_IDLE_MINUTES: '1' });
    const session = await sessionOf(client);
    const stale = new Date(Date.now() - 40 * 1000);
    await AdminSession.updateOne({ _id: session._id }, { $set: { lastSeenAt: stale } });
    assert.equal((await client.get('/api/admin/users')).status, 200);
    assert.ok((await AdminSession.findById(session._id).lean()).lastSeenAt > stale);
  });

  test('phiên nhàn rỗi được gia hạn khi có request; thời hạn tuyệt đối không đổi', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    const session = await sessionOf(client);
    const stale = new Date(Date.now() - 5 * 60 * 1000);
    await AdminSession.updateOne({ _id: session._id }, { $set: { lastSeenAt: stale } });
    assert.equal((await client.get('/api/admin/users')).status, 200);
    const after = await AdminSession.findById(session._id).lean();
    assert.ok(after.lastSeenAt > stale);
    assert.equal(after.expiresAt.getTime(), session.expiresAt.getTime());
    assert.ok(session.expiresAt.getTime() - Date.now() <= 8 * 60 * 60 * 1000 + 1000, 'mặc định tối đa 8 giờ');
  });
});

describe('xác thực lại trước thao tác nhạy cảm', () => {
  const sensitive = (client, id) =>
    client.patch(`/api/admin/users/${id}/status`, { json: { status: 'locked', reason: 'Kiểm thử xác thực lại' } });

  test('quá 5 phút từ lần xác thực cuối → 403 reauth_required, thao tác không xảy ra', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    const student = await registerUser(createClient(ctx.base));
    await expireReauth(client);
    const res = await sensitive(client, student.data.user.id);
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'reauth_required');
    assert.equal((await User.findById(student.data.user.id).lean()).status, 'active');
  });

  test('F-63: thao tác nhạy cảm bị chặn vì chưa xác thực lại vẫn để lại dấu vết trong nhật ký, không kèm tham số truy vấn', async () => {
    const { client, user } = await enrolledAdmin(ctx.base);
    const student = await registerUser(createClient(ctx.base));
    await expireReauth(client);
    assert.equal((await client.post(`/api/admin/users/${student.data.user.id}/reveal?ghi-chu=bi-mat`)).data.code, 'reauth_required');
    const [entry] = await auditEntries({ action: 'admin.reauth_required', actorId: user._id });
    assert.equal(entry.result, 'denied');
    assert.equal(entry.meta.method, 'POST');
    assert.equal(entry.meta.path, `/api/admin/users/${student.data.user.id}/reveal`);
  });

  test('mật khẩu đúng + mã đúng → thao tác được; thiếu một trong hai → từ chối và ghi nhật ký', async () => {
    const { client, user, secret } = await enrolledAdmin(ctx.base);
    const student = await registerUser(createClient(ctx.base));
    await expireReauth(client);
    await clearUsedStep(user._id);

    const wrongPassword = await client.post('/api/admin/auth/reauth', { json: { password: 'sai-mat-khau', code: currentCode(secret) } });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.data.code, 'reauth_failed');
    const wrongCode = await client.post('/api/admin/auth/reauth', { json: { password: ADMIN_PASSWORD, code: '000000' } });
    assert.equal(wrongCode.status, 401);
    assert.equal((await sensitive(client, student.data.user.id)).status, 403);

    const ok = await client.post('/api/admin/auth/reauth', { json: { password: ADMIN_PASSWORD, code: currentCode(secret) } });
    assert.equal(ok.status, 200);
    assert.ok(new Date(ok.data.reauthValidUntil) > new Date());
    assert.equal((await sensitive(client, student.data.user.id)).status, 200);

    const logged = await auditEntries({ action: 'admin.reauth' });
    assert.ok(logged.some((entry) => entry.result === 'failure' && entry.reason === 'invalid_password'));
    assert.ok(logged.some((entry) => entry.result === 'failure' && entry.reason === 'invalid_mfa_code'));
    assert.ok(logged.some((entry) => entry.result === 'success'));
  });

  test('sai xác thực lại 5 lần bị khóa tạm', async () => {
    const { client, user, secret } = await enrolledAdmin(ctx.base);
    for (let i = 0; i < 5; i += 1) await client.post('/api/admin/auth/reauth', { json: { password: 'sai', code: '000000' } });
    await clearUsedStep(user._id);
    const res = await client.post('/api/admin/auth/reauth', { json: { password: ADMIN_PASSWORD, code: currentCode(secret) } });
    assert.equal(res.status, 429);
  });

  test('hết hiệu lực xác thực lại theo ADMIN_REAUTH_MINUTES', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    const student = await registerUser(createClient(ctx.base));
    await AdminSession.updateOne({ _id: (await sessionOf(client))._id }, { $set: { reauthAt: new Date(Date.now() - 2 * 60 * 1000) } });
    setEnv({ ...ADMIN_ENV, ADMIN_REAUTH_MINUTES: '1' });
    assert.equal((await sensitive(client, student.data.user.id)).data.code, 'reauth_required');
    setEnv({ ...ADMIN_ENV, ADMIN_REAUTH_MINUTES: '3' });
    assert.equal((await sensitive(client, student.data.user.id)).status, 200);
  });
});

describe('khởi tạo admin đầu tiên (lệnh dòng lệnh)', () => {
  const details = (overrides = {}) => ({
    email: `dau-tien-${uniqueSuffix()}@example.edu.vn`,
    name: 'Cán Bộ Quản Trị',
    password: 'mat-khau-quan-tri-dai',
    ...overrides,
  });
  const reset = async () => {
    await User.deleteMany({});
    await SystemMarker.deleteMany({});
    await AdminMfa.deleteMany({});
  };

  test('tạo được admin khi chưa có; lệnh thứ hai bị từ chối; toàn bộ luồng đăng nhập chạy được', async () => {
    await reset();
    const first = await bootstrapFirstAdmin(details());
    assert.match(first.enrollCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.match(first.user.studentId, /^ADMIN-/);
    await assert.rejects(bootstrapFirstAdmin(details()), (err) => err.code === 'admin_exists');

    const client = adminClient(ctx.base);
    await loginPassword(client, first.user.email, 'mat-khau-quan-tri-dai');
    const { secret } = (await client.post('/api/admin/auth/mfa/setup', { json: { enrollCode: first.enrollCode } })).data;
    assert.equal((await verify(client, currentCode(secret))).status, 200);
    assert.ok((await auditEntries({ action: 'admin.bootstrap' })).length >= 1);
  });

  test('hai lệnh chạy đồng thời chỉ tạo được một admin', async () => {
    await reset();
    const results = await Promise.allSettled([bootstrapFirstAdmin(details()), bootstrapFirstAdmin(details())]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await User.countDocuments({ role: 'admin' }), 1);
  });

  test('đã có admin thì từ chối cả khi dấu mốc khởi tạo đã cũ: chốt kiểm tra admin không phụ thuộc thời gian', async () => {
    await reset();
    await bootstrapFirstAdmin(details());
    await SystemMarker.collection.updateOne({ _id: 'admin-bootstrap' }, { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await assert.rejects(bootstrapFirstAdmin(details()), (err) => err.code === 'admin_exists');
    assert.equal(await User.countDocuments({ role: 'admin' }), 1);
  });

  test('marker cũ khi không còn admin nào không khóa vĩnh viễn việc khởi tạo', async () => {
    await reset();
    await SystemMarker.collection.insertOne({ _id: 'admin-bootstrap', createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    assert.ok((await bootstrapFirstAdmin(details())).enrollCode);
  });

  test('nâng quyền tài khoản có sẵn giữ nguyên mật khẩu; tài khoản chưa có mật khẩu bị từ chối', async () => {
    await reset();
    const student = await registerUser(createClient(ctx.base));
    const promoted = await bootstrapFirstAdmin({ email: student.body.email });
    assert.equal(promoted.promotedExisting, true);
    assert.equal((await User.findById(student.data.user.id).lean()).role, 'admin');

    await reset();
    const oauthOnly = await User.create({ name: 'Chỉ Google', studentId: `G${uniqueSuffix()}`, email: `g${uniqueSuffix()}@example.edu.vn`, googleId: `gid${uniqueSuffix()}` });
    await assert.rejects(bootstrapFirstAdmin({ email: oauthOnly.email }), (err) => err.code === 'password_required');
  });

  test('từ chối khi thiếu khóa MFA, mật khẩu ngắn, email hoặc họ tên sai', async () => {
    await reset();
    setEnv({});
    await assert.rejects(bootstrapFirstAdmin(details()), (err) => err.code === 'admin_not_configured');
    setEnv(ADMIN_ENV);
    await assert.rejects(bootstrapFirstAdmin(details({ password: 'ngan-qua' })), (err) => err.code === 'invalid_input');
    await assert.rejects(bootstrapFirstAdmin(details({ email: 'khong-hop-le' })), (err) => err.code === 'invalid_input');
    await assert.rejects(bootstrapFirstAdmin(details({ name: 'x' })), (err) => err.code === 'invalid_input');
    await assert.rejects(bootstrapFirstAdmin(details({ studentId: 'x'.repeat(41) })), (err) => err.code === 'invalid_input');
    assert.equal(await User.countDocuments({ role: 'admin' }), 0);
  });

  test('báo trạng thái khu quản trị lúc khởi động: thiếu khóa, chưa có admin, đã cấu hình', async () => {
    const lines = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (line) => lines.push(line);
    console.warn = (line) => lines.push(line);
    try {
      await reset();
      setEnv({});
      await logAdminStatus();
      setEnv(ADMIN_ENV);
      await logAdminStatus();
      await bootstrapFirstAdmin(details());
      await logAdminStatus();
    } finally {
      Object.assign(console, original);
    }
    assert.match(lines[0], /TẮT/);
    assert.match(lines[1], /admin:bootstrap/);
    assert.match(lines[2], /đã cấu hình/);
  });

  test('admin:reset-mfa thu hồi phiên, xóa MFA cũ, ghi nhật ký; email không phải admin bị từ chối', async () => {
    const { client, email, user } = await enrolledAdmin(ctx.base);
    const { enrollCode } = await resetAdminMfaFromCli(email);
    assert.equal((await client.get('/api/admin/users')).status, 401);
    assert.equal(await AdminMfa.countDocuments({ userId: user._id, enabledAt: { $ne: null } }), 0);
    assert.ok(enrollCode);
    const entry = (await auditEntries({ action: 'admin.mfa_reset' }))[0];
    assert.equal(entry.actorType, 'cli');
    assert.ok(!JSON.stringify(entry).includes(enrollCode));
    await assert.rejects(resetAdminMfaFromCli('khong-co@example.edu.vn'), (err) => err.code === 'not_found');
  });
});

describe('F-52: gửi đồng thời không vượt được giới hạn thử', () => {
  const burst = (count, send) => Promise.all(Array.from({ length: count }, send));
  const count = (results, status) => results.filter((res) => res.status === status).length;

  test('mã MFA: 20 mã sai cùng lúc chỉ 5 mã được chấm, kẻ biết mật khẩu không dò nhanh hơn được', async () => {
    const { user, email } = await enrolledAdmin(ctx.base);
    await clearUsedStep(user._id);
    const client = adminClient(ctx.base);
    await loginPassword(client, email);
    const results = await burst(20, () => verify(client, '000000'));
    assert.equal(count(results, 401), 5);
    assert.equal(count(results, 429), 15);
    assert.equal((await auditEntries({ action: 'admin.login', actorId: user._id, reason: 'invalid_mfa_code' })).length, 5);
  });

  test('mật khẩu admin: 12 lần sai cùng lúc chỉ 5 lần được băm theo cặp email + IP', async () => {
    const { email } = await createAdminUser();
    const results = await burst(12, () => loginPassword(adminClient(ctx.base), email, 'sai-mat-khau-123'));
    assert.equal(count(results, 401), 5);
    assert.equal(count(results, 429), 7);
  });

  test('xác thực lại: 12 lần sai cùng lúc chỉ 5 lần được chấm', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    const results = await burst(12, () => client.post('/api/admin/auth/reauth', { json: { password: 'sai-mat-khau-123', code: '000000' } }));
    assert.equal(count(results, 401), 5);
    assert.equal(count(results, 429), 7);
  });

  test('mã đăng ký MFA: 12 lần sai cùng lúc chỉ 5 lần được chấm', async () => {
    const { email } = await createAdminUser();
    const client = adminClient(ctx.base);
    await loginPassword(client, email);
    const results = await burst(12, () => client.post('/api/admin/auth/mfa/setup', { json: { enrollCode: generateClaimCode() } }));
    assert.equal(count(results, 400), 5);
    assert.equal(count(results, 429), 7);
  });

  test('đăng nhập đúng trả lại lượt đã giữ: admin thật không tiêu ngân sách theo email và IP', async () => {
    const { email } = await createAdminUser();
    assert.equal((await loginPassword(adminClient(ctx.base), email)).status, 200);
    const counters = await RateLimit.find({ key: /^admin-login-/ }).lean();
    assert.deepEqual(counters.filter((doc) => doc.count > 0), []);
  });

  test('MFA đúng xóa bộ đếm, đăng nhập lần sau không bị tính các lần sai trước', async () => {
    const { user, email, secret } = await enrolledAdmin(ctx.base);
    await clearUsedStep(user._id);
    const client = adminClient(ctx.base);
    await loginPassword(client, email);
    for (let i = 0; i < 4; i += 1) assert.equal((await verify(client, '000000')).status, 401);
    assert.equal((await verify(client, currentCode(secret))).status, 200);
    assert.equal(await RateLimit.countDocuments({ key: /^admin-mfa-fail:/ }), 0);
  });
});
