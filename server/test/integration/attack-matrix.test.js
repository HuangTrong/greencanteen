// Quét tự động theo kiểu công cụ dò lỗ hổng: đọc danh sách route trực tiếp từ router rồi gửi bộ payload SQLi, NoSQLi, XSS, kiểu dữ liệu lạ, path traversal,
// CRLF tới mọi route ở ba vai trò (khách, sinh viên, admin). Payload chỉ là chuỗi và JSON, không thực thi mã; mọi request ở 127.0.0.1, fetch ra ngoài bị chặn.
// Tiêu chí chung: không lỗi 5xx, không lộ thông tin nội bộ, không có phiên trái phép, không lộ dữ liệu của người khác, DB không nhận object thay cho chuỗi.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../../src/models/User.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { Story } from '../../src/models/Story.js';
import { AdminSession } from '../../src/models/AdminSession.js';
import accountSecurityRoutes from '../../src/routes/accountSecurity.js';
import adminAuthRoutes from '../../src/routes/adminAuth.js';
import { ADMIN_SECTIONS } from '../../src/routes/admin.js';
import analyticsRoutes from '../../src/routes/analytics.js';
import authRoutes from '../../src/routes/auth.js';
import avatarRoutes from '../../src/routes/avatars.js';
import checkinRoutes from '../../src/routes/checkin.js';
import gachaRoutes from '../../src/routes/gacha.js';
import qrAuthRoutes from '../../src/routes/qrAuth.js';
import siteRoutes from '../../src/routes/site.js';
import statsRoutes from '../../src/routes/stats.js';
import { syncStories } from '../../src/services/stories.js';
import { createClient, realFetch, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV, enrolledAdmin } from '../adminHelpers.js';

const MOUNTS = [
  ['/api/auth/qr', qrAuthRoutes],
  ['/api/auth', authRoutes],
  ['/api/auth', accountSecurityRoutes],
  ['/api/checkin', checkinRoutes],
  ['/api/stats', statsRoutes],
  ['/api/avatars', avatarRoutes],
  ['/api/gacha', gachaRoutes],
  ['/api/site', siteRoutes],
  ['/api/analytics', analyticsRoutes],
  ['/api/admin/auth', adminAuthRoutes],
  ...ADMIN_SECTIONS.map(([path, router]) => [`/api/admin${path}`, router]),
];

function listRoutes() {
  return MOUNTS.flatMap(([prefix, router]) =>
    router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods).map((method) => [method.toUpperCase(), `${prefix}${layer.route.path}`.replace(/\/$/, '')]))
  );
}

// Các route này đổi trạng thái đăng nhập của chính client đang quét, đã có test riêng
const SKIPPED = /\/logout$|\/sessions\/revoke-others$/;

const SQLI = ["' OR '1'='1", "' OR 1=1 --", "admin'--", '"; DROP TABLE users; --', "1; SELECT pg_sleep(5)--", "' UNION SELECT NULL,NULL--", "') OR ('a'='a"];
const XSS = ['<script>window.__xss=1</script>', '<img src=x onerror=window.__xss=1>', '"><svg onload=window.__xss=1>', 'javascript:window.__xss=1'];
const OTHER_TEXT = ['../../../../etc/passwd', '..%2f..%2fwindows%2fwin.ini', 'a\r\nX-Injected: 1', 'x@example.edu.vn\r\nBcc: khac@example.edu.vn', 'a\u0000b', '‮gnp.exe', 'x'.repeat(5000)];
const NOSQL = [{ $ne: null }, { $gt: '' }, { $regex: '.*' }, { $where: 'sleep(1000)' }, { $in: ['a', 'b'] }, { $exists: true }, [{ $ne: 1 }], { __proto__: { role: 'admin' } }, { constructor: { prototype: { role: 'admin' } } }];
const ODD_TYPES = [null, true, 0, -1, 1e21, [], {}, [[]], ['a', 'b']];
const BODY_PAYLOADS = [...SQLI, ...XSS, ...OTHER_TEXT, ...NOSQL, ...ODD_TYPES];
const TEXT_PAYLOADS = [...SQLI, ...XSS, ...OTHER_TEXT.slice(0, 4), '$ne', '[$ne]=1'];
const FIELDS = ['email', 'password', 'name', 'studentId', 'token', 'code', 'claimCode', 'matchCode', 'captcha', 'response', 'pollToken', 'currentPassword', 'newPassword', 'enrollCode', 'reason', 'status', 'role', 'revision', 'ids', 'slug', 'title', 'prizes', 'source', 'type', 'page', 'target', 'visitId', 'announcementText', 'basedOnId'];
const QUERY_KEYS = ['q', 'status', 'role', 'page', 'pageSize', 'period', 'from', 'to', 'granularity', 'action', 'result', 'targetType', 'targetId', 'mode'];

// Dấu vết của lỗi nội bộ lọt ra phản hồi
const LEAK = /MongoServerError|MongoError|CastError|ValidationError|E11000|mongoose|node_modules|\bat [\w.<>]+ \(|[A-Z]:\\|\/src\/|passwordHash|tokenHash|secretEnc|scrypt\$/;

let ctx;
let student;
let other;
let admin;
const problems = [];

function record(role, method, path, res, note) {
  problems.push(`${role} ${method} ${path} → ${res?.status ?? '-'} ${note}`.slice(0, 200));
}

function inspect(role, method, path, res, { cookieJar } = {}) {
  if (res.status >= 500) record(role, method, path, res, `lỗi máy chủ ${res.data?.code}`);
  const text = JSON.stringify(res.data ?? '');
  if (LEAK.test(text)) record(role, method, path, res, `lộ nội bộ: ${text.match(LEAK)[0]}`);
  if (res.headers.get('x-injected')) record(role, method, path, res, 'chèn được header');
  if (path.startsWith('/api') && res.status !== 204 && !/application\/json|image\/webp/.test(res.headers.get('content-type') || '') && res.status < 300) record(role, method, path, res, `kiểu phản hồi ${res.headers.get('content-type')}`);
  if (role === 'khách' && cookieJar?.has('gc_session')) record(role, method, path, res, 'khách nhận được phiên');
}

function client(role) {
  if (role === 'sinh viên') return student.c;
  if (role === 'admin') return admin.client;
  return createClient(ctx.base);
}

before(async () => {
  setEnv({ ...ADMIN_ENV, VISION_SIMULATION: 'true', EMAIL_TRANSPORT: 'console', QR_LOGIN_ENABLED: 'true' });
  ctx = await startTestServer();
  await syncStories();
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    throw new Error(`Chặn request ra ngoài trong test: ${url}`);
  };
  const c = createClient(ctx.base);
  const res = await registerUser(c, { studentId: `MUCTIEU${uniqueSuffix()}` });
  assert.equal(res.status, 201);
  student = { c, id: res.data.user.id, email: res.body.email, studentId: res.body.studentId };
  const c2 = createClient(ctx.base);
  const res2 = await registerUser(c2, { studentId: `NGUOIKHAC${uniqueSuffix()}`, name: 'Người Khác Bí Mật' });
  assert.equal(res2.status, 201);
  other = { id: res2.data.user.id, email: res2.body.email, studentId: res2.body.studentId };
  admin = await enrolledAdmin(ctx.base);
});
after(async () => {
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv({ ...ADMIN_ENV, VISION_SIMULATION: 'true', EMAIL_TRANSPORT: 'console' });
  problems.length = 0;
  await RateLimit.deleteMany({});
});

describe('quét tự động mọi route', () => {
  test('danh sách route đủ rộng để phép quét có ý nghĩa', () => {
    const routes = listRoutes();
    assert.ok(routes.length >= 60, `${routes.length} route`);
    for (const path of ['/api/auth/login', '/api/checkin', '/api/gacha/spin', '/api/admin/users/:id/status', '/api/admin/stories', '/api/admin/gacha/configs/:id/publish']) {
      assert.ok(routes.some(([, route]) => route === path), path);
    }
  });

  for (const role of ['khách', 'sinh viên', 'admin']) {
    test(`${role}: thân JSON mang SQLi, NoSQLi, XSS, kiểu lạ ở mọi trường của mọi route`, { timeout: 600_000 }, async () => {
      const c = client(role);
      const story = await Story.findOne().lean();
      const fill = (path) =>
        path
          .replace(/\/users\/:id/, `/users/${student.id}`)
          .replace(/\/stories\/:id/, `/stories/${story._id}`)
          .replace(/:[A-Za-z]+/g, 'a'.repeat(24));
      const originalError = console.error;
      console.error = () => {};
      try {
        for (const [method, route] of listRoutes().filter(([m, r]) => m !== 'GET' && !SKIPPED.test(r))) {
          const path = fill(route);
          for (const payload of BODY_PAYLOADS) {
            await RateLimit.deleteMany({});
            // Cả từng trường một: gộp hết thì trường đầu bị từ chối và các trường sau không bao giờ được đọc tới
            const bodies = [Object.fromEntries(FIELDS.map((field) => [field, payload])), ...FIELDS.map((field) => ({ [field]: payload }))];
            const responses = await Promise.all(bodies.map((json) => c.request(method, path, { json })));
            for (const res of responses) inspect(role, method, route, res);
          }
        }
      } finally {
        console.error = originalError;
      }
      assert.deepEqual(problems.slice(0, 20), []);
    });

    test(`${role}: tham số đường dẫn và query mang SQLi, XSS, toán tử ở mọi route đọc`, { timeout: 600_000 }, async () => {
      const c = client(role);
      const originalError = console.error;
      console.error = () => {};
      try {
        for (const [method, route] of listRoutes().filter(([m]) => m === 'GET')) {
          for (const payload of TEXT_PAYLOADS) {
            await RateLimit.deleteMany({});
            const encoded = encodeURIComponent(payload);
            const path = route.replace(/:[A-Za-z]+/g, encoded);
            // Từng tham số một, dạng toán tử gửi riêng: `q=x&q[$ne]=y` bị qs gộp thành object nên chuỗi thô không tới được mã xử lý
            const operators = QUERY_KEYS.flatMap((key) => [`${key}[$ne]=${encoded}`, `${key}[$regex]=.*`]).join('&');
            const responses = await Promise.all([...QUERY_KEYS.map((key) => `${key}=${encoded}`), operators].map((query) => c.request(method, `${path}?${query}`)));
            for (const res of responses) {
              inspect(role, method, route, res);
              if (role !== 'admin' && String(JSON.stringify(res.data)).includes('window.__xss') && !/application\/json/.test(res.headers.get('content-type'))) {
                record(role, method, route, res, 'phản chiếu payload ngoài JSON');
              }
            }
          }
        }
      } finally {
        console.error = originalError;
      }
      assert.deepEqual(problems.slice(0, 20), []);
    });
  }

  test('khách: đăng nhập, đặt lại mật khẩu, xác minh bằng SQLi và toán tử không cấp phiên', async () => {
    for (const payload of [...SQLI, ...NOSQL]) {
      for (const [path, json] of [
        ['/api/auth/login', { email: student.email, password: payload }],
        ['/api/auth/login', { email: payload, password: payload }],
        ['/api/admin/auth/login', { email: admin.email, password: payload }],
        ['/api/auth/password/reset', { token: payload, password: 'mat-khau-moi-an-toan-9' }],
        ['/api/auth/email/verify', { token: payload, password: payload }],
        ['/api/auth/qr/poll', { pollToken: payload }],
      ]) {
        await RateLimit.deleteMany({});
        const c = createClient(ctx.base);
        const res = await c.post(path, { json });
        assert.ok(res.status < 500, `${path}: ${res.status}`);
        assert.equal(c.jar.size, 0, `${path}: có cookie sau khi gửi ${JSON.stringify(payload)}`);
        // /qr/poll luôn trả 200 kèm trạng thái; các đường còn lại không được thành công
        assert.equal(path === '/api/auth/qr/poll' ? res.data.status : res.status === 200, path === '/api/auth/qr/poll' ? 'expired' : false, path);
      }
    }
  });

  test('header thù địch: cookie, IP giả, Host, Origin, User-Agent không gây lỗi hay phản chiếu', async () => {
    const hostile = [
      { Cookie: "gc_session=' OR 1=1 --" },
      { Cookie: 'gc_session[$ne]=1' },
      { Cookie: 'gc_admin=%00%ff' },
      { Cookie: '__proto__=1; constructor=2' },
      { 'X-Forwarded-For': "<script>window.__xss=1</script>' OR 1=1" },
      { Host: 'evil.example' },
      { 'X-Forwarded-Host': 'evil.example' },
      { Origin: 'https://evil.example' },
      { 'User-Agent': '<script>window.__xss=1</script>'.repeat(50) },
      { Referer: 'javascript:window.__xss=1' },
    ];
    for (const path of ['/api/auth/me', '/api/stats/school', '/api/admin/auth/session', '/api/checkin/history', '/api/auth/providers']) {
      for (const headers of hostile) {
        const res = await realFetch(ctx.base + path, { headers });
        assert.ok(res.status < 500, `${path} ${JSON.stringify(headers)} → ${res.status}`);
        const text = await res.text();
        assert.doesNotMatch(text, /window\.__xss|evil\.example/);
        assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://evil.example');
      }
    }
  });
});

describe('sau khi quét: dữ liệu không bị phá, không có quyền trái phép', () => {
  test('DB không nhận object thay cho chuỗi; không có admin mới; không có khóa toán tử', async () => {
    const users = await User.find({}).lean();
    for (const user of users) {
      for (const field of ['email', 'name', 'studentId', 'role', 'status']) {
        if (user[field] !== undefined) assert.equal(typeof user[field], 'string', `${field} của ${user._id}`);
      }
    }
    assert.equal(await User.countDocuments({ role: 'admin' }), 1);
    assert.equal(({}).role, undefined, 'không ô nhiễm prototype');
    assert.equal(await AdminSession.countDocuments({ userId: { $ne: admin.user._id } }), 0);
  });

  test('sinh viên không gọi được API quản trị nào, kể cả khi thử vai trò trong thân yêu cầu', async () => {
    for (const [method, route] of listRoutes().filter(([, r]) => r.startsWith('/api/admin') && !r.startsWith('/api/admin/auth'))) {
      const res = await student.c.request(method, route.replace(/:[A-Za-z]+/g, student.id), method === 'GET' ? {} : { json: { role: 'admin', isAdmin: true } });
      assert.equal(res.status, 401, `${method} ${route}`);
    }
  });
});

describe('mã hóa tống tiền: bề mặt phá hoại dữ liệu qua API', () => {
  test('chỉ có đúng các route DELETE đã biết: không route nào xóa tài khoản, check-in hay nhật ký', () => {
    const deletes = listRoutes().filter(([method]) => method === 'DELETE').map(([, route]) => route).sort();
    assert.deepEqual(deletes, ['/api/auth/passkeys/:id', '/api/auth/providers/:provider', '/api/auth/signup/pending', '/api/avatars/me']);
  });

  test('tệp tải lên không được phục vụ, không có đường dẫn vượt thư mục', async () => {
    for (const path of ['/uploads/a.png', '/api/uploads/a.png', '/server/.env', '/.env', '/api/avatars/..%2f..%2f.env', '/api/avatars/%2e%2e%2f%2e%2e%2fpackage.json']) {
      const res = await realFetch(ctx.base + path, { headers: { 'X-Requested-With': 'GreenCanteen' } });
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(await res.text(), /MONGODB_URI|"dependencies"/, path);
    }
  });
});

describe('đánh cắp dữ liệu cá nhân qua API', () => {
  test('khách: không phản hồi đọc nào chứa email hay mã sinh viên của sinh viên', async () => {
    await CheckIn.collection.insertOne({ userId: new User({ _id: other.id })._id, studentId: other.studentId, valid: true, pointsEarned: 10, createdAt: new Date() });
    const anonymous = createClient(ctx.base);
    for (const [method, route] of listRoutes().filter(([m, r]) => m === 'GET' && !/\/(start|callback)$/.test(r))) {
      const res = await anonymous.request(method, route.replace(/:[A-Za-z]+/g, other.studentId));
      const text = JSON.stringify(res.data ?? '');
      assert.ok(!text.includes(other.email), `${route} lộ email`);
      assert.ok(!text.toUpperCase().includes(other.studentId.toUpperCase()), `${route} lộ mã sinh viên`);
    }
  });

  test('admin: route đọc chỉ trả dữ liệu đã che, kể cả khi tìm đúng email; muốn xem đầy đủ phải qua bỏ che có xác thực lại và nhật ký', async () => {
    const read = (path) => admin.client.get(path).then((res) => JSON.stringify(res.data ?? ''));
    const paths = listRoutes()
      .filter(([method, route]) => method === 'GET' && route.startsWith('/api/admin') && !route.startsWith('/api/admin/auth'))
      .map(([, route]) => route.replace(/\/users\/:id/, `/users/${other.id}`).replace(/:[A-Za-z]+/g, 'a'.repeat(24)));
    for (const path of [...paths, `/api/admin/users?q=${encodeURIComponent(other.email)}`, `/api/admin/users?q=${encodeURIComponent(other.studentId)}`]) {
      const text = await read(path);
      assert.ok(!text.includes(other.email), `${path} lộ email`);
      assert.ok(!text.toUpperCase().includes(other.studentId.toUpperCase()), `${path} lộ mã sinh viên`);
    }
    assert.match(await read(`/api/admin/users?q=${encodeURIComponent(other.email)}`), /Người Khác Bí Mật/, 'tìm đúng email vẫn thấy tài khoản, chỉ là đã che');
  });

  test('sinh viên: mọi route đọc không lộ email, mã SV, lịch sử của người khác dù truyền đúng định danh của họ', async () => {
    for (const [method, route] of listRoutes().filter(([m, r]) => m === 'GET' && !/\/(start|callback)$/.test(r) && !r.startsWith('/api/admin'))) {
      for (const identifier of [other.studentId, other.id, other.email]) {
        const res = await student.c.request(method, route.replace(/:[A-Za-z]+/g, encodeURIComponent(identifier)));
        const text = JSON.stringify(res.data ?? '');
        assert.ok(!text.includes(other.email), `${route} lộ email`);
        assert.ok(!text.toUpperCase().includes(other.studentId.toUpperCase()), `${route} lộ mã sinh viên`);
      }
    }
  });
});
