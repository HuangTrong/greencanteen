// Thiết lập website và nhật ký kiểm toán: chỉ nội dung công khai, nhật ký chỉ ghi thêm, không có bí mật trong log
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { AuditLog } from '../../src/models/AuditLog.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { SiteSetting } from '../../src/models/SiteSetting.js';
import { sanitizeAuditMeta, writeAudit } from '../../src/services/audit.js';
import { createClient, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV, ADMIN_PASSWORD, adminClient, assertNoSecrets, currentCode, enrolledAdmin, loginPassword } from '../adminHelpers.js';

let ctx;
let admin;

const SETTINGS = (overrides = {}) => ({
  headerTagline: 'Khẩu hiệu mới',
  heroTitle: 'Tiêu đề mới',
  seoDescription: 'Mô tả mới',
  announcementEnabled: false,
  announcementText: '',
  supportContact: 'Phòng Công tác sinh viên',
  ...overrides,
});
const save = async (patch) => {
  const { revision } = (await admin.client.get('/api/admin/site-settings')).data;
  return admin.client.put('/api/admin/site-settings', { json: { ...SETTINGS(patch), revision } });
};

before(async () => {
  setEnv(ADMIN_ENV);
  ctx = await startTestServer();
  admin = await enrolledAdmin(ctx.base);
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(ADMIN_ENV);
  await RateLimit.deleteMany({});
});

describe('thiết lập website', () => {
  test('chưa ai chỉnh: trang công khai nhận đúng nội dung mặc định hiện có', async () => {
    await SiteSetting.collection.deleteMany({});
    const res = await createClient(ctx.base).get('/api/site/settings');
    assert.equal(res.status, 200);
    assert.equal(res.data.headerTagline, 'Căn tin xanh — Ly cá nhân, Trái đất vui');
    assert.equal(res.data.heroTitle, 'Một ly nhựa ít hơn, một đại dương sạch hơn');
    assert.equal(res.data.announcementEnabled, false);
    assert.equal(res.data.analyticsEnabled, false);
    assert.match(res.headers.get('cache-control'), /public/);
  });

  test('admin sửa được, trang công khai thấy ngay; nhật ký liệt kê trường đã đổi', async () => {
    assert.equal((await save({ announcementEnabled: true, announcementText: 'Căn tin nghỉ thứ Bảy' })).status, 200);
    const publicData = (await createClient(ctx.base).get('/api/site/settings')).data;
    assert.equal(publicData.heroTitle, 'Tiêu đề mới');
    assert.equal(publicData.announcementText, 'Căn tin nghỉ thứ Bảy');
    assert.equal(publicData.announcementEnabled, true);
    const entry = await AuditLog.findOne({ action: 'site_settings.update' }).sort({ createdAt: -1 }).lean();
    assert.equal(entry.result, 'success');
    assert.ok(entry.meta.changed.includes('heroTitle'));
  });

  test('khóa ngoài danh sách bị từ chối: bí mật môi trường, kết nối DB, khóa OAuth không có đường vào', async () => {
    for (const key of ['MONGODB_URI', 'GOOGLE_CLIENT_SECRET', 'ADMIN_MFA_KEY', 'SMTP_PASS', 'adminUrl']) {
      const { revision } = (await admin.client.get('/api/admin/site-settings')).data;
      const res = await admin.client.put('/api/admin/site-settings', { json: { ...SETTINGS(), revision, [key]: 'gia-tri' } });
      assert.equal(res.status, 400, key);
      assert.ok(res.data.fields[key], key);
    }
    const stored = JSON.stringify(await SiteSetting.findById('public').lean());
    assert.ok(!stored.includes('gia-tri'));
  });

  test('API công khai và API quản trị chỉ trả đúng các khóa cho phép, không chứa giá trị biến môi trường', async () => {
    setEnv({ ...ADMIN_ENV, GOOGLE_CLIENT_SECRET: 'bi-mat-oauth', ANALYTICS_HASH_KEY: 'bi-mat-analytics' });
    const publicRes = await createClient(ctx.base).get('/api/site/settings');
    assert.deepEqual(
      Object.keys(publicRes.data).sort(),
      ['analyticsEnabled', 'announcementEnabled', 'announcementText', 'headerTagline', 'heroTitle', 'seoDescription', 'supportContact']
    );
    for (const res of [publicRes, await admin.client.get('/api/admin/site-settings')]) {
      assert.doesNotMatch(JSON.stringify(res.data), /bi-mat/);
    }
  });

  test('trường bắt buộc, độ dài, thông báo bật mà không có nội dung', async () => {
    assert.ok((await save({ heroTitle: '' })).data.fields.heroTitle);
    assert.ok((await save({ headerTagline: 'x'.repeat(121) })).data.fields.headerTagline);
    assert.ok((await save({ announcementEnabled: true, announcementText: '' })).data.fields.announcementText);
    assert.equal((await save({ seoDescription: { $ne: null } })).status, 400);
  });

  test('hai người sửa cùng lúc từ một bản: người sau nhận 409', async () => {
    const { revision } = (await admin.client.get('/api/admin/site-settings')).data;
    assert.equal((await admin.client.put('/api/admin/site-settings', { json: { ...SETTINGS(), revision } })).status, 200);
    const stale = await admin.client.put('/api/admin/site-settings', { json: { ...SETTINGS({ heroTitle: 'Bản cũ' }), revision } });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'version_conflict');
  });

  test('nội dung chứa HTML được lưu nguyên dạng dữ liệu (giao diện hiển thị dạng văn bản)', async () => {
    const payload = '<script>alert(1)</script>';
    assert.equal((await save({ heroTitle: payload })).data.heroTitle, payload);
  });
});

describe('nhật ký kiểm toán', () => {
  test('ghi ai, làm gì, trên đối tượng nào, khi nào, kết quả ra sao', async () => {
    const student = createClient(ctx.base);
    const res = await registerUser(student);
    await admin.client.patch(`/api/admin/users/${res.data.user.id}/status`, { json: { status: 'locked', reason: 'Kiểm tra nhật ký' } });
    const list = (await admin.client.get(`/api/admin/audit-logs?action=user.status_change&targetId=${res.data.user.id}`)).data;
    assert.equal(list.total, 1);
    const [entry] = list.items;
    assert.equal(entry.actorType, 'admin');
    assert.match(entry.actorLabel, /\*\*\*@/);
    assert.equal(entry.targetType, 'user');
    assert.equal(entry.targetId, res.data.user.id);
    assert.equal(entry.result, 'success');
    assert.ok(new Date(entry.at).getTime() > Date.now() - 60_000);
    assert.equal(entry.meta.status, 'locked');
    assert.equal(entry.meta.reason, 'Kiểm tra nhật ký');
    assert.equal(entry.ip, '127.0.0.1');
  });

  test('thất bại và bị từ chối cũng được ghi, kèm mã lý do', async () => {
    const before = await AuditLog.countDocuments({ action: 'story.create' });
    await admin.client.post('/api/admin/stories', { json: { slug: 'Sai Dinh Dang', title: 'x' } });
    const [entry] = (await admin.client.get('/api/admin/audit-logs?action=story.create&result=failure')).data.items;
    assert.equal(entry.reason, 'invalid_input');
    assert.equal(await AuditLog.countDocuments({ action: 'story.create' }), before + 1);
  });

  test('lọc theo kết quả, thao tác, khoảng ngày; phân trang; tham số sai bị bỏ qua', async () => {
    const list = await admin.client.get('/api/admin/audit-logs?pageSize=2');
    assert.equal(list.data.items.length, 2);
    assert.ok(list.data.total > 2);
    assert.ok(list.data.actions.includes('admin.login'));
    assert.equal((await admin.client.get('/api/admin/audit-logs?from=2000-01-01&to=2000-01-02')).data.total, 0);
    assert.equal((await admin.client.get('/api/admin/audit-logs?result=denied&pageSize=100')).data.items.filter((i) => i.result !== 'denied').length, 0);
    await save({ heroTitle: `Để lọc theo đối tượng ${uniqueSuffix()}` });
    const byTarget = (await admin.client.get('/api/admin/audit-logs?targetType=site_settings&pageSize=100')).data;
    assert.ok(byTarget.total > 0);
    assert.ok(byTarget.items.every((item) => item.targetType === 'site_settings'));
    assert.equal((await admin.client.get('/api/admin/audit-logs?action[$ne]=x&targetId[$gt]=')).status, 200);
  });

  test('API không có đường sửa hoặc xóa', async () => {
    const [entry] = (await admin.client.get('/api/admin/audit-logs?pageSize=1')).data.items;
    for (const [method, path] of [
      ['DELETE', `/api/admin/audit-logs/${entry.id}`],
      ['PUT', `/api/admin/audit-logs/${entry.id}`],
      ['PATCH', `/api/admin/audit-logs/${entry.id}`],
      ['DELETE', '/api/admin/audit-logs'],
      ['POST', '/api/admin/audit-logs'],
    ]) {
      const res = await admin.client.raw.request(method, path, { json: {}, headers: { 'X-CSRF-Token': admin.client.raw.csrf } });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });

  test('model từ chối mọi thao tác sửa / xóa, kể cả trong mã nội bộ', async () => {
    const doc = await AuditLog.findOne();
    const before = doc.toObject();
    const attempts = [
      () => AuditLog.updateOne({ _id: doc._id }, { $set: { result: 'denied' } }),
      () => AuditLog.updateMany({}, { $set: { result: 'denied' } }),
      () => AuditLog.findOneAndUpdate({ _id: doc._id }, { $set: { result: 'denied' } }),
      () => AuditLog.findOneAndDelete({ _id: doc._id }),
      () => AuditLog.findOneAndReplace({ _id: doc._id }, { action: 'gia' }),
      () => AuditLog.replaceOne({ _id: doc._id }, { action: 'gia' }),
      () => AuditLog.deleteOne({ _id: doc._id }),
      () => AuditLog.deleteMany({}),
      () => doc.deleteOne(),
      () => {
        doc.reason = 'da-sua';
        return doc.save();
      },
    ];
    for (const attempt of attempts) await assert.rejects(attempt, /chỉ được ghi thêm/);
    const after = await AuditLog.findById(doc._id).lean();
    assert.deepEqual(after.result, before.result);
    assert.equal(after.reason, before.reason);
  });

  test('lọc bí mật: khóa nhạy cảm bị ẩn ở mọi cấp, chuỗi dài bị cắt, ObjectId và Date đọc được', () => {
    const clean = sanitizeAuditMeta({
      password: 'x',
      newPassword: 'x',
      passwordHash: 'x',
      token: 'x',
      csrfToken: 'x',
      secret: 'x',
      clientSecret: 'x',
      enrollCode: 'x',
      recoveryCodes: ['x'],
      topUpCode: 'x',
      cookie: 'x',
      nested: { apiKey: 'x', deep: [{ authorization: 'x' }], status: 'locked' },
      reason: 'y'.repeat(400),
      at: new Date('2026-01-01T00:00:00Z'),
      count: 3,
      targetId: new mongoose.Types.ObjectId('0123456789abcdef01234567'),
      chain: { a: { b: { c: { password: 'x', d: 'quá sâu' } } } },
      big: 10n,
    });
    assert.ok(!JSON.stringify(clean).includes('"x"'));
    assert.equal(clean.nested.status, 'locked');
    assert.equal(clean.reason.length, 301);
    assert.equal(clean.at, '2026-01-01T00:00:00.000Z');
    assert.equal(clean.count, 3);
    assert.equal(clean.targetId, '0123456789abcdef01234567');
    assert.equal(clean.chain.a.b.c, '[lược bớt]');
    assert.equal(clean.big, '10');
  });

  test('toàn bộ nhật ký sau các luồng đăng nhập và quản trị không chứa bí mật', async () => {
    const { client, email, secret, recoveryCodes } = await enrolledAdmin(ctx.base);
    await client.post('/api/admin/auth/reauth', { json: { password: ADMIN_PASSWORD, code: currentCode(secret, 1) } });
    await loginPassword(adminClient(ctx.base), email, 'mat-khau-sai-dang-do');
    const logs = await AuditLog.find().lean();
    assertNoSecrets(logs);
    const text = JSON.stringify(logs);
    for (const value of [ADMIN_PASSWORD, 'mat-khau-sai-dang-do', secret, ...recoveryCodes, client.raw.csrf, client.jar.get('gc_admin')]) {
      assert.ok(!text.includes(value), 'giá trị bí mật nằm trong nhật ký');
    }
  });

  test('log máy chủ không chứa mật khẩu, mã MFA, token khi đăng nhập thất bại và khi lỗi', async () => {
    const lines = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(original)) {
      console[level] = (...args) => lines.push(args.map(String).join(' '));
    }
    try {
      const marker = `mat-khau-do-tim-${uniqueSuffix()}`;
      const fresh = await enrolledAdmin(ctx.base);
      await loginPassword(adminClient(ctx.base), fresh.email, marker);
      await fresh.client.post('/api/admin/auth/reauth', { json: { password: marker, code: '123456' } });
      assert.ok(!lines.join('\n').includes(marker));
      assert.ok(!lines.join('\n').includes(fresh.secret));
      assert.ok(!lines.join('\n').includes(ADMIN_PASSWORD));
    } finally {
      Object.assign(console, original);
    }
  });

  test('ghi nhật ký lỗi không làm hỏng thao tác, có dòng cảnh báo không kèm dữ liệu', async () => {
    const lines = [];
    const originalError = console.error;
    const originalCreate = AuditLog.create;
    console.error = (...args) => lines.push(args.join(' '));
    AuditLog.create = async () => {
      throw new Error('mất kết nối DB với user@example.edu.vn');
    };
    try {
      await writeAudit(null, { action: 'kiem.thu', actor: { type: 'cli', label: '' } });
    } finally {
      AuditLog.create = originalCreate;
      console.error = originalError;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[audit-write-failed\] kiem\.thu/);
    assert.ok(!lines[0].includes('user@example.edu.vn'));
  });
});

describe('không rò rỉ dữ liệu nhạy cảm', () => {
  test('mọi phản hồi đọc của API quản trị không có trường bí mật', async () => {
    for (const path of ['/api/admin/users?pageSize=100', '/api/admin/stories', '/api/admin/gacha/configs', '/api/admin/site-settings', '/api/admin/audit-logs?pageSize=100', '/api/admin/overview', '/api/admin/auth/session']) {
      const res = await admin.client.get(path);
      assert.equal(res.status, 200, path);
      assertNoSecrets(res.data);
    }
  });
});
