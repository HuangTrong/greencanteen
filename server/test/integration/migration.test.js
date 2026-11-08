// Nâng cấp từ dữ liệu cũ: tài khoản không có role/status, câu chuyện không có origin/status
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../../src/models/User.js';
import { Story } from '../../src/models/Story.js';
import { SystemMarker } from '../../src/models/SystemMarker.js';
import { runMigrations } from '../../src/services/migrations.js';
import { loadSeedStories, pickRandomStory, syncStories } from '../../src/services/stories.js';
import { hashPassword } from '../../src/services/password.js';
import { createClient, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV, enrolledAdmin } from '../adminHelpers.js';

let ctx;

before(async () => {
  setEnv(ADMIN_ENV);
  ctx = await startTestServer();
});
after(() => ctx.stop());

async function insertLegacyUser(overrides = {}) {
  const suffix = uniqueSuffix();
  const { insertedId } = await User.collection.insertOne({
    studentId: `CU${suffix}`,
    name: 'Tài Khoản Cũ',
    email: `cu${suffix}@example.edu.vn`,
    ecoPoints: 40,
    totalCheckIns: 4,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  });
  return insertedId;
}

test('trước khi migrate: tài khoản cũ không có quyền admin, vẫn đăng nhập được, không bị coi là bị khóa', async () => {
  const email = `cu${uniqueSuffix()}@example.edu.vn`;
  const id = await insertLegacyUser({ email, passwordHash: await hashPassword('mat-khau-tai-khoan-cu'), passwordChangedAt: new Date() });
  const client = createClient(ctx.base);
  const res = await client.post('/api/auth/login', { json: { email, password: 'mat-khau-tai-khoan-cu' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.ecoPoints, 40);
  assert.equal((await client.get('/api/auth/me')).status, 200);
  assert.equal(await User.countDocuments({ _id: id, role: 'admin' }), 0);
  const adminLogin = await createClient(ctx.base).post('/api/admin/auth/login', { json: { email, password: 'mat-khau-tai-khoan-cu' } });
  assert.equal(adminLogin.status, 401);
});

test('migrate bổ sung role/status, giữ nguyên mọi dữ liệu, không ghi đè giá trị đã có, chạy lại không tác dụng', async () => {
  await SystemMarker.collection.deleteMany({});
  const legacy = await insertLegacyUser();
  const adminId = await insertLegacyUser({ role: 'admin', status: 'locked' });
  const applied = await runMigrations();
  // Từ 2026-11-07 còn migration 2026-11-gacha-keychain chạy cùng lượt: chỉ kiểm migration của test này
  assert.ok(applied.includes('2026-10-user-role-status'), JSON.stringify(applied));

  const doc = await User.collection.findOne({ _id: legacy });
  assert.equal(doc.role, 'user');
  assert.equal(doc.status, 'active');
  assert.equal(doc.ecoPoints, 40);
  assert.equal(doc.totalCheckIns, 4);
  const untouched = await User.collection.findOne({ _id: adminId });
  assert.deepEqual([untouched.role, untouched.status], ['admin', 'locked']);

  assert.deepEqual(await runMigrations(), [], 'lần sau không chạy lại');
  assert.equal(await SystemMarker.countDocuments({ _id: 'migration:2026-10-user-role-status' }), 1);
});

test('nhiều tiến trình migrate cùng lúc không lỗi', async () => {
  await SystemMarker.collection.deleteMany({});
  const results = await Promise.all([runMigrations(), runMigrations(), runMigrations()]);
  const applied = new Set(results.flat());
  assert.ok(applied.size >= 1);
  // Mỗi migration đúng một dấu mốc, dù nhiều tiến trình cùng chạy
  assert.equal(await SystemMarker.countDocuments(), applied.size);
});

test('tài khoản cũ hiển thị đúng trong khu quản trị khi chưa migrate', async () => {
  const id = await insertLegacyUser();
  await User.collection.updateOne({ _id: id }, { $unset: { role: 1, status: 1 } });
  const { client } = await enrolledAdmin(ctx.base);
  const detail = await client.get(`/api/admin/users/${id}`);
  assert.deepEqual([detail.data.role, detail.data.status], ['user', 'active']);
  const list = (await client.get('/api/admin/users?status=active&role=user&pageSize=100')).data.items;
  assert.ok(list.some((row) => row.id === String(id)), 'lọc "đang hoạt động" có cả bản ghi thiếu trường');
});

test('câu chuyện cũ không có origin/status: seed phân loại đúng và không làm mất câu chuyện có nguồn', async () => {
  await Story.collection.deleteMany({});
  const [seed] = loadSeedStories();
  const source = { title: 't', authors: ['a'], journal: 'j', year: 2020, url: 'https://doi.org/10.1/abc' };
  await Story.collection.insertMany([
    { ...seed, title: 'Bản seed cũ' },
    { slug: 'them-tay-co-nguon', title: 'Thêm tay', species: 'x', summary: 'x', message: 'x', source },
    { slug: 'cu-khong-nguon', title: 'Cũ', species: 'x', summary: 'x', message: 'x' },
  ]);

  // Trước khi seed chạy: bản ghi thiếu status vẫn được coi là đã xuất bản nếu có nguồn
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) seen.add((await pickRandomStory()).slug);
  assert.ok(seen.has('them-tay-co-nguon'));
  assert.ok(!seen.has('cu-khong-nguon'));

  const result = await syncStories();
  assert.equal(result.removedUnsourced, 1);
  const docs = Object.fromEntries((await Story.find().lean()).map((doc) => [doc.slug, doc]));
  assert.deepEqual([docs[seed.slug].origin, docs[seed.slug].status, docs[seed.slug].title], ['seed', 'published', seed.title]);
  assert.deepEqual([docs['them-tay-co-nguon'].origin, docs['them-tay-co-nguon'].status], ['external', 'published']);
  assert.equal(docs['cu-khong-nguon'], undefined);

  const again = await syncStories();
  assert.equal(again.removedUnsourced, 0);
  assert.equal(await Story.countDocuments({ slug: 'them-tay-co-nguon' }), 1);
});

test('seed thiếu nguồn vẫn làm dừng khởi động như trước: validate xuất bản không bị nới lỏng', async () => {
  const fields = { title: 'x', species: 'x', summary: 'x', message: 'x' };
  await assert.rejects(new Story({ ...fields, slug: 'thieu-nguon' }).validate(), /nguồn nghiên cứu/);
  const source = { title: 't', authors: ['a'], journal: 'j', year: 2020, url: 'https://a.vn' };
  await assert.rejects(new Story({ ...fields, slug: 'thieu-tac-gia', source: { ...source, authors: [] } }).validate(), /tác giả/);
  await assert.rejects(new Story({ ...fields, slug: 'http', source: { ...source, url: 'http://a.vn' } }).validate(), /https/);
  await new Story({ ...fields, slug: 'du', source }).validate();
});
