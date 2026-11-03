// Quản lý tài khoản: tìm kiếm, che dữ liệu, khóa/mở khóa, đổi mã sinh viên, đổi quyền, thao tác hàng loạt, đồng thời
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../../src/models/User.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { QrLogin } from '../../src/models/QrLogin.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { RewardedImage } from '../../src/models/RewardedImage.js';
import { Story } from '../../src/models/Story.js';
import { UserAvatar } from '../../src/models/UserAvatar.js';
import { spinGacha } from '../../src/services/rewards.js';
import { hashToken, randomToken } from '../../src/services/session.js';
import { syncStories } from '../../src/services/stories.js';
import { portrait } from '../fakes/portrait.js';
import { createClient, imageForm, realFetch, registerUser, setEnv, startTestServer, uniquePng, uniqueSuffix } from '../helpers.js';
import {
  ADMIN_ENV,
  ADMIN_PASSWORD,
  adminClient,
  assertNoSecrets,
  auditEntries,
  currentCode,
  enrolledAdmin,
  expireReauth,
  loginPassword,
} from '../adminHelpers.js';

let ctx;
let admin;

const SIMULATION = { ...ADMIN_ENV, VISION_SIMULATION: 'true' };
const newStudent = async (overrides) => {
  const client = createClient(ctx.base);
  const res = await registerUser(client, overrides);
  assert.equal(res.status, 201);
  return { client, id: res.data.user.id, ...res.body };
};

before(async () => {
  setEnv(SIMULATION);
  ctx = await startTestServer();
  await syncStories();
  admin = await enrolledAdmin(ctx.base);
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(SIMULATION);
  await RateLimit.deleteMany({});
});

describe('tìm kiếm và phân trang', () => {
  test('số trang rất lớn trả danh sách rỗng, không thành lỗi máy chủ', async () => {
    for (const page of ['99999999999999999999', '9'.repeat(400)]) {
      const res = await admin.client.get(`/api/admin/users?page=${page}&pageSize=100`);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual(res.data.items, []);
    }
  });

  test('không có API tạo tài khoản admin; request không tạo người dùng mới', async () => {
    const suffix = uniqueSuffix();
    const email = `khong-tao-${suffix}@example.edu.vn`;
    const before = await User.countDocuments();
    const res = await admin.client.post('/api/admin/users', {
      json: {
        name: 'Tài khoản không được tạo',
        studentId: `NO${suffix}`,
        email,
        password: 'mat-khau-chi-dung-trong-test',
        status: 'active',
      },
    });

    assert.equal(res.status, 404);
    assert.equal(res.data.code, 'not_found');
    assert.equal(await User.countDocuments(), before);
    assert.equal(await User.exists({ email }), null);
  });

  test('danh sách che email và mã SV, không có trường bí mật; có phân trang phía server', async () => {
    const student = await newStudent();
    const res = await admin.client.get('/api/admin/users?pageSize=1');
    assert.equal(res.status, 200);
    assert.equal(res.data.items.length, 1);
    assert.equal(res.data.pageSize, 1);
    assert.ok(res.data.total >= 2);
    assertNoSecrets(res.data);

    const found = (await admin.client.get(`/api/admin/users?q=${encodeURIComponent(student.email)}`)).data.items;
    assert.equal(found.length, 1);
    assert.notEqual(found[0].email, student.email);
    assert.notEqual(found[0].studentId, student.studentId);
    assert.match(found[0].email, /\*\*\*@example\.edu\.vn$/);
    assert.match(found[0].studentId, /\*\*\*/);
  });

  test('mã SV và email chỉ khớp nguyên giá trị (không phân biệt hoa thường): tìm tiền tố không dò được dữ liệu đang che', async () => {
    const student = await newStudent();
    const search = async (q) => (await admin.client.get(`/api/admin/users?q=${encodeURIComponent(q)}`)).data.items.map((u) => u.id);
    assert.deepEqual(await search(student.studentId.toLowerCase()), [student.id]);
    assert.deepEqual(await search(student.email.toUpperCase()), [student.id]);
    assert.deepEqual(await search(student.studentId.slice(0, 6)), []);
    assert.deepEqual(await search(student.email.slice(0, 6)), []);
  });

  test('tìm theo tên không phân biệt hoa thường; ký tự đặc biệt của regex là chữ thường', async () => {
    const marker = `Tên Dò ${uniqueSuffix()}`;
    const student = await newStudent({ name: marker });
    const items = (await admin.client.get(`/api/admin/users?q=${encodeURIComponent(marker.toLowerCase())}`)).data.items;
    assert.deepEqual(items.map((u) => u.id), [student.id]);
    for (const q of ['.*', '(', '[a-z]+', '\\']) {
      const res = await admin.client.get(`/api/admin/users?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
      assert.equal(res.data.items.length, 0, q);
    }
  });

  test('lọc theo trạng thái và vai trò; tham số dạng object bị bỏ qua, không đổi truy vấn', async () => {
    const locked = await newStudent();
    await User.updateOne({ _id: locked.id }, { $set: { status: 'locked' } });
    const onlyLocked = (await admin.client.get('/api/admin/users?status=locked&pageSize=100')).data.items;
    assert.ok(onlyLocked.every((u) => u.status === 'locked'));
    assert.ok(onlyLocked.some((u) => u.id === locked.id));
    const onlyAdmins = (await admin.client.get('/api/admin/users?role=admin&pageSize=100')).data.items;
    assert.ok(onlyAdmins.every((u) => u.role === 'admin'));
    const injected = await admin.client.get('/api/admin/users?q[$ne]=x&status[$ne]=locked');
    assert.equal(injected.status, 200);
  });

  test('tham số phân trang sai được đưa về giới hạn', async () => {
    for (const [query, page, pageSize] of [['page=-5&pageSize=0', 1, 20], ['page=abc&pageSize=99999', 1, 100], ['page=2&pageSize=3', 2, 3]]) {
      const res = await admin.client.get(`/api/admin/users?${query}`);
      assert.deepEqual([res.data.page, res.data.pageSize], [page, pageSize], query);
    }
  });

  test('chi tiết tài khoản: chỉ trường cần thiết, không lộ mã thưởng hay dữ liệu xác thực', async () => {
    const student = await newStudent();
    await User.updateOne({ _id: student.id }, { $set: { claimCodeHash: 'bi-mat', googleId: 'gid-bi-mat', pendingGachaSpins: 1 } });
    await student.client.post('/api/gacha/spin');
    const reward = await GachaReward.findOne({ userId: student.id }).lean();
    const res = await admin.client.get(`/api/admin/users/${student.id}`);
    assert.equal(res.status, 200);
    assertNoSecrets(res.data);
    assert.ok(!JSON.stringify(res.data).includes(reward.topUpCode), 'không lộ mã nạp');
    assert.ok(!JSON.stringify(res.data).includes('gid-bi-mat'));
    assert.equal(res.data.authMethods.google, true);
    assert.equal(res.data.counts.rewards, 1);
  });

  test('id sai định dạng hoặc không tồn tại → 404', async () => {
    assert.equal((await admin.client.get('/api/admin/users/abc')).status, 404);
    assert.equal((await admin.client.get('/api/admin/users/0123456789abcdef01234567')).status, 404);
  });
});

describe('bỏ che dữ liệu', () => {
  test('cần xác thực lại, trả đúng dữ liệu, ghi nhật ký không chứa giá trị đã bỏ che', async () => {
    const student = await newStudent();
    await expireReauth(admin.client);
    assert.equal((await admin.client.post(`/api/admin/users/${student.id}/reveal`)).data.code, 'reauth_required');
    admin = await enrolledAdmin(ctx.base);
    const res = await admin.client.post(`/api/admin/users/${student.id}/reveal`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { studentId: student.studentId, email: student.email });
    const [entry] = await auditEntries({ action: 'user.reveal_pii', targetId: student.id });
    assert.equal(entry.result, 'success');
    assert.ok(!JSON.stringify(entry).includes(student.email));
    assert.ok(!JSON.stringify(entry).includes(student.studentId));
  });

  test('F-74: phiên quản trị bị lạm dụng không bỏ che hàng loạt được: quá 30 lần mỗi giờ bị từ chối và ghi nhật ký', async () => {
    const student = await newStudent();
    await RateLimit.deleteMany({});
    for (let i = 0; i < 30; i += 1) {
      assert.equal((await admin.client.post(`/api/admin/users/${student.id}/reveal`)).status, 200, `lần ${i + 1}`);
    }
    const blocked = await admin.client.post(`/api/admin/users/${student.id}/reveal`);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, 'too_many_attempts');
    assert.ok(!JSON.stringify(blocked.data).includes(student.email));
    const [entry] = await auditEntries({ action: 'user.reveal_pii', targetId: student.id });
    assert.equal(entry.result, 'failure');
    assert.equal(entry.reason, 'too_many_attempts');
    const otherAdmin = await enrolledAdmin(ctx.base);
    assert.equal((await otherAdmin.client.post(`/api/admin/users/${student.id}/reveal`)).status, 200, 'mỗi quản trị viên có ngân sách riêng');
  });
});

describe('gỡ ảnh đại diện', () => {
  const remove = (id, reason = 'Ảnh vi phạm quy định') => admin.client.post(`/api/admin/users/${id}/avatar-remove`, { json: { reason } });
  const upload = async (client) => client.put('/api/avatars/me', { form: imageForm(await portrait(200)) });
  const imageStatus = async (url) => (await realFetch(ctx.base + url)).status;

  async function studentWithAvatar() {
    const student = await newStudent();
    const res = await upload(student.client);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return { ...student, avatarUrl: res.data.user.avatarUrl };
  }

  test('chi tiết tài khoản có ảnh hiện tại để admin xem; danh sách thì không; chưa có ảnh là null', async () => {
    const student = await studentWithAvatar();
    const detail = await admin.client.get(`/api/admin/users/${student.id}`);
    assert.equal(detail.data.avatarUrl, student.avatarUrl);
    assertNoSecrets(detail.data);
    const list = await admin.client.get(`/api/admin/users?q=${encodeURIComponent(student.studentId)}`);
    assert.ok(!('avatarUrl' in list.data.items[0]));
    const noPhoto = await newStudent();
    assert.equal((await admin.client.get(`/api/admin/users/${noPhoto.id}`)).data.avatarUrl, null);
  });

  test('gỡ: ảnh bị xóa hẳn, có nhật ký; tài khoản vẫn dùng bình thường và đặt được ảnh mới', async () => {
    const student = await studentWithAvatar();
    const res = await remove(student.id);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.avatarUrl, null);
    assert.equal(await imageStatus(student.avatarUrl), 404);
    assert.equal(await UserAvatar.countDocuments({ userId: student.id }), 0);
    assert.equal((await User.findById(student.id).lean()).avatarId, undefined);

    const [entry] = await auditEntries({ action: 'user.avatar_remove', targetId: student.id });
    assert.equal(entry.result, 'success');
    assert.equal(entry.meta.reason, 'Ảnh vi phạm quy định');
    assert.equal(entry.actorId.toString(), admin.user._id.toString());
    assert.ok(!JSON.stringify(entry).includes(student.email));
    assert.ok(!JSON.stringify(entry).includes(student.avatarUrl));

    const me = await student.client.get('/api/auth/me');
    assert.equal(me.status, 200, 'phiên của sinh viên không bị ảnh hưởng');
    assert.equal(me.data.user.avatarUrl, null);
    assert.equal((await User.findById(student.id).lean()).status, 'active');
    const again = await upload(student.client);
    assert.equal(again.status, 200);
    assert.equal(await imageStatus(again.data.user.avatarUrl), 200);
  });

  test('ảnh biến mất khỏi bảng xếp hạng ngay sau khi gỡ, tài khoản vẫn còn trên bảng', async () => {
    const student = await studentWithAvatar();
    assert.equal((await student.client.post('/api/checkin', { form: imageForm(uniquePng()) })).status, 200);
    const row = async () => (await createClient(ctx.base).get('/api/stats/leaderboard')).data.personal.find((item) => item.name === student.name);
    assert.equal((await row()).avatarUrl, student.avatarUrl);
    await remove(student.id);
    assert.equal((await row()).avatarUrl, null);
  });

  test('cần xác thực lại: chưa xác thực thì ảnh còn nguyên', async () => {
    const student = await studentWithAvatar();
    await expireReauth(admin.client);
    const res = await remove(student.id);
    assert.deepEqual([res.status, res.data.code], [403, 'reauth_required']);
    assert.equal(await imageStatus(student.avatarUrl), 200);
    admin = await enrolledAdmin(ctx.base);
  });

  test('lý do bắt buộc; chưa có ảnh 409; id sai hoặc không tồn tại 404; từ chối cũng có nhật ký', async () => {
    const student = await studentWithAvatar();
    const noReason = await remove(student.id, '');
    assert.deepEqual([noReason.status, noReason.data.code], [400, 'invalid_input']);
    assert.equal((await admin.client.post(`/api/admin/users/${student.id}/avatar-remove`, { json: {} })).status, 400);
    assert.equal(await imageStatus(student.avatarUrl), 200);

    const noPhoto = await newStudent();
    const nothing = await remove(noPhoto.id);
    assert.deepEqual([nothing.status, nothing.data.code], [409, 'no_change']);
    assert.equal((await auditEntries({ action: 'user.avatar_remove', targetId: noPhoto.id }))[0].result, 'denied');

    assert.equal((await remove('abc')).status, 404);
    assert.equal((await remove('0123456789abcdef01234567')).status, 404);
  });

  test('sinh viên vừa đổi ảnh đúng lúc admin gỡ: không còn ảnh mồ côi hay con trỏ hỏng', async () => {
    const student = await studentWithAvatar();
    await Promise.all([remove(student.id), upload(student.client)]);
    const { avatarUrl } = (await student.client.get('/api/auth/me')).data.user;
    if (avatarUrl) assert.equal(await imageStatus(avatarUrl), 200);
    assert.equal(await UserAvatar.countDocuments({ userId: student.id }), avatarUrl ? 1 : 0);
  });

  test('admin gỡ được ảnh của chính mình', async () => {
    const owner = await enrolledAdmin(ctx.base);
    const student = createClient(ctx.base);
    assert.equal((await student.post('/api/auth/login', { json: { email: owner.email, password: ADMIN_PASSWORD } })).status, 200);
    assert.equal((await upload(student)).status, 200);
    assert.equal((await owner.client.post(`/api/admin/users/${owner.user._id}/avatar-remove`, { json: { reason: 'Ảnh của chính tôi' } })).status, 200);
  });
});

describe('khóa và mở khóa', () => {
  const setStatus = (id, status, reason = 'Vi phạm quy định check-in') =>
    admin.client.patch(`/api/admin/users/${id}/status`, { json: { status, reason } });

  test('khóa thu hồi phiên ngay, chặn đăng nhập; sai mật khẩu không lộ trạng thái khóa; mở khóa dùng lại được', async () => {
    const student = await newStudent();
    assert.equal((await student.client.get('/api/auth/me')).status, 200);
    const locked = await setStatus(student.id, 'locked');
    assert.equal(locked.status, 200);
    assert.equal(locked.data.status, 'locked');
    assert.equal(locked.data.lockReason, 'Vi phạm quy định check-in');

    assert.equal((await student.client.get('/api/auth/me')).status, 401);
    const login = await createClient(ctx.base).post('/api/auth/login', { json: { email: student.email, password: student.password } });
    assert.equal(login.status, 403);
    assert.equal(login.data.code, 'account_locked');
    const wrong = await createClient(ctx.base).post('/api/auth/login', { json: { email: student.email, password: 'sai-mat-khau-123' } });
    assert.equal(wrong.status, 401, 'sai mật khẩu không lộ tài khoản đang bị khóa');

    assert.equal((await setStatus(student.id, 'active')).data.status, 'active');
    const again = await createClient(ctx.base).post('/api/auth/login', { json: { email: student.email, password: student.password } });
    assert.equal(again.status, 200);
  });

  test('phiên bị cấp nhầm cho tài khoản đã khóa cũng không dùng được (phòng thủ ở getSessionUser)', async () => {
    const student = await newStudent();
    await User.updateOne({ _id: student.id }, { $set: { status: 'locked' } });
    assert.equal((await student.client.get('/api/auth/me')).status, 401);
    assert.equal((await student.client.post('/api/gacha/spin')).status, 401);
    assert.equal((await student.client.post('/api/checkin', { form: imageForm(uniquePng()) })).status, 401);
  });

  test('QR đã được duyệt nhưng tài khoản vừa bị khóa: không cấp phiên', async () => {
    const student = await newStudent();
    const device = createClient(ctx.base);
    const { challengeId, pollToken, matchCode } = (await device.post('/api/auth/qr/start')).data;
    assert.equal((await student.client.post(`/api/auth/qr/challenge/${challengeId}/approve`, { json: { matchCode } })).status, 200);
    await setStatus(student.id, 'locked');
    assert.deepEqual((await device.post('/api/auth/qr/poll', { json: { pollToken } })).data, { status: 'expired' });
    assert.ok(!device.jar.has('gc_session'));
    await QrLogin.deleteMany({});
  });

  test('tài khoản bị khóa rời bảng xếp hạng công khai, dữ liệu vẫn còn', async () => {
    const student = await newStudent({ name: `Xếp Hạng ${uniqueSuffix()}` });
    assert.equal((await student.client.post('/api/checkin', { form: imageForm(uniquePng()) })).status, 200);
    const names = async () => (await createClient(ctx.base).get('/api/stats/leaderboard')).data.personal.map((row) => row.name);
    assert.ok((await names()).includes(student.name));
    await setStatus(student.id, 'locked');
    assert.ok(!(await names()).includes(student.name));
    assert.equal(await CheckIn.countDocuments({ userId: student.id, valid: true }), 1);
    await setStatus(student.id, 'active');
  });

  test('bị khóa giữa lúc đang quay Gacha: lệnh trừ lượt nguyên tử từ chối, không phát thưởng', async () => {
    const student = await newStudent();
    await User.updateOne({ _id: student.id }, { $set: { pendingGachaSpins: 1 } });
    const user = await User.findById(student.id);
    await User.updateOne({ _id: student.id }, { $set: { status: 'locked' } });
    assert.equal(await spinGacha(user), null);
    assert.equal(await GachaReward.countDocuments({ userId: student.id }), 0);
  });

  test('bị khóa đúng lúc đang check-in: không cộng thưởng, ảnh được trả chỗ, báo tài khoản bị khóa', async (t) => {
    const student = await newStudent();
    // Bước chọn câu chuyện chạy ngay trước khi cộng thưởng: khóa tại đây tái hiện đúng cửa sổ đua
    t.mock.method(Story, 'aggregate', async () => {
      await User.updateOne({ _id: student.id }, { $set: { status: 'locked' } });
      return [];
    });
    const res = await student.client.post('/api/checkin', { form: imageForm(uniquePng()) });
    assert.deepEqual([res.status, res.data.code], [403, 'account_locked']);
    const user = await User.findById(student.id).lean();
    assert.deepEqual([user.totalCheckIns, user.ecoPoints, user.pendingGachaSpins], [0, 0, 0]);
    assert.equal(await RewardedImage.countDocuments({ userId: student.id }), 0);
  });

  test('tài khoản bị khóa đặt lại mật khẩu: không được cấp phiên, vẫn không đăng nhập được', async () => {
    const student = await newStudent();
    await setStatus(student.id, 'locked');
    const token = randomToken();
    await PasswordReset.create({ userId: student.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) });
    const browser = createClient(ctx.base);
    const password = 'mat-khau-moi-sau-khi-khoa-1';
    const res = await browser.post('/api/auth/password/reset', { json: { token, password } });
    assert.deepEqual([res.status, res.data.code], [403, 'account_locked']);
    assert.ok(!browser.jar.has('gc_session'));
    assert.equal((await browser.post('/api/auth/login', { json: { email: student.email, password } })).data.code, 'account_locked');
    await setStatus(student.id, 'active');
  });

  test('không tự khóa mình; lý do bắt buộc; trạng thái lạ và không đổi bị từ chối; tất cả được ghi nhật ký', async () => {
    const self = await setStatus(admin.user._id, 'locked');
    assert.equal(self.status, 409);
    assert.equal(self.data.code, 'self_action_forbidden');
    const student = await newStudent();
    assert.equal((await setStatus(student.id, 'locked', '')).status, 400);
    assert.equal((await setStatus(student.id, 'xoa')).status, 400);
    assert.equal((await setStatus(student.id, 'active')).data.code, 'no_change');
    const denied = await auditEntries({ action: 'user.status_change', result: 'denied', reason: 'self_action_forbidden' });
    assert.ok(denied.length >= 1);
    assert.ok((await auditEntries({ action: 'user.status_change', result: 'failure', targetId: student.id })).length >= 2);
  });

  test('hàng loạt: giới hạn số lượng, kết quả riêng từng tài khoản, không khóa chính mình', async () => {
    const students = [await newStudent(), await newStudent()];
    const ids = [...students.map((s) => s.id), admin.user._id.toString()];
    const res = await admin.client.post('/api/admin/users/bulk-status', { json: { ids, status: 'locked', reason: 'Kiểm tra hàng loạt' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.results.map((r) => r.ok), [true, true, false]);
    assert.equal(res.data.results[2].code, 'self_action_forbidden');
    assert.equal(await User.countDocuments({ _id: { $in: students.map((s) => s.id) }, status: 'locked' }), 2);

    const tooMany = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(24, '0'));
    assert.equal((await admin.client.post('/api/admin/users/bulk-status', { json: { ids: tooMany, status: 'locked', reason: 'Quá nhiều' } })).status, 400);
    assert.equal((await admin.client.post('/api/admin/users/bulk-status', { json: { ids: [{ $ne: null }], status: 'locked', reason: 'Kiểu sai' } })).status, 400);
  });
});

describe('đổi mã sinh viên', () => {
  const change = (id, studentId, reason = 'Sinh viên nộp thẻ xác minh') =>
    admin.client.patch(`/api/admin/users/${id}/student-id`, { json: { studentId, reason } });

  test('đổi cả tài khoản và bản sao trong lịch sử; route cũ theo mã SV đi theo mã mới; nhật ký chỉ có giá trị đã che', async () => {
    const student = await newStudent();
    await student.client.post('/api/checkin', { form: imageForm(uniquePng()) });
    await student.client.post('/api/gacha/spin');
    const next = `MOI${uniqueSuffix()}`;
    const res = await change(student.id, next);
    assert.equal(res.status, 200);
    assert.equal((await User.findById(student.id).lean()).studentId, next);
    assert.equal(await CheckIn.countDocuments({ userId: student.id, studentId: student.studentId }), 0);
    assert.equal(await CheckIn.countDocuments({ userId: student.id, studentId: next }), 1);
    assert.equal(await GachaReward.countDocuments({ userId: student.id, studentId: next }), 1);
    assert.equal((await student.client.get(`/api/checkin/history/${next}`)).status, 200);
    assert.equal((await student.client.get(`/api/checkin/history/${student.studentId}`)).status, 403);

    const [entry] = await auditEntries({ action: 'user.student_id_change', targetId: student.id });
    assert.ok(!JSON.stringify(entry).includes(next));
    assert.ok(!JSON.stringify(entry).includes(student.studentId));
    assert.equal(entry.meta.reason, 'Sinh viên nộp thẻ xác minh');
  });

  test('trùng mã (kể cả khác hoa thường) → 409; đổi hoa thường của chính mình được; không đổi → 409', async () => {
    const [a, b] = [await newStudent(), await newStudent()];
    const dup = await change(a.id, b.studentId.toLowerCase());
    assert.equal(dup.status, 409);
    assert.equal(dup.data.code, 'student_id_taken');
    assert.equal((await change(a.id, a.studentId)).data.code, 'no_change');
    assert.equal((await change(a.id, a.studentId.toLowerCase())).status, 200);
  });

  test('dữ liệu sai bị từ chối: rỗng, quá dài, sai kiểu, thiếu lý do', async () => {
    const student = await newStudent();
    for (const value of ['', 'x'.repeat(41), { $ne: null }, null]) {
      assert.equal((await change(student.id, value)).status, 400, JSON.stringify(value));
    }
    assert.equal((await change(student.id, 'HOPLE1', 'x')).status, 400);
  });

  test('hai yêu cầu đồng thời giành một mã: chỉ một tài khoản được', async () => {
    const [a, b] = [await newStudent(), await newStudent()];
    const target = `TRANH${uniqueSuffix()}`;
    const results = await Promise.all([change(a.id, target), change(b.id, target)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await User.countDocuments({ studentId: target }), 1);
  });
});

describe('đổi quyền', () => {
  const setRole = (id, role, client = admin.client) =>
    client.patch(`/api/admin/users/${id}/role`, { json: { role, reason: 'Phân công quản trị' } });

  test('cấp quyền trả mã đăng ký một lần; người được cấp đăng nhập đủ các bước; thu hồi xóa MFA và phiên', async () => {
    const student = await newStudent();
    const granted = await setRole(student.id, 'admin');
    assert.equal(granted.status, 200);
    assert.ok(granted.data.enrollCode);
    const [entry] = await auditEntries({ action: 'user.role_change', targetId: student.id });
    assert.ok(!JSON.stringify(entry).includes(granted.data.enrollCode), 'mã đăng ký không nằm trong nhật ký');

    const fresh = adminClient(ctx.base);
    await loginPassword(fresh, student.email, student.password);
    const { secret } = (await fresh.post('/api/admin/auth/mfa/setup', { json: { enrollCode: granted.data.enrollCode } })).data;
    const verified = await fresh.post('/api/admin/auth/mfa/verify', { json: { code: currentCode(secret) } });
    assert.equal(verified.status, 200);
    fresh.setCsrf(verified.data.csrfToken);
    assert.equal((await fresh.get('/api/admin/users')).status, 200);

    assert.equal((await setRole(student.id, 'user')).status, 200);
    assert.equal((await fresh.get('/api/admin/users')).status, 401);
    assert.equal((await loginPassword(adminClient(ctx.base), student.email, student.password)).status, 401);
  });

  test('tài khoản không có mật khẩu hoặc đang khóa không được cấp quyền; không tự đổi quyền mình', async () => {
    const oauth = await User.create({ name: 'Chỉ Google', studentId: `G${uniqueSuffix()}`, email: `g${uniqueSuffix()}@example.edu.vn`, googleId: `gid${uniqueSuffix()}` });
    assert.equal((await setRole(oauth._id, 'admin')).data.code, 'password_required');
    const locked = await newStudent();
    await User.updateOne({ _id: locked.id }, { $set: { status: 'locked' } });
    assert.equal((await setRole(locked.id, 'admin')).data.code, 'account_locked');
    assert.equal((await setRole(admin.user._id, 'user')).data.code, 'self_action_forbidden');
    assert.equal((await setRole(locked.id, 'superadmin')).status, 400);
    assert.equal((await setRole((await newStudent()).id, 'user')).data.code, 'no_change');
  });

  test('hai admin thu hồi quyền của nhau cùng lúc: hệ thống không bao giờ mất admin cuối cùng', async () => {
    await User.updateMany({ role: 'admin' }, { $set: { role: 'user' } });
    const [a, b] = [await enrolledAdmin(ctx.base), await enrolledAdmin(ctx.base)];
    await Promise.all([setRole(b.user._id, 'user', a.client), setRole(a.user._id, 'user', b.client)]);
    assert.ok((await User.countDocuments({ role: 'admin', status: { $ne: 'locked' } })) >= 1);
    admin = await enrolledAdmin(ctx.base);
  });

  test('admin khóa nhau đồng thời: vẫn còn ít nhất một admin hoạt động', async () => {
    await User.updateMany({ role: 'admin' }, { $set: { role: 'user' } });
    const [a, b] = [await enrolledAdmin(ctx.base), await enrolledAdmin(ctx.base)];
    const lock = (client, id) => client.patch(`/api/admin/users/${id}/status`, { json: { status: 'locked', reason: 'Khóa đồng thời' } });
    await Promise.all([lock(a.client, b.user._id), lock(b.client, a.user._id)]);
    assert.ok((await User.countDocuments({ role: 'admin', status: { $ne: 'locked' } })) >= 1);
    await User.updateMany({ role: 'admin' }, { $set: { status: 'active' } });
    admin = await enrolledAdmin(ctx.base);
  });

  test('đặt lại MFA của admin khác: phiên bị thu hồi, có mã mới; không áp dụng cho chính mình hoặc end-user', async () => {
    const other = await enrolledAdmin(ctx.base);
    const res = await admin.client.post(`/api/admin/users/${other.user._id}/mfa-reset`, { json: { reason: 'Mất điện thoại' } });
    assert.equal(res.status, 200);
    assert.ok(res.data.enrollCode);
    assert.equal((await other.client.get('/api/admin/users')).status, 401);
    const relogin = adminClient(ctx.base);
    assert.equal((await loginPassword(relogin, other.email, ADMIN_PASSWORD)).data.mfaEnrolled, false);

    assert.equal((await admin.client.post(`/api/admin/users/${admin.user._id}/mfa-reset`, { json: { reason: 'Tự đặt lại' } })).data.code, 'self_action_forbidden');
    const student = await newStudent();
    assert.equal((await admin.client.post(`/api/admin/users/${student.id}/mfa-reset`, { json: { reason: 'Không phải admin' } })).data.code, 'not_admin');
  });
});
