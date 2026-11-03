// Đăng nhập QR (chuyển trạng thái pending → approved/rejected → consumed/expired) và quản lý tài khoản
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { QrLogin } from '../../src/models/QrLogin.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { Session } from '../../src/models/Session.js';
import { User } from '../../src/models/User.js';
import { generateClaimCode, normalizeClaimCode } from '../../src/services/accounts.js';
import { hashToken } from '../../src/services/session.js';
import { createClient, registerUser, setEnv, startTestServer, submitRegistration, uniqueSuffix } from '../helpers.js';

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

async function startQr(headers) {
  const laptop = client();
  const res = await laptop.post('/api/auth/qr/start', { headers });
  assert.equal(res.status, 200);
  return { laptop, ...res.data };
}

describe('đăng nhập bằng QR — chuyển trạng thái', () => {
  test('từ chối: máy hiển thị QR nhận "rejected" đúng một lần, sau đó "expired"; không có phiên', async () => {
    const phone = client();
    await registerUser(phone);
    const { laptop, challengeId, pollToken } = await startQr();
    assert.equal((await phone.post(`/api/auth/qr/challenge/${challengeId}/reject`)).status, 200);
    assert.equal((await laptop.post('/api/auth/qr/poll', { json: { pollToken } })).data.status, 'rejected');
    assert.equal((await laptop.post('/api/auth/qr/poll', { json: { pollToken } })).data.status, 'expired');
    assert.equal((await phone.post(`/api/auth/qr/challenge/${challengeId}/approve`)).status, 410, 'không xác nhận được sau khi từ chối');
    assert.ok(!laptop.jar.has('gc_session'));
  });

  test('hết hạn: poll → expired; xem → 404; xác nhận/từ chối → 410', async () => {
    const phone = client();
    await registerUser(phone);
    const { laptop, challengeId, pollToken } = await startQr();
    await QrLogin.updateOne({ challengeHash: hashToken(challengeId) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await laptop.post('/api/auth/qr/poll', { json: { pollToken } })).data.status, 'expired');
    assert.equal((await phone.get(`/api/auth/qr/challenge/${challengeId}`)).status, 404);
    assert.equal((await phone.post(`/api/auth/qr/challenge/${challengeId}/approve`)).status, 410);
    assert.equal((await phone.post(`/api/auth/qr/challenge/${challengeId}/reject`)).status, 410);
  });

  test('đã xác nhận nhưng quá hạn nhận phiên (60 giây) → expired, không cấp phiên', async () => {
    const phone = client();
    await registerUser(phone);
    const { laptop, challengeId, pollToken, matchCode } = await startQr();
    await phone.post(`/api/auth/qr/challenge/${challengeId}/approve`, { json: { matchCode } });
    await QrLogin.updateOne({ challengeHash: hashToken(challengeId) }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    assert.equal((await laptop.post('/api/auth/qr/poll', { json: { pollToken } })).data.status, 'expired');
    assert.ok(!laptop.jar.has('gc_session'));
  });

  test('chưa đăng nhập không xem / xác nhận / từ chối được; mã sai định dạng → 404/410; pollToken sai → expired', async () => {
    const { challengeId } = await startQr();
    const anonymous = client();
    assert.equal((await anonymous.get(`/api/auth/qr/challenge/${challengeId}`)).status, 401);
    assert.equal((await anonymous.post(`/api/auth/qr/challenge/${challengeId}/reject`)).status, 401);

    const phone = client();
    await registerUser(phone);
    for (const bad of ['ngan', 'A'.repeat(101), 'co-ky-tu-la-%2F-abcdefghijklmn']) {
      assert.equal((await phone.get(`/api/auth/qr/challenge/${bad}`)).status, 404, bad);
      assert.equal((await phone.post(`/api/auth/qr/challenge/${bad}/approve`)).status, 410, bad);
    }
    for (const pollToken of ['', 'ngan', 'A'.repeat(43), 42]) {
      assert.equal((await client().post('/api/auth/qr/poll', { json: { pollToken } })).data.status, 'expired');
    }
  });

  test('phiên được cấp cho đúng tài khoản đã xác nhận; xác nhận lần hai → 410', async () => {
    const phone = client();
    const { body } = await registerUser(phone);
    const { laptop, challengeId, pollToken, matchCode } = await startQr();
    assert.equal((await phone.post(`/api/auth/qr/challenge/${challengeId}/approve`, { json: { matchCode } })).status, 200);
    assert.equal((await phone.post(`/api/auth/qr/challenge/${challengeId}/approve`, { json: { matchCode } })).status, 410);
    const approved = await laptop.post('/api/auth/qr/poll', { json: { pollToken } });
    assert.equal(approved.data.user.studentId, body.studentId);
    assert.equal((await laptop.get('/api/auth/me')).data.user.studentId, body.studentId);
  });

  test('mô tả thiết bị yêu cầu theo User-Agent (giúp người xác nhận nhận ra máy lạ)', async () => {
    const phone = client();
    await registerUser(phone);
    for (const [ua, expected] of [
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0', 'Edge trên Windows'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 'Safari trên iOS'],
      ['Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0', 'Firefox trên Android'],
      ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 coc_coc_browser/130.0 Chrome/124.0 Safari/537.36', 'Cốc Cốc trên Windows'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 OPR/120.0', 'Opera trên macOS'],
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', 'Chrome trên Linux'],
      ['curl/8.0', 'Trình duyệt trên hệ điều hành không rõ'],
    ]) {
      const { challengeId } = await startQr({ 'User-Agent': ua });
      assert.equal((await phone.get(`/api/auth/qr/challenge/${challengeId}`)).data.device, expected, ua);
    }
  });

  test('QR bị tắt → 503 và providers báo chưa bật', async () => {
    setEnv({ QR_LOGIN_ENABLED: 'false' });
    const res = await client().post('/api/auth/qr/start');
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'provider_not_configured');
    assert.equal((await client().get('/api/auth/providers')).data.providers.qr.enabled, false);
  });

  test('tối đa 60 mã QR / 10 phút / IP (lần 61 → 429)', async () => {
    const c = client();
    const statuses = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await c.post('/api/auth/qr/start')).status);
    assert.equal(statuses.filter((s) => s === 200).length, 60);
    assert.equal(statuses[60], 429);
  });
});

describe('đăng ký đồng thời', () => {
  test('cùng email đăng ký hai lần rồi xác minh đồng thời → đúng một tài khoản, liên kết cũ hết hiệu lực', async () => {
    const email = `dong-thoi-${uniqueSuffix()}@example.edu.vn`;
    const first = await submitRegistration(client(), { email });
    const second = await submitRegistration(client(), { email });
    const verify = ({ token, body }) => client().post('/api/auth/email/verify', { json: { token, password: body.password } });
    const results = await Promise.all([verify(first), verify(second)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
    assert.equal(results.find((r) => r.status === 400).data.code, 'verification_token_invalid');
    assert.equal(await User.countDocuments({ email }), 1);
  });

  test('cùng mã SV khác hoa/thường gửi đồng thời → đúng một tài khoản ("SV01" và "sv01" là một)', async () => {
    const studentId = `RACE${uniqueSuffix()}`.toUpperCase();
    // Giữ lệnh ghi cho tới khi cả hai yêu cầu đã qua bước kiểm tra trùng → tái hiện race ổn định, không phụ thuộc may rủi
    const originalCreate = User.create;
    const waiting = [];
    User.create = function create(...args) {
      return new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) waiting.forEach((release) => release());
      }).then(() => originalCreate.apply(this, args));
    };
    let results;
    try {
      results = await Promise.all([
        registerUser(client(), { studentId }),
        registerUser(client(), { studentId: studentId.toLowerCase() }),
      ]);
    } finally {
      User.create = originalCreate;
    }
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409).data.code, 'registration_conflict');
    assert.equal(await User.countDocuments({ studentId: new RegExp(`^${studentId}$`, 'i') }), 1);
  });
});

describe('quản lý tài khoản', () => {
  test('đổi mật khẩu: trùng mật khẩu cũ, quá ngắn, sai 5 lần → khóa 15 phút kể cả khi nhập đúng', async () => {
    const c = client();
    const { body } = await registerUser(c);
    const change = (currentPassword, newPassword) => c.post('/api/auth/password/change', { json: { currentPassword, newPassword } });
    assert.equal((await change(body.password, body.password)).status, 400);
    assert.equal((await change(body.password, 'ngan')).data.code, 'invalid_input');
    for (let i = 0; i < 5; i += 1) assert.equal((await change(`sai-${i}-mat-khau`, 'mat-khau-moi-123')).status, 400);
    const locked = await change(body.password, 'mat-khau-moi-123');
    assert.equal(locked.status, 429);
    assert.equal(locked.data.code, 'too_many_attempts');
  });

  test('đăng xuất khi chưa đăng nhập vẫn thành công; đăng xuất thiết bị khác khi chỉ có một phiên → 0', async () => {
    const anonymous = await client().post('/api/auth/logout');
    assert.deepEqual(anonymous.data, { ok: true });
    const c = client();
    await registerUser(c);
    assert.equal((await c.post('/api/auth/sessions/revoke-others')).data.revokedSessions, 0);
    const logout = await c.post('/api/auth/logout');
    assert.ok(logout.headers.getSetCookie().some((cookie) => /^gc_session=;/.test(cookie)), 'xóa cookie phiên');
  });

  test('tài khoản Google chưa có mật khẩu đặt mật khẩu qua email rồi đăng nhập bằng email được', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console' });
    const email = `google-only-${uniqueSuffix()}@gmail.com`;
    const user = await User.create({ studentId: `GO${uniqueSuffix()}`, name: 'Chỉ Google', email, googleId: `g-${uniqueSuffix()}` });
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      assert.equal((await client().post('/api/auth/password/forgot', { json: { email } })).status, 202);
      for (let i = 0; i < 50 && !lines.some((l) => l.includes('#reset=')); i += 1) await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.log = original;
    }
    const token = lines.join('\n').match(/#reset=([A-Za-z0-9_-]+)/)[1];
    const c = client();
    const reset = await c.post('/api/auth/password/reset', { json: { token, password: 'mat-khau-dau-tien' } });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.data.user.authMethods, { password: true, google: true, facebook: false });
    assert.equal((await client().post('/api/auth/login', { json: { email, password: 'mat-khau-dau-tien' } })).status, 200);
    assert.ok(await Session.countDocuments({ userId: user._id }) >= 2);
  });

  test('token đặt lại sai định dạng (42/44 ký tự, ký tự lạ) → reset_token_invalid', async () => {
    for (const token of ['A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}/`, '']) {
      const res = await client().post('/api/auth/password/reset', { json: { token, password: 'mat-khau-moi-123' } });
      assert.equal(res.status, 400, token);
      assert.equal(res.data.code, 'reset_token_invalid');
    }
  });

  test('quên mật khẩu: tối đa 30 yêu cầu / giờ / IP', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console' });
    const c = client();
    const statuses = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push((await c.post('/api/auth/password/forgot', { json: { email: `ip-limit-${i}-${uniqueSuffix()}@example.edu.vn` } })).status);
    }
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(202));
    assert.equal(statuses[30], 429);
  });

  test('mã kích hoạt tài khoản cũ: sai 10 lần → bị khóa (chống dò mã)', async () => {
    const studentId = `BF${uniqueSuffix()}`;
    const legacy = await User.create({ studentId, name: 'Tài khoản cũ' });
    const code = generateClaimCode();
    await User.updateOne(
      { _id: legacy._id },
      { $set: { claimCodeHash: hashToken(normalizeClaimCode(code)), claimCodeExpiresAt: new Date(Date.now() + 3600e3) } }
    );
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await registerUser(client(), { studentId, claimCode: `SAI${i}-AAAA-BBBB` })).data.code, 'invalid_claim_code');
    }
    const locked = await registerUser(client(), { studentId, claimCode: code });
    assert.equal(locked.status, 429, 'đúng mã cũng bị chặn khi đang khóa');
    assert.equal((await User.findById(legacy._id).lean()).email, undefined);
  });
});

describe('F-71: QRLjacking — mã QR do kẻ tấn công gửi', () => {
  const approve = (phone, challengeId, json) => phone.post(`/api/auth/qr/challenge/${challengeId}/approve`, { json });
  const poll = (laptop, pollToken) => laptop.post('/api/auth/qr/poll', { json: { pollToken } });

  test('bấm xác nhận mà không có mã đối chiếu: không cấp phiên cho thiết bị của kẻ tấn công', async () => {
    const victim = client();
    await registerUser(victim);
    const { laptop: attacker, challengeId, pollToken } = await startQr();
    const res = await approve(victim, challengeId, {});
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'qr_match_required');
    assert.equal((await poll(attacker, pollToken)).data.status, 'pending');
    assert.ok(!attacker.jar.has('gc_session'));
  });

  test('mã đối chiếu chỉ hiện trên thiết bị tạo QR, không có trong màn hình xác nhận hay trong DB', async () => {
    const phone = client();
    await registerUser(phone);
    const { challengeId, matchCode } = await startQr();
    assert.match(matchCode, /^\d{4}$/);
    const info = await phone.get(`/api/auth/qr/challenge/${challengeId}`);
    assert.equal(info.status, 200);
    assert.ok(!Object.values(info.data).includes(matchCode));
    const stored = await QrLogin.findOne({ challengeHash: hashToken(challengeId) }).lean();
    assert.equal(stored.matchCodeHash, hashToken(matchCode));
    assert.ok(!Object.values(stored).includes(matchCode), 'DB không lưu mã nguyên văn');
  });

  test('nhập đúng mã: thiết bị tạo QR nhận phiên như trước', async () => {
    const phone = client();
    await registerUser(phone);
    const { laptop, challengeId, pollToken, matchCode } = await startQr();
    assert.equal((await approve(phone, challengeId, { matchCode })).status, 200);
    assert.equal((await poll(laptop, pollToken)).data.status, 'approved');
    assert.ok(laptop.jar.has('gc_session'));
  });

  test('nhập sai 3 lần: thử thách bị hủy, thiết bị kia nhận "rejected", mã đúng cũng không còn tác dụng', async () => {
    const victim = client();
    await registerUser(victim);
    const { laptop: attacker, challengeId, pollToken, matchCode } = await startQr();
    const wrong = matchCode === '0000' ? '1111' : '0000';
    assert.equal((await approve(victim, challengeId, { matchCode: wrong })).data.code, 'qr_match_invalid');
    assert.equal((await approve(victim, challengeId, { matchCode: wrong })).data.code, 'qr_match_invalid');
    assert.equal((await approve(victim, challengeId, { matchCode: wrong })).status, 410);
    assert.equal((await approve(victim, challengeId, { matchCode })).status, 410);
    assert.equal((await poll(attacker, pollToken)).data.status, 'rejected');
    assert.ok(!attacker.jar.has('gc_session'));
  });

  test('gửi đồng thời nhiều mã đoán không vượt được giới hạn 3 lần', async () => {
    const victim = client();
    await registerUser(victim);
    const { laptop: attacker, challengeId, pollToken, matchCode } = await startQr();
    const guesses = Array.from({ length: 40 }, (_, i) => String(i).padStart(4, '0')).filter((code) => code !== matchCode);
    const results = await Promise.all(guesses.map((code) => approve(victim, challengeId, { matchCode: code })));
    assert.ok(results.every((res) => res.status !== 200));
    assert.equal((await poll(attacker, pollToken)).data.status, 'rejected');
  });

  test('toán tử hoặc kiểu lạ ở mã đối chiếu không qua được kiểm tra', async () => {
    const victim = client();
    await registerUser(victim);
    const { challengeId } = await startQr();
    for (const matchCode of [{ $ne: '0' }, ['1234'], 1234, null, '']) {
      const res = await approve(victim, challengeId, { matchCode });
      assert.equal(res.status, 400, JSON.stringify(matchCode));
    }
  });
});

describe('F-72: QR đã xác nhận nhưng chưa nhận phiên không sống sót sau khi thu hồi phiên', () => {
  test('đặt lại mật khẩu: thiết bị đang chờ nhận phiên không vào được tài khoản', async () => {
    const stolen = client();
    const { body } = await registerUser(stolen);
    const { laptop: attacker, challengeId, pollToken, matchCode } = await startQr();
    await stolen.post(`/api/auth/qr/challenge/${challengeId}/approve`, { json: { matchCode } });

    const user = await User.findOne({ email: body.email });
    const token = 'Q'.repeat(43);
    await PasswordReset.create({ tokenHash: hashToken(token), userId: user._id, expiresAt: new Date(Date.now() + 60_000) });
    assert.equal((await client().post('/api/auth/password/reset', { json: { token, password: 'mat-khau-moi-cua-chu-9' } })).status, 200);

    assert.equal((await attacker.post('/api/auth/qr/poll', { json: { pollToken } })).data.status, 'expired');
    assert.ok(!attacker.jar.has('gc_session'));
  });
});
