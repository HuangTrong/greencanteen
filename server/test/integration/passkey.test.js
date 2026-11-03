// Passkey (WebAuthn): khóa và chữ ký thật từ thiết bị phần mềm, xác minh bằng đúng thư viện chạy ở production.
// Các kịch bản tấn công: trang giả mạo tên miền, dùng lại chữ ký, khóa bị sao chép, thiếu xác minh người dùng, khóa của người khác.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Passkey } from '../../src/models/Passkey.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { Session } from '../../src/models/Session.js';
import { User } from '../../src/models/User.js';
import { WebauthnChallenge } from '../../src/models/WebauthnChallenge.js';
import { hashToken } from '../../src/services/session.js';
import { totpCode, totpStep } from '../../src/services/totp.js';
import { ADMIN_ENV, ADMIN_PASSWORD, adminClient, auditEntries, currentCode, enrolledAdmin, loginPassword } from '../adminHelpers.js';
import { FakeAuthenticator } from '../fakes/authenticator.js';
import { createClient, registerUser, setEnv, startTestServer } from '../helpers.js';

const ORIGIN = 'https://gc.example.edu.vn';
const RP_ID = 'gc.example.edu.vn';
const PASSWORD = 'mat-khau-an-toan-1';
const ENV = { ...ADMIN_ENV, CLIENT_ORIGIN: ORIGIN };

let ctx;
const client = () => createClient(ctx.base);
const device = () => new FakeAuthenticator({ origin: ORIGIN, rpID: RP_ID });
const reauth = (c, password = PASSWORD) => c.post('/api/auth/reauth', { json: { password } });
const options = async (c, path = '/api/auth/passkeys/login/options') => {
  const res = await c.post(path);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
};
const verify = (c, response) => c.post('/api/auth/passkeys/login/verify', { json: { response } });

async function enroll(c, authenticator = device(), name = 'Điện thoại') {
  await reauth(c);
  const opts = await options(c, '/api/auth/passkeys/register/options');
  const res = await c.post('/api/auth/passkeys/register/verify', { json: { response: authenticator.register(opts), name } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { authenticator, passkey: res.data.passkey };
}

async function studentWithPasskey() {
  const c = client();
  const { body, data } = await registerUser(c);
  const { authenticator, passkey } = await enroll(c);
  return { c, email: body.email, id: data.user.id, authenticator, passkey };
}

before(async () => {
  setEnv(ENV);
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(ENV);
  await RateLimit.deleteMany({});
});

describe('đăng ký passkey', () => {
  test('giữ cookie phiên chưa đủ: phải xác thực lại; chưa đăng nhập thì 401', async () => {
    const c = client();
    await registerUser(c);
    assert.equal((await c.post('/api/auth/passkeys/register/options')).data.code, 'reauth_required');
    assert.equal((await client().post('/api/auth/passkeys/register/options')).status, 401);
  });

  test('yêu cầu gửi cho thiết bị: đúng tên miền, bắt buộc xác minh người dùng, không có dữ liệu cá nhân trong userID', async () => {
    const c = client();
    const { body, data } = await registerUser(c);
    await reauth(c);
    const opts = await options(c, '/api/auth/passkeys/register/options');
    assert.equal(opts.rp.id, RP_ID);
    assert.equal(opts.authenticatorSelection.userVerification, 'required');
    assert.equal(opts.authenticatorSelection.residentKey, 'required');
    assert.equal(opts.attestation, 'none');
    assert.equal(Buffer.from(opts.user.id, 'base64url').toString(), data.user.id);
    assert.ok(!Buffer.from(opts.user.id, 'base64url').toString().includes(body.email));
  });

  test('đăng ký xong hiện trong danh sách, không lộ khóa; có nhật ký; DB chỉ có khóa công khai', async () => {
    const { c, id, passkey, authenticator } = await studentWithPasskey();
    const { passkeys } = (await c.get('/api/auth/security')).data;
    assert.deepEqual(passkeys.map((item) => item.name), ['Điện thoại']);
    assert.deepEqual(Object.keys(passkeys[0]).sort(), ['backedUp', 'createdAt', 'id', 'lastUsedAt', 'name']);
    assert.equal(passkeys[0].id, passkey.id);
    assert.ok(await AuditLog.exists({ action: 'account.passkey_add', actorId: id }));
    const stored = await Passkey.findById(passkey.id).lean();
    assert.equal(stored.credentialId, authenticator.id);
    assert.ok(!JSON.stringify(stored).includes(authenticator.privateKey.export({ format: 'jwk' }).d));
  });

  test('tên passkey là văn bản, cắt ở 60 ký tự, không tên thì dùng tên mặc định', async () => {
    const c = client();
    await registerUser(c);
    const { passkey } = await enroll(c, device(), '<img src=x onerror=1>'.repeat(10));
    assert.equal(passkey.name.length, 60);
    assert.equal((await enroll(c, device(), '   ')).passkey.name, 'Passkey');
  });

  test('từ chối: trang giả mạo tên miền, sai RP ID, thiếu xác minh người dùng, thử thách của người khác, đăng ký lại cùng khóa', async () => {
    const c = client();
    await registerUser(c);
    const attempt = async (overrides) => {
      await reauth(c);
      const opts = await options(c, '/api/auth/passkeys/register/options');
      return c.post('/api/auth/passkeys/register/verify', { json: { response: device().register(opts, overrides) } });
    };
    assert.equal((await attempt({ origin: 'https://gc-example.evil.test' })).data.code, 'passkey_invalid');
    assert.equal((await attempt({ rpID: 'evil.test' })).data.code, 'passkey_invalid');
    assert.equal((await attempt({ userVerified: false })).data.code, 'passkey_invalid');
    assert.equal((await attempt({ challenge: 'A'.repeat(43) })).data.code, 'passkey_invalid');
    assert.equal((await c.get('/api/auth/security')).data.passkeys.length, 0);

    const shared = device();
    await enroll(c, shared);
    const other = client();
    await registerUser(other);
    await reauth(other);
    const opts = await options(other, '/api/auth/passkeys/register/options');
    assert.equal((await other.post('/api/auth/passkeys/register/verify', { json: { response: shared.register(opts) } })).data.code, 'passkey_invalid', 'một khóa không gắn được vào hai tài khoản');
  });

  test('thử thách dùng một lần và gắn với trình duyệt đã xin nó', async () => {
    const c = client();
    await registerUser(c);
    await reauth(c);
    const opts = await options(c, '/api/auth/passkeys/register/options');
    const response = device().register(opts);
    const other = client();
    await registerUser(other);
    await reauth(other);
    assert.equal((await other.post('/api/auth/passkeys/register/verify', { json: { response } })).data.code, 'passkey_invalid');
    assert.equal((await c.post('/api/auth/passkeys/register/verify', { json: { response } })).status, 201);
    assert.equal((await c.post('/api/auth/passkeys/register/verify', { json: { response: device().register(opts) } })).data.code, 'passkey_invalid');
  });

  test('sao chép cả cookie thử thách của người khác cũng không gắn được khóa vào tài khoản mình', async () => {
    const victim = client();
    await registerUser(victim);
    await reauth(victim);
    const opts = await options(victim, '/api/auth/passkeys/register/options');

    const attacker = client();
    await registerUser(attacker);
    await reauth(attacker);
    attacker.jar.set('gc_webauthn', victim.jar.get('gc_webauthn'));
    const res = await attacker.post('/api/auth/passkeys/register/verify', { json: { response: device().register(opts) } });
    assert.equal(res.data.code, 'passkey_invalid');
    assert.equal((await attacker.get('/api/auth/security')).data.passkeys.length, 0);
  });

  test('thử thách đã dùng mất hẳn ở máy chủ, kể cả khi lần đó thất bại: gửi lại cookie cũ không dùng tiếp được', async () => {
    const c = client();
    await registerUser(c);
    await reauth(c);
    const opts = await options(c, '/api/auth/passkeys/register/options');
    const cookie = c.jar.get('gc_webauthn');
    assert.equal((await c.post('/api/auth/passkeys/register/verify', { json: { response: device().register(opts, { userVerified: false }) } })).data.code, 'passkey_invalid');
    assert.equal(await WebauthnChallenge.countDocuments({ tokenHash: hashToken(cookie) }), 0);

    c.jar.set('gc_webauthn', cookie);
    assert.equal((await c.post('/api/auth/passkeys/register/verify', { json: { response: device().register(opts) } })).data.code, 'passkey_invalid');
    assert.equal((await c.get('/api/auth/security')).data.passkeys.length, 0);
  });

  test('tối đa 10 passkey mỗi tài khoản', async () => {
    const c = client();
    await registerUser(c);
    for (let i = 0; i < 10; i += 1) await enroll(c);
    await reauth(c);
    assert.equal((await c.post('/api/auth/passkeys/register/options')).data.code, 'passkey_limit');
  });
});

describe('đăng nhập bằng passkey', () => {
  test('không cần email hay mật khẩu; phiên mới được tính là vừa xác thực; cập nhật lần dùng cuối', async () => {
    const { id, authenticator, passkey } = await studentWithPasskey();
    const c = client();
    const opts = await options(c);
    assert.equal(opts.userVerification, 'required');
    assert.deepEqual(opts.allowCredentials ?? [], [], 'không tiết lộ khóa nào tồn tại');
    const res = await verify(c, authenticator.authenticate(opts, { userHandle: id }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.user.id, id);
    assert.ok(c.jar.has('gc_session'));
    assert.ok((await Session.findOne({ tokenHash: hashToken(c.jar.get('gc_session')) })).reauthAt);
    assert.ok((await Passkey.findById(passkey.id)).lastUsedAt);
  });

  test('trang giả mạo xin được chữ ký thật cũng không đăng nhập được: chữ ký gắn với origin và RP ID', async () => {
    const { authenticator } = await studentWithPasskey();
    for (const overrides of [{ origin: 'https://gc-example.evil.test' }, { rpID: 'evil.test' }, { origin: 'http://gc.example.edu.vn' }]) {
      const c = client();
      const res = await verify(c, authenticator.authenticate(await options(c), overrides));
      assert.equal(res.data.code, 'passkey_invalid', JSON.stringify(overrides));
      assert.ok(!c.jar.has('gc_session'));
    }
  });

  test('dùng lại chữ ký cũ bị từ chối: thử thách đã tiêu, thử thách mới không khớp', async () => {
    const { authenticator } = await studentWithPasskey();
    const c = client();
    const response = authenticator.authenticate(await options(c));
    assert.equal((await verify(c, response)).status, 200);
    assert.equal((await verify(c, response)).data.code, 'passkey_invalid');
    const other = client();
    await options(other);
    assert.equal((await verify(other, response)).data.code, 'passkey_invalid');
  });

  test('khóa bị sao chép: bộ đếm không tăng thì từ chối, hai yêu cầu đồng thời chỉ một yêu cầu qua', async () => {
    const { authenticator } = await studentWithPasskey();
    const c = client();
    assert.equal((await verify(c, authenticator.authenticate(await options(c), { counter: 10 }))).status, 200);
    const clone = client();
    assert.equal((await verify(clone, authenticator.authenticate(await options(clone), { counter: 10 }))).data.code, 'passkey_invalid');
    assert.equal((await verify(clone, authenticator.authenticate(await options(clone), { counter: 3 }))).data.code, 'passkey_invalid');

    const [a, b] = [client(), client()];
    const [oa, ob] = [await options(a), await options(b)];
    const results = await Promise.all([verify(a, authenticator.authenticate(oa, { counter: 20 })), verify(b, authenticator.authenticate(ob, { counter: 20 }))]);
    assert.equal(results.filter((res) => res.status === 200).length, 1);
  });

  test('xin thử thách ẩn danh bị giới hạn theo IP: khách không làm đầy DB được', async () => {
    const c = client();
    for (let i = 0; i < 60; i += 1) assert.equal((await c.post('/api/auth/passkeys/login/options')).status, 200);
    assert.equal((await c.post('/api/auth/passkeys/login/options')).status, 429);
  });

  test('passkey đồng bộ có bộ đếm luôn bằng 0: chữ ký bị bắt được không dùng lại được, kể cả kèm cookie thử thách', async () => {
    const { authenticator } = await studentWithPasskey();
    const c = client();
    const opts = await options(c);
    const cookie = c.jar.get('gc_webauthn');
    const response = authenticator.authenticate(opts, { counter: 0 });
    assert.equal((await verify(c, response)).status, 200);

    const attacker = client();
    attacker.jar.set('gc_webauthn', cookie);
    assert.equal((await verify(attacker, response)).data.code, 'passkey_invalid');
    assert.ok(!attacker.jar.has('gc_session'));
  });

  test('thử thách cấp cho việc này không dùng được cho việc khác', async () => {
    const { c, authenticator } = await studentWithPasskey();
    await reauth(c);
    const opts = await options(c, '/api/auth/passkeys/register/options');
    assert.equal((await verify(c, authenticator.authenticate(opts))).data.code, 'passkey_invalid');
  });

  test('thiếu xác minh người dùng, chữ ký bằng khóa khác, userHandle của người khác, khóa lạ: đều từ chối', async () => {
    const { authenticator } = await studentWithPasskey();
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (const overrides of [{ userVerified: false }, { privateKey }, { userHandle: 'a'.repeat(24) }]) {
      const c = client();
      assert.equal((await verify(c, authenticator.authenticate(await options(c), overrides))).data.code, 'passkey_invalid', Object.keys(overrides)[0]);
    }
    const c = client();
    assert.equal((await verify(c, device().authenticate(await options(c)))).data.code, 'passkey_invalid');
  });

  test('không có cookie thử thách, thử thách hết hạn, thân yêu cầu dị dạng: từ chối, không lỗi máy chủ', async () => {
    const { authenticator } = await studentWithPasskey();
    const opts = await options(client());
    assert.equal((await verify(client(), authenticator.authenticate(opts))).data.code, 'passkey_invalid');

    const c = client();
    const issued = await options(c);
    await WebauthnChallenge.updateOne({ tokenHash: hashToken(c.jar.get('gc_webauthn')) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await verify(c, authenticator.authenticate(issued))).data.code, 'passkey_invalid');

    for (const response of [null, 'x', 1, [], {}, { id: { $ne: null } }, { id: 'A', response: null }, { id: authenticator.id, response: { clientDataJSON: '%%%' } }]) {
      const fresh = client();
      await options(fresh);
      const res = await verify(fresh, response);
      assert.equal(res.status, 400, JSON.stringify(response));
      assert.equal(res.data.code, 'passkey_invalid');
    }
  });

  test('tài khoản bị khóa: chữ ký đúng cũng không có phiên', async () => {
    const { id, authenticator } = await studentWithPasskey();
    await User.updateOne({ _id: id }, { $set: { status: 'locked' } });
    const c = client();
    const res = await verify(c, authenticator.authenticate(await options(c)));
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'account_locked');
    assert.ok(!c.jar.has('gc_session'));
  });

  test('dò chữ ký sai bị giới hạn theo IP; đăng nhập đúng không tốn ngân sách của cả mạng', async () => {
    const { authenticator } = await studentWithPasskey();
    for (let i = 0; i < 25; i += 1) {
      const c = client();
      assert.equal((await verify(c, authenticator.authenticate(await options(c)))).status, 200, `lần ${i + 1}`);
    }
    await RateLimit.deleteMany({});
    const c = client();
    for (let i = 0; i < 20; i += 1) await verify(c, { id: 'khong-co' });
    assert.equal((await verify(c, { id: 'khong-co' })).status, 429);
  });

  test('tài khoản đã bật 2FA: passkey không hỏi thêm mã vì đã gồm hai yếu tố', async () => {
    const { c, authenticator } = await studentWithPasskey();
    const { secret } = (await c.post('/api/auth/mfa/setup')).data;
    await c.post('/api/auth/mfa/enable', { json: { code: totpCode(secret, totpStep()) } });
    const fresh = client();
    const res = await verify(fresh, authenticator.authenticate(await options(fresh)));
    assert.equal(res.status, 200);
    assert.ok(res.data.user);
    assert.ok(fresh.jar.has('gc_session'));
  });
});

describe('xóa passkey', () => {
  test('cần xác thực lại; xóa xong không đăng nhập được bằng khóa đó; passkey của người khác trả 404', async () => {
    const { c, id, authenticator, passkey } = await studentWithPasskey();
    const other = client();
    await registerUser(other);
    await reauth(other);
    assert.equal((await other.del(`/api/auth/passkeys/${passkey.id}`)).status, 404);

    await Session.updateMany({ userId: id }, { $set: { reauthAt: new Date(0) } });
    assert.equal((await c.del(`/api/auth/passkeys/${passkey.id}`)).data.code, 'reauth_required');
    await reauth(c);
    assert.equal((await c.del('/api/auth/passkeys/khong-hop-le')).status, 404);
    assert.equal((await c.del(`/api/auth/passkeys/${passkey.id}`)).status, 200);
    assert.ok(await AuditLog.exists({ action: 'account.passkey_remove', actorId: id }));

    const fresh = client();
    assert.equal((await verify(fresh, authenticator.authenticate(await options(fresh)))).data.code, 'passkey_invalid');
  });

  test('không xóa được cách đăng nhập cuối cùng; hủy liên kết nhà cung cấp cũng tính cả passkey', async () => {
    const { id, authenticator, passkey } = await studentWithPasskey();
    await User.updateOne({ _id: id }, { $unset: { passwordHash: 1, passwordChangedAt: 1 } });
    const c = client();
    await verify(c, authenticator.authenticate(await options(c)));
    const res = await c.del(`/api/auth/passkeys/${passkey.id}`);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'last_login_method');

    await User.updateOne({ _id: id }, { $set: { googleId: `g-${id}` } });
    assert.equal((await c.del('/api/auth/providers/google')).status, 200, 'còn passkey nên hủy được Google');
  });
});

describe('passkey ở bước hai của đăng nhập quản trị', () => {
  async function adminWithPasskey() {
    const admin = await enrolledAdmin(ctx.base);
    const student = createClient(ctx.base);
    const loggedIn = await student.post('/api/auth/login', { json: { email: admin.email, password: ADMIN_PASSWORD } });
    assert.equal(loggedIn.status, 200);
    await student.post('/api/auth/reauth', { json: { password: ADMIN_PASSWORD } });
    const opts = await options(student, '/api/auth/passkeys/register/options');
    const authenticator = device();
    assert.equal((await student.post('/api/auth/passkeys/register/verify', { json: { response: authenticator.register(opts) } })).status, 201);
    return { ...admin, authenticator };
  }
  const pending = async (email) => {
    const c = adminClient(ctx.base);
    const res = await loginPassword(c, email);
    assert.equal(res.data.stage, 'mfa');
    return { c, res };
  };

  test('thay được mã TOTP: có nhật ký ghi phương thức; thiếu mật khẩu thì không tới được bước này', async () => {
    const { email, user, authenticator } = await adminWithPasskey();
    const { c, res } = await pending(email);
    assert.equal(res.data.passkeyAvailable, true);
    const opts = (await c.post('/api/admin/auth/passkey/options')).data;
    assert.deepEqual(opts.allowCredentials.map((item) => item.id), [authenticator.id]);
    const done = await c.post('/api/admin/auth/passkey/verify', { json: { response: authenticator.authenticate(opts) } });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.stage, 'active');
    const [entry] = await auditEntries({ action: 'admin.login', actorId: user._id, result: 'success' });
    assert.equal(entry.meta.method, 'passkey');

    assert.equal((await adminClient(ctx.base).post('/api/admin/auth/passkey/options')).status, 401);
  });

  test('passkey của sinh viên khác, trang giả mạo, chữ ký dùng lại đều không qua; thất bại có nhật ký và bị giới hạn', async () => {
    const { email, authenticator, user } = await adminWithPasskey();
    const student = await studentWithPasskey();
    const { c } = await pending(email);

    const opts = (await c.post('/api/admin/auth/passkey/options')).data;
    assert.equal((await c.post('/api/admin/auth/passkey/verify', { json: { response: student.authenticator.authenticate(opts) } })).status, 401);
    const opts2 = (await c.post('/api/admin/auth/passkey/options')).data;
    assert.equal((await c.post('/api/admin/auth/passkey/verify', { json: { response: authenticator.authenticate(opts2, { origin: 'https://evil.test' }) } })).status, 401);
    assert.ok(await AuditLog.exists({ action: 'admin.login', actorId: user._id, result: 'failure', reason: 'invalid_passkey' }));

    for (let i = 0; i < 3; i += 1) await c.post('/api/admin/auth/passkey/verify', { json: { response: {} } });
    assert.equal((await c.post('/api/admin/auth/passkey/verify', { json: { response: {} } })).status, 429);
  });

  test('thử thách cấp cho quản trị viên này không dùng được cho quản trị viên khác, kể cả chép cookie', async () => {
    const first = await adminWithPasskey();
    const second = await adminWithPasskey();
    const { c: issuedTo } = await pending(first.email);
    const opts = (await issuedTo.post('/api/admin/auth/passkey/options')).data;

    const { c } = await pending(second.email);
    c.jar.set('gc_webauthn', issuedTo.jar.get('gc_webauthn'));
    assert.equal((await c.post('/api/admin/auth/passkey/verify', { json: { response: second.authenticator.authenticate(opts) } })).status, 401);
  });

  test('chưa có passkey: bước hai vẫn là TOTP, API báo không có', async () => {
    const admin = await enrolledAdmin(ctx.base);
    const { c, res } = await pending(admin.email);
    assert.equal(res.data.passkeyAvailable, false);
    assert.equal((await c.post('/api/admin/auth/passkey/options')).status, 404);
    assert.equal((await c.post('/api/admin/auth/mfa/verify', { json: { code: currentCode(admin.secret, 1) } })).status, 200);
  });

  test('thiếu token CSRF: bị từ chối', async () => {
    const { email } = await adminWithPasskey();
    const { c } = await pending(email);
    assert.equal((await c.raw.post('/api/admin/auth/passkey/options')).status, 403);
  });
});
