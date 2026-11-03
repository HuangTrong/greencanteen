// Kiểm thử bảo mật theo OWASP Top 10:2021 trên API chạy local + MongoDB in-memory.
// Payload đều an toàn (chuỗi/JSON), không thực thi mã, không gọi ra ngoài: fetch tới máy khác bị chặn trong test.
// Test có `todo` = lỗ hổng/khoảng trống đã xác nhận nhưng cần quyết định sản phẩm.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { User } from '../../src/models/User.js';
import { Session } from '../../src/models/Session.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { uploadDir } from '../../src/routes/checkin.js';
import { syncStories } from '../../src/services/stories.js';
import { hashToken } from '../../src/services/session.js';
import {
  createClient,
  imageForm,
  realFetch,
  registerUser,
  setEnv,
  startTestServer,
  submitRegistration,
  uniquePng,
  uniqueSuffix,
} from '../helpers.js';

// Ngưỡng mặc định đã ghi trong tài liệu: đổi giá trị phải sửa cả ở đây
const DEFAULT_LOGIN_IP_MAX = 100;
const DEFAULT_REGISTER_IP_MAX = 100;

let ctx;
let outboundCalls;
const client = () => createClient(ctx.base);
const setCookies = (res) => res.headers.getSetCookie();

before(async () => {
  setEnv();
  ctx = await startTestServer();
  await syncStories();
  // Không request nào được rời máy local (SSRF / gọi nhầm nhà cung cấp thật)
  outboundCalls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
    outboundCalls.push(href);
    throw new Error(`Chặn request ra ngoài trong test: ${href}`);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv();
  await RateLimit.deleteMany({});
});

describe('A03 Injection — toán tử MongoDB trong JSON', () => {
  test('đăng nhập bằng { $ne: null } không vượt qua xác thực', async () => {
    await registerUser(client());
    const c = client();
    for (const json of [
      { email: { $ne: null }, password: { $ne: null } },
      { email: { $gt: '' }, password: 'bat-ky-mat-khau' },
      { email: 'a@example.edu.vn', password: { $gt: '' } },
      { email: ['a@example.edu.vn'], password: ['x'] },
    ]) {
      const res = await c.post('/api/auth/login', { json });
      assert.equal(res.status, 400, JSON.stringify(json));
      assert.equal(res.data.code, 'invalid_input');
    }
    assert.ok(!c.jar.has('gc_session'));
  });

  test('đặt lại mật khẩu, QR, đăng ký, quên mật khẩu: object thay chuỗi bị từ chối', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console' });
    const c = client();
    const reset = await c.post('/api/auth/password/reset', { json: { token: { $ne: null }, password: 'mat-khau-moi-123' } });
    assert.equal(reset.status, 400);
    assert.equal(reset.data.code, 'reset_token_invalid');
    assert.deepEqual((await c.post('/api/auth/qr/poll', { json: { pollToken: { $ne: null } } })).data, { status: 'expired' });
    const register = await c.post('/api/auth/register', {
      json: { name: 'Tên', studentId: { $gt: '' }, email: 'x@example.edu.vn', password: 'mat-khau-an-toan' },
    });
    assert.equal(register.status, 400);
    const forgot = await c.post('/api/auth/password/forgot', { json: { email: { $regex: '.*' } } });
    assert.equal(forgot.status, 400);
  });

  test('đổi mật khẩu với currentPassword là object → sai mật khẩu, không đổi', async () => {
    const c = client();
    const { body } = await registerUser(c);
    const res = await c.post('/api/auth/password/change', { json: { currentPassword: { $ne: null }, newPassword: 'mat-khau-moi-123' } });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'invalid_current_password');
    assert.equal((await client().post('/api/auth/login', { json: { email: body.email, password: body.password } })).status, 200);
  });

  test('tham số query/URL dạng object hoặc chuỗi JSON không đổi truy vấn', async () => {
    const lb = await client().get('/api/stats/leaderboard?period[$ne]=week');
    assert.equal(lb.status, 200);
    assert.equal(lb.data.period, 'week');
    const c = client();
    await registerUser(c);
    const legacy = await c.get(`/api/checkin/history/${encodeURIComponent('{"$ne":null}')}`);
    assert.equal(legacy.status, 403);
  });

  test('XSS lưu trữ: tên chứa thẻ HTML được lưu và trả về dạng dữ liệu JSON, không phải HTML', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const c = client();
    const res = await registerUser(c, { name: payload });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.name, payload);
    const me = await c.get('/api/auth/me');
    assert.match(me.headers.get('content-type'), /^application\/json/);
  });
});

describe('A01 Broken Access Control', () => {
  test('mass assignment: đăng ký không nhận điểm, lượt quay, huy hiệu hay liên kết OAuth từ body', async () => {
    const res = await registerUser(client(), {
      ecoPoints: 99_999,
      totalCheckIns: 500,
      pendingGachaSpins: 100,
      badges: ['planet_guardian'],
      googleId: 'google-cua-nguoi-khac',
      passwordHash: 'scrypt$1$1$1$x$y',
      claimCodeHash: 'x',
    });
    assert.equal(res.status, 201);
    const stored = await User.findById(res.data.user.id).select('+passwordHash').lean();
    assert.equal(stored.ecoPoints, 0);
    assert.equal(stored.totalCheckIns, 0);
    assert.equal(stored.pendingGachaSpins, 0);
    assert.deepEqual(stored.badges, []);
    assert.equal(stored.googleId, undefined);
    assert.match(stored.passwordHash, /^scrypt\$32768\$/);
  });

  test('prototype pollution qua khóa __proto__ trong JSON không ảnh hưởng server', async () => {
    const suffix = uniqueSuffix();
    const email = `pp${suffix}@example.edu.vn`;
    const raw = `{"name":"Tên Thử","studentId":"PP${suffix}","email":"${email}","password":"mat-khau-an-toan","__proto__":{"isAdmin":true,"polluted":"yes"}}`;
    const res = await registerUser(client(), { email, password: 'mat-khau-an-toan' }, { raw });
    assert.equal(res.status, 201);
    assert.equal({}.polluted, undefined);
    assert.equal(res.data.user.isAdmin, undefined);
  });

  test('truy cập ngang tài khoản qua route cũ /:studentId và check-in hộ người khác bị chặn', async () => {
    setEnv({ VISION_SIMULATION: 'true' });
    const a = client();
    const b = client();
    const { body: aBody } = await registerUser(a);
    const { body: bBody } = await registerUser(b);
    assert.equal((await b.get(`/api/auth/user/${encodeURIComponent(aBody.studentId)}`)).status, 403);
    assert.equal((await b.get(`/api/auth/user/${encodeURIComponent(bBody.studentId)}`)).status, 200);
    const form = imageForm(uniquePng(), { extra: { studentId: aBody.studentId } });
    const checkIn = await b.post('/api/checkin', { form });
    assert.equal(checkIn.status, 403);
    assert.equal((await a.get('/api/auth/me')).data.user.ecoPoints, 0);
  });

  test('tài khoản end-user không gọi được API quản trị (bộ kiểm tra đầy đủ: admin-access.test.js)', async () => {
    setEnv({ ADMIN_MFA_KEY: 'a'.repeat(64) });
    const c = client();
    await registerUser(c);
    for (const [method, url] of [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'],
    ]) {
      const res = await c.request(method, url, { json: method === 'GET' ? undefined : { username: 'x', role: 'admin' } });
      assert.equal(res.status, 401, `${method} ${url}`);
      assert.equal(res.data.code, 'admin_auth_required');
    }
  });

  test('không tồn tại API công khai tìm/tạo người dùng theo vai trò hay huỷ liên kết đăng nhập', async () => {
    const c = client();
    await registerUser(c);
    for (const [method, url] of [
      ['GET', '/api/users?role=admin&status=active'],
      ['DELETE', '/api/auth/google'],
      ['POST', '/api/auth/google/unlink'],
      ['DELETE', '/api/auth/facebook'],
    ]) {
      const res = await c.request(method, url, { json: method === 'GET' ? undefined : { username: 'x', role: 'admin' } });
      assert.equal(res.status, 404, `${method} ${url}`);
    }
  });
});

describe('A07 Identification and Authentication Failures', () => {
  test('chống cố định phiên: token có sẵn trên trình duyệt không được dùng lại sau đăng nhập', async () => {
    const { body } = await registerUser(client());
    const c = client();
    c.jar.set('gc_session', 'token-do-ke-tan-cong-dat-truoc');
    const res = await c.post('/api/auth/login', { json: { email: body.email, password: body.password } });
    assert.equal(res.status, 200);
    assert.notEqual(c.jar.get('gc_session'), 'token-do-ke-tan-cong-dat-truoc');
    assert.equal(await Session.countDocuments({ tokenHash: hashToken('token-do-ke-tan-cong-dat-truoc') }), 0);
  });

  test('đăng xuất thu hồi phiên ở server: dùng lại cookie cũ → 401', async () => {
    const c = client();
    await registerUser(c);
    const stolen = c.jar.get('gc_session');
    await c.post('/api/auth/logout');
    const replay = client();
    replay.jar.set('gc_session', stolen);
    assert.equal((await replay.get('/api/auth/me')).status, 401);
  });

  test('phiên hết hạn hoặc cookie bị sửa → 401', async () => {
    const c = client();
    const { data } = await registerUser(c);
    const token = c.jar.get('gc_session');
    await Session.updateOne({ tokenHash: hashToken(decodeURIComponent(token)) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await c.get('/api/auth/me')).status, 401);
    const forged = client();
    forged.jar.set('gc_session', `${token}x`);
    assert.equal((await forged.get('/api/auth/me')).status, 401);
    assert.ok(data.user.id);
  });

  test('đăng nhập không tiết lộ email có tồn tại: email lạ và sai mật khẩu trả về giống hệt nhau', async () => {
    const { body } = await registerUser(client());
    const wrongPassword = await client().post('/api/auth/login', { json: { email: body.email, password: 'sai-mat-khau-123' } });
    const unknownEmail = await client().post('/api/auth/login', {
      json: { email: `khong-co-${uniqueSuffix()}@example.edu.vn`, password: 'sai-mat-khau-123' },
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.deepEqual(wrongPassword.data, unknownEmail.data);
  });

  test('chính sách mật khẩu: biên 8 / 128 ký tự ở API', async () => {
    const eight = 'xK9#mPq2';
    assert.equal((await registerUser(client(), { password: '1234567' })).status, 400);
    assert.equal((await registerUser(client(), { password: `${eight.repeat(16)}x` })).status, 400);
    assert.equal((await registerUser(client(), { password: eight })).status, 201);
    assert.equal((await registerUser(client(), { password: eight.repeat(16) })).status, 201);
  });

  test('F-08: mật khẩu phổ biến/đã lộ phải bị từ chối', async () => {
    for (const password of ['12345678', 'password', '11111111', 'qwertyui']) {
      const res = await registerUser(client(), { password });
      assert.equal(res.status, 400, password);
      assert.equal(res.data.code, 'invalid_input', password);
      assert.ok(!JSON.stringify(res.data).includes(password), 'phản hồi không nhắc lại mật khẩu');
    }
  });

  test('F-06: đăng ký không được tiết lộ email đã có tài khoản', async () => {
    const { body } = await registerUser(client());
    const again = await submitRegistration(client(), { email: body.email });
    assert.notEqual(again.data.code, 'email_taken');
    const fresh = await submitRegistration(client());
    assert.equal(again.status, fresh.status);
    assert.deepEqual(again.data, fresh.data);
  });

  test('F-05: đăng ký phải xác minh quyền sở hữu email trước khi kích hoạt', async () => {
    const c = client();
    const res = await submitRegistration(c);
    assert.equal(res.status, 202);
    assert.ok(!c.jar.has('gc_session'), 'chưa có phiên trước khi xác minh');
    assert.notEqual((await c.get('/api/auth/me')).status, 200, 'phiên chỉ nên cấp sau khi xác minh email');
    assert.equal(await User.countDocuments({ email: res.body.email }), 0, 'chưa có tài khoản');
    const verified = await c.post('/api/auth/email/verify', { json: { token: res.token, password: res.body.password } });
    assert.equal(verified.status, 201);
    assert.equal((await c.get('/api/auth/me')).status, 200);
  });

  // Chạy ở ngưỡng mặc định, không đặt lại bằng biến môi trường: ngưỡng thật sự được áp dụng khi triển khai. Biên chi tiết ở auth-rate-limit.test.js
  test('F-04: giới hạn tần suất theo IP cho đăng nhập sai nhiều email và đăng ký hàng loạt', async () => {
    const c = client();
    const spray = await Promise.all(
      Array.from({ length: DEFAULT_LOGIN_IP_MAX + 1 }, (_, i) =>
        c.post('/api/auth/login', { json: { email: `spray-${i}-${uniqueSuffix()}@example.edu.vn`, password: 'Password1!' } })
      )
    );
    const loginStatuses = spray.map((r) => r.status);
    assert.equal(loginStatuses.filter((s) => s === 401).length, DEFAULT_LOGIN_IP_MAX, 'mọi lần trong ngưỡng được chấm');
    assert.equal(loginStatuses.filter((s) => s === 429).length, 1, 'password spraying từ một IP phải bị chặn');

    setEnv({ AUTH_REGISTER_IP_MAX: '' }); // bỏ ngưỡng nới rộng của setEnv để đo đúng giá trị mặc định
    await RateLimit.deleteMany({});
    const accounts = await Promise.all(Array.from({ length: DEFAULT_REGISTER_IP_MAX + 1 }, () => submitRegistration(client())));
    const statuses = accounts.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 202).length, DEFAULT_REGISTER_IP_MAX, `mọi lần trong ngưỡng được nhận: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 429).length, 1, 'đăng ký hàng loạt từ một IP phải bị chặn');
  });
});

describe('A05 Security Misconfiguration', () => {
  test('không lộ x-powered-by; lỗi trả JSON không kèm stack', async () => {
    const res = await client().get('/api/khong-ton-tai');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.status, 404);
    const bad = await client().post('/api/auth/login', { json: '{"email": "a@b.vn",' });
    assert.equal(bad.status, 400);
    assert.ok(!JSON.stringify(bad.data).includes('at '), 'không có stack trace');
    const huge = await client().post('/api/auth/login', { json: JSON.stringify({ email: 'a@b.vn', password: 'x'.repeat(110 * 1024) }) });
    assert.equal(huge.status, 413);
    assert.equal(huge.data.code, 'payload_too_large');
  });

  test('CORS chỉ cho CLIENT_ORIGIN; preflight từ trang lạ không được phép', async () => {
    const allowed = await client().get('/api/stats/school', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
    // Origin cấu hình là chuỗi cố định → header luôn là CLIENT_ORIGIN; trình duyệt chặn vì không khớp origin lạ.
    // Điều cần kiểm: không bao giờ phản chiếu origin lạ và không dùng '*' cùng credentials.
    const evil = await client().get('/api/stats/school', { headers: { Origin: 'https://evil.example' } });
    for (const res of [evil]) {
      assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://evil.example');
      assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
    }
    const preflight = await client().request('OPTIONS', '/api/auth/password/change', {
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-requested-with,content-type' },
    });
    assert.equal(preflight.status, 204);
    assert.notEqual(preflight.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');
  });

  test('cookie phiên: HttpOnly, SameSite=Lax, Path=/; Secure khi production', async () => {
    const dev = await registerUser(client());
    const devCookie = setCookies(dev).find((c) => c.startsWith('gc_session='));
    assert.match(devCookie, /HttpOnly/);
    assert.match(devCookie, /SameSite=Lax/);
    assert.match(devCookie, /Path=\//);
    assert.doesNotMatch(devCookie, /Secure/);

    setEnv({ NODE_ENV: 'production' });
    const prod = await registerUser(client());
    assert.match(setCookies(prod).find((c) => c.startsWith('gc_session=')), /; Secure/);
  });

  test('mọi request thay đổi dữ liệu thiếu header X-Requested-With bị từ chối (CSRF)', async () => {
    const c = client();
    await registerUser(c);
    for (const [method, url] of [
      ['POST', '/api/auth/register'],
      ['POST', '/api/auth/email/verify'],
      ['POST', '/api/auth/email/resend'],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/sessions/revoke-others'],
      ['POST', '/api/auth/password/forgot'],
      ['POST', '/api/auth/password/reset'],
      ['POST', '/api/auth/password/change'],
      ['POST', '/api/auth/signup/complete'],
      ['DELETE', '/api/auth/signup/pending'],
      ['POST', '/api/auth/qr/start'],
      ['POST', `/api/auth/qr/challenge/${'A'.repeat(32)}/approve`],
      ['POST', '/api/checkin'],
      ['POST', '/api/gacha/spin'],
    ]) {
      const res = await c.request(method, url, { csrf: false, json: {} });
      assert.equal(res.status, 403, `${method} ${url}`);
      assert.equal(res.data.code, 'csrf_rejected');
    }
    assert.equal((await c.get('/api/auth/me')).status, 200, 'phiên không bị đăng xuất bởi request giả mạo');
  });

  test('header bảo mật: nosniff và không lưu cache dữ liệu cá nhân', async () => {
    const c = client();
    await registerUser(c);
    for (const url of ['/api/auth/me', '/api/gacha/rewards', '/api/stats/school']) {
      const res = await c.get(url);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
      assert.match(res.headers.get('cache-control') || '', /no-store/, url);
    }
  });
});

describe('F-77: nghe lén và hạ cấp giao thức', () => {
  test('production: mọi phản hồi API có Strict-Transport-Security; môi trường phát triển thì không', async () => {
    const c = client();
    assert.equal((await c.get('/api/health')).headers.get('strict-transport-security'), null);
    setEnv({ NODE_ENV: 'production' });
    for (const path of ['/api/health', '/api/auth/providers', '/api/khong-co']) {
      assert.equal((await c.get(path)).headers.get('strict-transport-security'), 'max-age=31536000', path);
    }
  });
});

describe('A08 Software and Data Integrity — OAuth state', () => {
  test('cookie OAuth thiếu state không thể khớp với state="undefined"', async () => {
    setEnv({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret' });
    const c = client();
    c.jar.set('gc_oauth', encodeURIComponent(JSON.stringify({ provider: 'google', mode: 'login' })));
    outboundCalls.length = 0;
    const res = await c.get('/api/auth/google/callback?code=abc&state=undefined');
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /auth_error=invalid_state/);
    assert.deepEqual(outboundCalls, [], 'không đổi code khi state không hợp lệ');
  });
});

describe('Upload ảnh — tên tệp, loại nội dung, tệp đa định dạng', () => {
  const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  test('tên tệp chứa ../ không ghi ra ngoài thư mục tạm; tệp tạm bị xóa', async () => {
    setEnv({ VISION_SIMULATION: 'true' });
    const c = client();
    await registerUser(c);
    const before = filesIn(uploadDir).length;
    const res = await c.post('/api/checkin', { form: imageForm(uniquePng(), { name: '../../../evil-traversal.png' }) });
    assert.equal(res.status, 200);
    assert.equal(filesIn(uploadDir).length, before);
    for (const dir of [path.dirname(uploadDir), path.resolve(uploadDir, '../..'), path.resolve(uploadDir, '../../..')]) {
      assert.ok(!fs.existsSync(path.join(dir, 'evil-traversal.png')), dir);
    }
  });

  test('HTML/SVG khai báo image/png bị từ chối theo nội dung (415)', async () => {
    setEnv({ VISION_SIMULATION: 'true' });
    const c = client();
    await registerUser(c);
    for (const content of ['<html><script>alert(1)</script></html>', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>']) {
      const res = await c.post('/api/checkin', { form: imageForm(Buffer.from(content), { type: 'image/png', name: 'anh.png' }) });
      assert.equal(res.status, 415);
    }
  });

  test('chưa đăng nhập: bị chặn trước khi nhận tệp (không ghi tệp tạm)', async () => {
    const before = filesIn(uploadDir).length;
    const res = await client().post('/api/checkin', { form: imageForm(Buffer.alloc(512 * 1024, 1)) });
    assert.equal(res.status, 401);
    assert.equal(filesIn(uploadDir).length, before);
  });

  test('ảnh PNG hợp lệ nối thêm mã script vẫn qua kiểm tra định dạng (ghi nhận — tệp không bao giờ được phục vụ lại)', async () => {
    setEnv({ VISION_SIMULATION: 'true' });
    const c = client();
    await registerUser(c);
    const polyglot = Buffer.concat([uniquePng(), Buffer.from('<script>alert(1)</script>')]);
    const res = await c.post('/api/checkin', { form: imageForm(polyglot) });
    assert.equal(res.status, 200, 'không có quét mã độc — xem F-12');
    assert.ok(!JSON.stringify(res.data).includes('<script>'));
  });
});
