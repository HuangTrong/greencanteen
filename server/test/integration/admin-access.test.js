// Phân quyền khu quản trị: mọi route (kiểm kê từ chính router) với mọi loại người gọi, CSRF, header, cookie
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../../src/models/User.js';
import { AdminMfa } from '../../src/models/AdminMfa.js';
import { AdminSession } from '../../src/models/AdminSession.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { ADMIN_SECTIONS } from '../../src/routes/admin.js';
import { createClient, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV, adminClient, clearUsedStep, currentCode, enrolledAdmin, loginPassword, sessionOf } from '../adminHelpers.js';

let ctx;
const FAKE_ID = '0123456789abcdef01234567';

/** Danh sách [method, path] của mọi route quản trị, đọc từ router để route mới tự được kiểm tra */
function adminRoutes() {
  const routes = [];
  for (const [prefix, section] of ADMIN_SECTIONS) {
    for (const layer of section.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push([method.toUpperCase(), `/api/admin${prefix}${layer.route.path === '/' ? '' : layer.route.path.replace(':id', FAKE_ID)}`]);
      }
    }
  }
  return routes;
}

before(async () => {
  setEnv(ADMIN_ENV);
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(ADMIN_ENV);
  await RateLimit.deleteMany({});
});

const call = (client, method, path) => client.request(method, path, { json: method === 'GET' ? undefined : {} });

test('kiểm kê route phát hiện đủ các mục quản trị', () => {
  const routes = adminRoutes();
  assert.ok(routes.length >= 25, `chỉ thấy ${routes.length} route`);
  for (const section of ['/overview', '/users', '/stories', '/gacha', '/site-settings', '/audit-logs']) {
    assert.ok(routes.some(([, path]) => path.startsWith(`/api/admin${section}`)), section);
  }
});

describe('người không có phiên quản trị không gọi được API nào', () => {
  test('khách chưa đăng nhập → 401', async () => {
    const guest = createClient(ctx.base);
    for (const [method, path] of adminRoutes()) {
      const res = await call(guest, method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.data.code, 'admin_auth_required');
    }
  });

  test('tài khoản end-user có phiên hợp lệ → 401, phiên end-user không có tác dụng', async () => {
    const student = createClient(ctx.base);
    await registerUser(student);
    assert.equal((await student.get('/api/auth/me')).status, 200);
    for (const [method, path] of adminRoutes()) {
      const res = await call(student, method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  test('đường dẫn không tồn tại dưới /api/admin cũng 401, không lộ route nào có thật', async () => {
    assert.equal((await createClient(ctx.base).get('/api/admin/khong-ton-tai')).status, 401);
    assert.equal((await createClient(ctx.base).get('/api/admin/users/khong-phai-id')).status, 401);
  });

  test('phiên đang chờ MFA (mới qua mật khẩu) chưa gọi được API nào', async () => {
    const { email } = await enrolledAdmin(ctx.base);
    const pending = adminClient(ctx.base);
    assert.equal((await loginPassword(pending, email)).data.stage, 'mfa');
    for (const [method, path] of adminRoutes()) {
      const res = await call(pending, method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  test('phiên admin hết hạn tuyệt đối, nhàn rỗi quá hạn hoặc bị sửa cookie → 401', async () => {
    const expired = await enrolledAdmin(ctx.base);
    await AdminSession.updateOne({ _id: (await sessionOf(expired.client))._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await expired.client.get('/api/admin/users')).status, 401);

    const idle = await enrolledAdmin(ctx.base);
    const session = await sessionOf(idle.client);
    await AdminSession.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date(Date.now() - 16 * 60 * 1000) } });
    assert.equal((await idle.client.get('/api/admin/users')).status, 401);
    assert.equal(await AdminSession.countDocuments({ _id: session._id }), 0, 'phiên nhàn rỗi bị xóa');

    const forged = await enrolledAdmin(ctx.base);
    forged.client.jar.set('gc_admin', `${forged.client.jar.get('gc_admin')}x`);
    assert.equal((await forged.client.get('/api/admin/users')).status, 401);
  });

  test('thu hồi quyền có hiệu lực ngay ở request kế tiếp, kể cả khi sửa thẳng trong DB', async () => {
    const demoted = await enrolledAdmin(ctx.base);
    assert.equal((await demoted.client.get('/api/admin/users')).status, 200);
    await User.updateOne({ _id: demoted.user._id }, { $set: { role: 'user' } });
    assert.equal((await demoted.client.get('/api/admin/users')).status, 401);

    const locked = await enrolledAdmin(ctx.base);
    await User.updateOne({ _id: locked.user._id }, { $set: { status: 'locked' } });
    assert.equal((await locked.client.get('/api/admin/users')).status, 401);

    const noMfa = await enrolledAdmin(ctx.base);
    await AdminMfa.deleteOne({ userId: noMfa.user._id });
    assert.equal((await noMfa.client.get('/api/admin/users')).status, 401);
  });

  test('tài khoản bị xóa khỏi DB: phiên không còn tác dụng', async () => {
    const gone = await enrolledAdmin(ctx.base);
    await User.deleteOne({ _id: gone.user._id });
    assert.equal((await gone.client.get('/api/admin/users')).status, 401);
  });
});

describe('thiếu cấu hình thì từ chối truy cập quản trị', () => {
  test('không có ADMIN_MFA_KEY: mọi đường dẫn /api/admin trả 503, kể cả với phiên đang có', async () => {
    const { client, email } = await enrolledAdmin(ctx.base);
    for (const value of [undefined, 'qua-ngan', 'c2hvcnQ=']) {
      setEnv(value ? { ADMIN_MFA_KEY: value } : {});
      for (const path of ['/api/admin/users', '/api/admin/auth/session', '/api/admin/khong-co']) {
        const res = await client.get(path);
        assert.equal(res.status, 503, path);
        assert.equal(res.data.code, 'admin_not_configured');
      }
      const login = await adminClient(ctx.base).raw.post('/api/admin/auth/login', { json: { email, password: 'bat-ky' } });
      assert.equal(login.status, 503);
    }
  });

  test('có khóa nhưng chưa có admin nào: đăng nhập luôn thất bại', async () => {
    await User.updateMany({}, { $set: { role: 'user' } });
    const student = createClient(ctx.base);
    const { body } = await registerUser(student);
    const res = await student.post('/api/admin/auth/login', { json: { email: body.email, password: body.password } });
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'invalid_credentials');
  });
});

describe('không tự nâng quyền qua API công khai', () => {
  test('đăng ký kèm role / status bị bỏ qua, /me không lộ trường phân quyền', async () => {
    const client = createClient(ctx.base);
    const res = await registerUser(client, { role: 'admin', status: 'active', isAdmin: true });
    assert.equal(res.status, 201);
    assert.equal((await User.findById(res.data.user.id).lean()).role, 'user');
    assert.equal(res.data.user.role, undefined);
    assert.equal((await client.get('/api/auth/me')).data.user.role, undefined);
  });

  test('người đăng ký đầu tiên của hệ thống cũng không được quyền admin', async () => {
    await User.deleteMany({});
    const res = await registerUser(createClient(ctx.base));
    assert.equal((await User.findById(res.data.user.id).lean()).role, 'user');
  });

  test('khóa __proto__ và toán tử MongoDB không qua được đăng nhập quản trị', async () => {
    const suffix = uniqueSuffix();
    const email = `ap${suffix}@example.edu.vn`;
    const raw = `{"name":"Tên Thử","studentId":"AP${suffix}","email":"${email}","password":"mat-khau-an-toan","__proto__":{"role":"admin"}}`;
    const proto = await registerUser(createClient(ctx.base), { email, password: 'mat-khau-an-toan' }, { raw });
    assert.equal((await User.findById(proto.data.user.id).lean()).role, 'user');
    for (const json of [{ email: { $ne: null }, password: { $ne: null } }, { email: 'a@b.vn', password: { $gt: '' } }]) {
      assert.equal((await createClient(ctx.base).post('/api/admin/auth/login', { json })).status, 400);
    }
  });
});

describe('CSRF nhiều lớp', () => {
  test('thiếu header X-Requested-With → 403', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    const res = await client.raw.request('POST', '/api/admin/stories', { csrf: false, json: {}, headers: { 'X-CSRF-Token': client.raw.csrf } });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'csrf_rejected');
  });

  test('phiên hợp lệ nhưng thiếu hoặc sai token CSRF → 403, không có gì được ghi', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    for (const headers of [{}, { 'X-CSRF-Token': 'sai' }, { 'X-CSRF-Token': 'a'.repeat(43) }]) {
      const res = await client.raw.request('PUT', '/api/admin/site-settings', { json: {}, headers });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'csrf_rejected');
    }
  });

  test('Origin lạ bị từ chối dù đủ token; Origin đúng được nhận', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    const evil = await client.post('/api/admin/stories', { json: { title: 'x', slug: 'evil' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.data.code, 'csrf_rejected');
    const ok = await client.post('/api/admin/stories', {
      json: { title: 'Bản nháp', slug: `tu-dung-origin-${uniqueSuffix()}` },
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(ok.status, 201);
  });

  test('token CSRF đổi sau khi qua MFA: token của bước chờ không dùng được cho phiên đầy đủ', async () => {
    const { user, email, secret } = await enrolledAdmin(ctx.base);
    await clearUsedStep(user._id);
    const client = adminClient(ctx.base);
    const login = await loginPassword(client, email);
    const verified = await client.post('/api/admin/auth/mfa/verify', { json: { code: currentCode(secret) } });
    assert.equal(verified.status, 200);
    assert.notEqual(verified.data.csrfToken, login.data.csrfToken);
    const stale = await client.raw.request('PUT', '/api/admin/site-settings', { json: {}, headers: { 'X-CSRF-Token': login.data.csrfToken } });
    assert.equal(stale.status, 403);
    assert.equal(stale.data.code, 'csrf_rejected');
  });

  test('token CSRF của admin này không dùng được với phiên của admin khác', async () => {
    const first = await enrolledAdmin(ctx.base);
    const second = await enrolledAdmin(ctx.base);
    const res = await second.client.raw.request('PUT', '/api/admin/site-settings', { json: {}, headers: { 'X-CSRF-Token': first.client.raw.csrf } });
    assert.equal(res.status, 403);
  });
});

describe('header và cookie', () => {
  test('phản hồi quản trị: no-store, noindex, không nhúng khung, không có x-powered-by', async () => {
    const { client } = await enrolledAdmin(ctx.base);
    for (const res of [await client.get('/api/admin/overview'), await createClient(ctx.base).get('/api/admin/users')]) {
      assert.match(res.headers.get('cache-control'), /no-store/);
      assert.equal(res.headers.get('pragma'), 'no-cache');
      assert.match(res.headers.get('x-robots-tag'), /noindex/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('x-powered-by'), null);
    }
  });

  test('cookie gc_admin: HttpOnly, SameSite=Strict, chỉ gửi tới /api/admin; Secure khi production', async () => {
    const { email } = await enrolledAdmin(ctx.base);
    const dev = await loginPassword(adminClient(ctx.base), email);
    const devCookie = dev.headers.getSetCookie().find((c) => c.startsWith('gc_admin='));
    assert.match(devCookie, /HttpOnly/);
    assert.match(devCookie, /SameSite=Strict/);
    assert.match(devCookie, /Path=\/api\/admin/);
    assert.doesNotMatch(devCookie, /Secure/);

    setEnv({ ...ADMIN_ENV, NODE_ENV: 'production' });
    const prod = await loginPassword(adminClient(ctx.base), email);
    assert.match(prod.headers.getSetCookie().find((c) => c.startsWith('gc_admin=')), /; Secure/);

    setEnv({ ...ADMIN_ENV, COOKIE_SAMESITE: 'none' });
    const crossSite = await loginPassword(adminClient(ctx.base), email);
    const crossCookie = crossSite.headers.getSetCookie().find((c) => c.startsWith('gc_admin='));
    assert.match(crossCookie, /SameSite=None/);
    assert.match(crossCookie, /; Secure/);
  });
});

describe('giới hạn tốc độ API quản trị', () => {
  const setCount = (name, adminId, count) =>
    RateLimit.updateOne({ key: `${name}:${adminId}` }, { $set: { count, resetAt: new Date(Date.now() + 60_000) } }, { upsert: true });

  test('đọc tối đa 600, ghi tối đa 120 trong một cửa sổ; đếm riêng từng admin, hết lượt ghi vẫn đọc được', async () => {
    const [first, second] = [await enrolledAdmin(ctx.base), await enrolledAdmin(ctx.base)];

    await setCount('admin-api', first.user._id, 599);
    assert.equal((await first.client.get('/api/admin/site-settings')).status, 200, 'lượt thứ 600 vẫn được phục vụ');
    const read = await first.client.get('/api/admin/site-settings');
    assert.deepEqual([read.status, read.data.code], [429, 'too_many_attempts']);
    assert.equal((await second.client.get('/api/admin/site-settings')).status, 200, 'admin khác không bị ảnh hưởng');

    await setCount('admin-write', second.user._id, 119);
    assert.equal((await second.client.put('/api/admin/site-settings', { json: {} })).status, 400, 'lượt thứ 120 vẫn tới được route');
    const write = await second.client.put('/api/admin/site-settings', { json: {} });
    assert.deepEqual([write.status, write.data.code], [429, 'too_many_attempts']);
    assert.equal((await second.client.get('/api/admin/site-settings')).status, 200);
  });
});
