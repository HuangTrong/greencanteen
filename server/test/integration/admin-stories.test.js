// Quản lý câu chuyện: nháp, xuất bản, gỡ, kiểm tra nguồn HTTPS, xung đột phiên bản, seed không ghi đè nội dung admin
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Story } from '../../src/models/Story.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { loadSeedStories, pickRandomStory, syncStories } from '../../src/services/stories.js';
import { setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV, auditEntries, enrolledAdmin } from '../adminHelpers.js';

let ctx;
let admin;

const COMPLETE = () => ({
  slug: `chuyen-${uniqueSuffix()}`,
  title: 'Câu chuyện thử',
  species: 'Rùa biển',
  icon: '🐢',
  imageUrl: 'https://example.org/rua.jpg',
  summary: 'Tóm tắt nghiên cứu.',
  caveat: 'Kết quả ở cấp quần thể.',
  message: 'Mang bình của bạn.',
  source: {
    title: 'Tên bài báo',
    authors: ['Tác giả A', 'Tác giả B'],
    journal: 'Tạp chí',
    year: 2020,
    volume: '1',
    issue: '2',
    pages: '3-4',
    doi: '10.1000/xyz',
    url: 'https://doi.org/10.1000/xyz',
  },
});
const create = (body) => admin.client.post('/api/admin/stories', { json: body });

before(async () => {
  setEnv(ADMIN_ENV);
  ctx = await startTestServer();
  await syncStories();
  admin = await enrolledAdmin(ctx.base);
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(ADMIN_ENV);
  await RateLimit.deleteMany({});
});

describe('nháp và xuất bản', () => {
  test('nháp lưu được khi còn thiếu trường nhưng không hiển thị cho sinh viên', async () => {
    const res = await create({ slug: `nhap-${uniqueSuffix()}`, title: 'Chỉ có tiêu đề' });
    assert.equal(res.status, 201);
    assert.equal(res.data.status, 'draft');
    assert.equal(res.data.origin, 'admin');
    for (let i = 0; i < 30; i += 1) assert.notEqual((await pickRandomStory())?.slug, res.data.slug);
  });

  test('xuất bản bản nháp thiếu trường bị từ chối, liệt kê từng trường, trạng thái không đổi', async () => {
    const { data: draft } = await create({ slug: `thieu-${uniqueSuffix()}`, title: 'Thiếu nguồn', source: { title: 'x' } });
    const res = await admin.client.post(`/api/admin/stories/${draft.id}/publish`, { json: { revision: draft.revision } });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'invalid_input');
    for (const field of ['species', 'summary', 'message', 'source.journal', 'source.year', 'source.url', 'source.authors']) {
      assert.ok(res.data.fields[field], field);
    }
    assert.equal((await Story.findById(draft.id).lean()).status, 'draft');
    assert.equal((await auditEntries({ action: 'story.publish', targetId: draft.id }))[0].result, 'failure');
  });

  test('đủ trường → xuất bản được và xuất hiện sau check-in; gỡ → không còn xuất hiện, nội dung vẫn giữ', async () => {
    await Story.updateMany({}, { $set: { status: 'archived' } });
    const { data: draft } = await create(COMPLETE());
    const published = await admin.client.post(`/api/admin/stories/${draft.id}/publish`, { json: { revision: draft.revision } });
    assert.equal(published.status, 200);
    assert.equal(published.data.status, 'published');
    assert.ok(published.data.publishedAt);
    assert.equal((await pickRandomStory()).slug, draft.slug);

    const removed = await admin.client.post(`/api/admin/stories/${draft.id}/unpublish`, { json: { revision: published.data.revision } });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.status, 'archived');
    assert.equal(await pickRandomStory(), null);
    assert.equal(await Story.countDocuments({ _id: draft.id }), 1);

    const again = await admin.client.post(`/api/admin/stories/${draft.id}/publish`, { json: { revision: removed.data.revision } });
    assert.equal(again.status, 200);
    await Story.updateMany({}, { $set: { status: 'published' } });
  });

  test('gỡ câu chuyện chưa xuất bản → 409', async () => {
    const { data: draft } = await create({ slug: `chua-${uniqueSuffix()}`, title: 'Nháp' });
    assert.equal((await admin.client.post(`/api/admin/stories/${draft.id}/unpublish`, { json: { revision: draft.revision } })).data.code, 'not_published');
  });

  test('sửa bản đã xuất bản vẫn phải đủ trường bắt buộc', async () => {
    const { data: draft } = await create(COMPLETE());
    const { data: published } = await admin.client.post(`/api/admin/stories/${draft.id}/publish`, { json: { revision: draft.revision } });
    const res = await admin.client.put(`/api/admin/stories/${draft.id}`, { json: { ...COMPLETE(), summary: '', revision: published.revision } });
    assert.equal(res.status, 400);
    assert.ok(res.data.fields.summary);
  });
});

describe('kiểm tra dữ liệu', () => {
  test('nguồn và ảnh bắt buộc HTTPS, kể cả với bản nháp', async () => {
    for (const url of ['http://doi.org/10.1/x', 'javascript:alert(1)', 'data:text/html,x', 'doi.org/10.1/x', 'https://']) {
      const res = await create({ ...COMPLETE(), source: { ...COMPLETE().source, url } });
      assert.equal(res.status, 400, url);
      assert.ok(res.data.fields['source.url'], url);
    }
    assert.ok((await create({ ...COMPLETE(), imageUrl: 'http://example.org/a.jpg' })).data.fields.imageUrl);
  });

  test('slug sai định dạng hoặc trùng; slug không đổi được khi sửa', async () => {
    for (const slug of ['Có Dấu', 'a b', '-dau-gach', '', 'x'.repeat(81), { $ne: null }]) {
      assert.equal((await create({ ...COMPLETE(), slug })).status, 400, JSON.stringify(slug));
    }
    const body = COMPLETE();
    const { data } = await create(body);
    const dup = await create(body);
    assert.equal(dup.status, 409);
    assert.equal(dup.data.code, 'slug_taken');
    const edited = await admin.client.put(`/api/admin/stories/${data.id}`, { json: { ...body, slug: 'slug-moi', title: 'Đổi tiêu đề', revision: data.revision } });
    assert.equal(edited.data.slug, body.slug);
    assert.equal(edited.data.title, 'Đổi tiêu đề');
  });

  test('độ dài, năm, DOI, số tác giả sai bị từ chối', async () => {
    const { source } = COMPLETE();
    const cases = [
      [{ title: '' }, 'title'],
      [{ title: 'x'.repeat(161) }, 'title'],
      [{ summary: 'x'.repeat(2001) }, 'summary'],
      [{ icon: 'x'.repeat(9) }, 'icon'],
      [{ source: { ...source, journal: 'x'.repeat(201) } }, 'source.journal'],
      [{ source: { ...source, year: 1800 } }, 'source.year'],
      [{ source: { ...source, year: '2020' } }, 'source.year'],
      [{ source: { ...source, doi: 'khong-phai-doi' } }, 'source.doi'],
      [{ source: { ...source, authors: Array(31).fill('A') } }, 'source.authors'],
    ];
    for (const [patch, field] of cases) {
      const res = await create({ ...COMPLETE(), ...patch });
      assert.equal(res.status, 400, field);
      assert.ok(res.data.fields[field], field);
    }
  });

  test('id sai định dạng hoặc không tồn tại → 404', async () => {
    assert.equal((await admin.client.get('/api/admin/stories/khong-hop-le')).status, 404);
    assert.equal((await admin.client.get('/api/admin/stories/0123456789abcdef01234567')).status, 404);
  });

  test('trường hệ thống trong body không có tác dụng (status, origin, adminEditedAt)', async () => {
    const res = await create({ ...COMPLETE(), status: 'published', origin: 'seed', adminEditedAt: null, updatedByLabel: 'giả mạo' });
    assert.equal(res.data.status, 'draft');
    assert.equal(res.data.origin, 'admin');
    assert.ok(res.data.adminEditedAt);
    assert.notEqual(res.data.updatedByLabel, 'giả mạo');
  });

  test('nội dung chứa thẻ HTML được giữ nguyên dạng dữ liệu', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const res = await create({ ...COMPLETE(), title: payload });
    assert.equal(res.data.title, payload);
    assert.match(res.headers.get('content-type'), /^application\/json/);
  });
});

describe('sửa đồng thời', () => {
  test('bản đã mở cũ không ghi đè được bản mới hơn: 409, không mất nội dung', async () => {
    const { data: draft } = await create(COMPLETE());
    const body = { ...COMPLETE(), title: 'Bản của người thứ nhất', revision: draft.revision };
    assert.equal((await admin.client.put(`/api/admin/stories/${draft.id}`, { json: body })).status, 200);
    const stale = await admin.client.put(`/api/admin/stories/${draft.id}`, { json: { ...body, title: 'Bản cũ' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'version_conflict');
    assert.equal((await Story.findById(draft.id).lean()).title, 'Bản của người thứ nhất');
  });

  test('hai yêu cầu sửa cùng revision gửi đồng thời: một thành công, một 409', async () => {
    const { data: draft } = await create(COMPLETE());
    const save = (title) => admin.client.put(`/api/admin/stories/${draft.id}`, { json: { ...COMPLETE(), title, revision: draft.revision } });
    const results = await Promise.all([save('A'), save('B')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  });
});

describe('seed không đụng tới nội dung admin quản lý', () => {
  const [seed] = loadSeedStories();
  const seedDoc = () => Story.findOne({ slug: seed.slug });

  test('mọi câu chuyện seed đều qua được kiểm tra của khu quản trị: giới hạn độ dài không khóa dữ liệu có sẵn', async () => {
    const { items } = (await admin.client.get('/api/admin/stories?pageSize=100&status=published')).data;
    for (const { slug } of loadSeedStories()) {
      const story = items.find((item) => item.slug === slug);
      const res = await admin.client.put(`/api/admin/stories/${story.id}`, { json: { ...story, revision: story.revision } });
      assert.equal(res.status, 200, `${slug}: ${JSON.stringify(res.data)}`);
    }
    await Story.updateMany({}, { $unset: { adminEditedAt: 1 } });
  });

  const edit = async (patch) => {
    const doc = await seedDoc();
    const current = (await admin.client.get(`/api/admin/stories/${doc._id}`)).data;
    return admin.client.put(`/api/admin/stories/${doc._id}`, { json: { ...current, ...patch, revision: current.revision } });
  };

  test('sửa câu chuyện seed rồi khởi động lại: giữ nguyên bản đã sửa', async () => {
    assert.equal((await edit({ title: 'Tiêu đề admin đã sửa' })).status, 200);
    const result = await syncStories();
    assert.ok(result.keptAdminManaged >= 1);
    assert.equal((await seedDoc()).title, 'Tiêu đề admin đã sửa');
  });

  test('gỡ câu chuyện seed rồi khởi động lại: không tự xuất bản lại', async () => {
    const doc = await seedDoc();
    const res = await admin.client.post(`/api/admin/stories/${doc._id}/unpublish`, { json: { revision: doc.__v } });
    assert.equal(res.status, 200);
    await syncStories();
    assert.equal((await seedDoc()).status, 'archived');
  });

  test('nháp thiếu nguồn và bài đã gỡ của admin không bị xóa như "câu chuyện không nguồn"', async () => {
    const { data: draft } = await create({ slug: `khong-nguon-${uniqueSuffix()}`, title: 'Nháp chưa có nguồn' });
    const before = await Story.countDocuments();
    const result = await syncStories();
    assert.equal(result.removedUnsourced, 0);
    assert.equal(await Story.countDocuments(), before);
    assert.equal((await Story.findById(draft.id).lean()).title, 'Nháp chưa có nguồn');
  });

  test('câu chuyện seed chưa ai sửa vẫn nhận được bản cập nhật từ tệp seed', async () => {
    const [, other] = loadSeedStories();
    await Story.updateOne({ slug: other.slug }, { $set: { title: 'Nội dung seed cũ' } });
    await syncStories();
    assert.equal((await Story.findOne({ slug: other.slug }).lean()).title, other.title);
  });

  test('câu chuyện seed bị thiếu (chưa từng có) được thêm với trạng thái xuất bản', async () => {
    const [, , third] = loadSeedStories();
    await Story.deleteOne({ slug: third.slug });
    await syncStories();
    const doc = await Story.findOne({ slug: third.slug }).lean();
    assert.equal(doc.status, 'published');
    assert.equal(doc.origin, 'seed');
  });

  test('admin sửa đúng lúc seed đang chạy: nội dung admin không bị mất', async () => {
    const [, , , fourth] = loadSeedStories();
    const doc = await Story.findOne({ slug: fourth.slug });
    const current = (await admin.client.get(`/api/admin/stories/${doc._id}`)).data;
    await Promise.all([
      syncStories(),
      admin.client.put(`/api/admin/stories/${doc._id}`, { json: { ...current, title: 'Sửa trong lúc seed', revision: current.revision } }),
    ]);
    await syncStories();
    assert.equal((await Story.findOne({ slug: fourth.slug }).lean()).title, 'Sửa trong lúc seed');
  });
});

describe('danh sách', () => {
  test('lọc theo trạng thái, tìm theo tiêu đề, phân trang; regex trong từ khóa là chữ thường', async () => {
    const marker = `Dấu vết ${uniqueSuffix()}`;
    await create({ slug: `loc-${uniqueSuffix()}`, title: marker });
    const found = (await admin.client.get(`/api/admin/stories?status=draft&q=${encodeURIComponent(marker.toLowerCase())}`)).data;
    assert.equal(found.total, 1);
    assert.equal((await admin.client.get('/api/admin/stories?q=.*')).data.total, 0);
    const page = (await admin.client.get('/api/admin/stories?pageSize=2&page=1')).data;
    assert.equal(page.items.length, 2);
    assert.ok(page.total > 2);
  });
});
