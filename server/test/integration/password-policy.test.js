// F-08: mật khẩu phổ biến bị từ chối nhất quán ở đăng ký, đặt lại, đổi mật khẩu và tạo admin qua dòng lệnh. Không gọi dịch vụ ngoài,
// không ghi mật khẩu vào log hay phản hồi. Đăng nhập KHÔNG áp dụng: tài khoản có mật khẩu yếu từ trước vẫn vào được để đổi mật khẩu.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../../src/models/AuditLog.js';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { User } from '../../src/models/User.js';
import { bootstrapFirstAdmin } from '../../src/services/adminBootstrap.js';
import { hashPassword } from '../../src/services/password.js';
import { hashToken } from '../../src/services/session.js';
import { COMMON_PASSWORD_MESSAGE, PERSONAL_PASSWORD_MESSAGE } from '../../src/services/passwordPolicy.js';
import { createClient, realFetch, registerUser, setEnv, startTestServer, submitRegistration, uniqueSuffix } from '../helpers.js';

const WEAK = ['12345678', 'password', '11111111', 'qwertyui', 'Password123!', '  PASSWORD  ', 'P@ssw0rd', 'ｐａｓｓｗｏｒｄ', 'mật khẩu'];
const MFA_KEY = 'a'.repeat(64);

let ctx;
let outboundCalls;
const client = () => createClient(ctx.base);

async function weakResetToken(email) {
  const user = await User.findOne({ email });
  const token = `${uniqueSuffix()}`.padEnd(43, 'R');
  await PasswordReset.create({ tokenHash: hashToken(token), userId: user._id, expiresAt: new Date(Date.now() + 60_000) });
  return token;
}

before(async () => {
  setEnv();
  ctx = await startTestServer();
  outboundCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    outboundCalls.push(String(url));
    throw new Error(`Chặn request ra ngoài trong test: ${url}`);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv({ ADMIN_MFA_KEY: MFA_KEY });
  await RateLimit.deleteMany({});
});

describe('áp dụng nhất quán', () => {
  test('đăng ký: từ chối, không gửi thư, thông báo chỉ cách chọn mật khẩu tốt hơn', async () => {
    for (const password of WEAK) {
      const res = await submitRegistration(client(), { password });
      assert.equal(res.status, 400, password);
      assert.equal(res.data.code, 'invalid_input');
      assert.equal(res.data.error, COMMON_PASSWORD_MESSAGE);
      assert.equal(res.mail, null, 'không gửi thư');
    }
  });

  test('đặt lại mật khẩu: từ chối, không tiêu token, mật khẩu cũ giữ nguyên; mật khẩu tốt thì đặt được', async () => {
    const { body } = await registerUser(client());
    const token = await weakResetToken(body.email);
    for (const password of WEAK) {
      const res = await client().post('/api/auth/password/reset', { json: { token, password } });
      assert.equal(res.status, 400, password);
      assert.equal(res.data.code, 'invalid_input');
    }
    assert.equal(await PasswordReset.countDocuments({ tokenHash: hashToken(token) }), 1, 'token còn nguyên');
    assert.equal((await client().post('/api/auth/login', { json: { email: body.email, password: body.password } })).status, 200);
    assert.equal((await client().post('/api/auth/password/reset', { json: { token, password: 'mat-khau-moi-123' } })).status, 200);
  });

  test('đổi mật khẩu: từ chối, không tính là nhập sai mật khẩu hiện tại, mật khẩu cũ giữ nguyên', async () => {
    const c = client();
    const { body } = await registerUser(c);
    for (const newPassword of WEAK) {
      const res = await c.post('/api/auth/password/change', { json: { currentPassword: body.password, newPassword } });
      assert.equal(res.status, 400, newPassword);
      assert.equal(res.data.code, 'invalid_input');
    }
    assert.equal((await client().post('/api/auth/login', { json: { email: body.email, password: body.password } })).status, 200);
    const ok = await c.post('/api/auth/password/change', { json: { currentPassword: body.password, newPassword: 'mat-khau-moi-123' } });
    assert.equal(ok.status, 200);
  });

  test('tạo admin mới qua dòng lệnh: từ chối mật khẩu phổ biến dù đủ 12 ký tự', async () => {
    await User.updateMany({ role: 'admin' }, { $set: { role: 'user' } });
    for (const password of ['123456789012', 'password1234', 'qwertyuiop12']) {
      await assert.rejects(
        bootstrapFirstAdmin({ email: `admin-${uniqueSuffix()}@example.edu.vn`, name: 'Quản Trị', password }),
        (err) => err.code === 'invalid_input' && err.message === COMMON_PASSWORD_MESSAGE,
        password
      );
    }
    assert.equal(await User.countDocuments({ role: 'admin' }), 0);
  });

  test('nâng quyền tài khoản có sẵn không nhận mật khẩu nên không có gì để kiểm; mật khẩu giữ nguyên', async () => {
    const student = await registerUser(client());
    const before = await User.findOne({ email: student.body.email }).select('+passwordHash').lean();
    await bootstrapFirstAdmin({ email: student.body.email });
    const after_ = await User.findOne({ email: student.body.email }).select('+passwordHash').lean();
    assert.equal(after_.passwordHash, before.passwordHash);
    assert.equal(after_.role, 'admin');
    await User.updateOne({ _id: after_._id }, { $set: { role: 'user' } });
  });
});

describe('không làm mất quyền truy cập', () => {
  test('tài khoản có sẵn mật khẩu yếu từ trước vẫn đăng nhập được để đổi mật khẩu', async () => {
    const email = `cu-${uniqueSuffix()}@example.edu.vn`;
    await User.create({ studentId: `OLD${uniqueSuffix()}`, name: 'Tài khoản trước F-08', email, passwordHash: await hashPassword('12345678'), passwordChangedAt: new Date() });
    const c = client();
    assert.equal((await c.post('/api/auth/login', { json: { email, password: '12345678' } })).status, 200);
    assert.equal((await c.post('/api/auth/password/change', { json: { currentPassword: '12345678', newPassword: 'mat-khau-moi-123' } })).status, 200);
  });

  test('mật khẩu đúng chuẩn: dấu tiếng Việt và cả biên độ dài vẫn đăng ký được', async () => {
    for (const password of ['Mật khẩu tiếng Việt của tôi', 'xK9#mPq2', 'xK9#mPq2'.repeat(16)]) {
      const res = await registerUser(client(), { password });
      assert.equal(res.status, 201, password);
      assert.equal((await client().post('/api/auth/login', { json: { email: res.body.email, password } })).status, 200);
    }
  });

  test('đăng nhập bằng dạng Unicode khác của mật khẩu đã đặt vẫn được (chuẩn hóa NFC giữ nguyên)', async () => {
    const password = 'Mật khẩu tiếng Việt của tôi';
    const { body } = await registerUser(client(), { password });
    const nfd = await client().post('/api/auth/login', { json: { email: body.email, password: password.normalize('NFD') } });
    assert.equal(nfd.status, 200);
  });
});

describe('không rò rỉ', () => {
  test('không gọi dịch vụ ngoài; mật khẩu không xuất hiện trong log, phản hồi, nhật ký', async () => {
    const password = 'Password123!';
    const lines = [];
    const originals = { log: console.log, error: console.error, warn: console.warn };
    for (const method of Object.keys(originals)) console[method] = (...args) => lines.push(args.join(' '));
    let res;
    try {
      res = await client().post('/api/auth/register', {
        json: { name: 'Thử Log', studentId: `L${uniqueSuffix()}`, email: `log-${uniqueSuffix()}@example.edu.vn`, password },
      });
    } finally {
      Object.assign(console, originals);
    }
    assert.ok(!lines.join('\n').includes(password));
    assert.ok(!JSON.stringify(res.data).includes(password));
    assert.equal(await AuditLog.countDocuments({ meta: { $regex: password } }).catch(() => 0), 0);
    assert.deepEqual(outboundCalls, []);
  });
});

describe('F-75: mật khẩu suy ra từ thông tin của chính tài khoản', () => {
  const owner = () => {
    const suffix = uniqueSuffix();
    return { name: 'Nguyễn Văn Bình', studentId: `SV${suffix}`, email: `binh.nguyen.${suffix}@example.edu.vn` };
  };
  const contextual = ({ studentId, email }) => [
    studentId,
    `${studentId}@2026`,
    `${studentId.toLowerCase()}-xanh`,
    email.split('@')[0],
    `${email.split('@')[0]}!`,
    email,
    'nguyenvanbinh',
    'Nguyen Van Binh 2005',
    'NguyễnVănBình@123',
  ];

  test('đăng ký: từ chối, không gửi thư, thông báo không nhắc lại mật khẩu', async () => {
    const account = owner();
    for (const password of contextual(account)) {
      const res = await submitRegistration(client(), { ...account, password });
      assert.equal(res.status, 400, password);
      assert.equal(res.data.code, 'invalid_input');
      assert.ok(!res.data.error.includes(password));
      assert.equal(res.mail, null);
    }
  });

  test('đổi mật khẩu: từ chối theo hồ sơ hiện tại và không tiêu lượt thử', async () => {
    const account = owner();
    const c = client();
    const { body } = await registerUser(c, account);
    for (const newPassword of contextual(account)) {
      const res = await c.post('/api/auth/password/change', { json: { currentPassword: body.password, newPassword } });
      assert.equal(res.status, 400, newPassword);
      assert.equal(res.data.code, 'invalid_input');
    }
    assert.equal((await c.post('/api/auth/password/change', { json: { currentPassword: body.password, newPassword: 'cum-tu-kho-doan-rat-dai-9' } })).status, 200);
  });

  test('đặt lại mật khẩu: từ chối theo hồ sơ của tài khoản, liên kết chưa bị tiêu nên đặt lại được ngay sau đó', async () => {
    const account = owner();
    const { body } = await registerUser(client(), account);
    const token = await weakResetToken(body.email);
    const res = await client().post('/api/auth/password/reset', { json: { token, password: account.studentId } });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'invalid_input');
    assert.equal((await client().post('/api/auth/password/reset', { json: { token, password: 'cum-tu-kho-doan-rat-dai-9' } })).status, 200);
  });

  test('tạo quản trị viên qua dòng lệnh: mật khẩu chứa email hay họ tên bị từ chối', async () => {
    await User.updateMany({ role: 'admin' }, { $set: { role: 'user' } });
    const email = `quantri.chinh.${uniqueSuffix()}@example.edu.vn`;
    for (const password of [`${email.split('@')[0]}-2026`, 'Trần Quản Trị Viên 2026']) {
      await assert.rejects(
        bootstrapFirstAdmin({ email, name: 'Trần Quản Trị Viên', password }),
        (err) => err.code === 'invalid_input' && err.message === PERSONAL_PASSWORD_MESSAGE,
        password
      );
    }
  });

  test('mã SV hay tên quá ngắn trùng ngẫu nhiên không chặn nhầm mật khẩu tốt', async () => {
    const res = await submitRegistration(client(), { name: 'An', studentId: 'A1', email: `an.${uniqueSuffix()}@example.edu.vn`, password: 'bananas-an-toan-sau-chin' });
    assert.equal(res.status, 202);
  });
});
