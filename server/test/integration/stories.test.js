import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Story } from '../../src/models/Story.js';
import { loadSeedStories, pickRandomStory, serializeStory, syncStories } from '../../src/services/stories.js';
import { setEnv, startTestServer } from '../helpers.js';

let ctx;
before(async () => {
  setEnv();
  ctx = await startTestServer();
});
after(() => ctx.stop());

test('mỗi câu chuyện seed có đủ thông tin nguồn kiểm chứng được', () => {
  const stories = loadSeedStories();
  assert.ok(stories.length >= 7);
  const slugs = new Set();
  for (const s of stories) {
    assert.ok(!slugs.has(s.slug), `slug trùng: ${s.slug}`);
    slugs.add(s.slug);
    for (const field of ['title', 'species', 'summary', 'message', 'caveat']) {
      assert.ok(s[field]?.trim(), `${s.slug}: thiếu ${field}`);
    }
    const src = s.source;
    assert.ok(src.title && src.journal, `${s.slug}: thiếu tên bài/tạp chí`);
    assert.ok(Array.isArray(src.authors) && src.authors.length > 0, `${s.slug}: thiếu tác giả`);
    assert.ok(Number.isInteger(src.year) && src.year > 1990, `${s.slug}: năm không hợp lệ`);
    assert.match(src.doi, /^10\.\d{4,9}\/\S+$/, `${s.slug}: DOI`);
    assert.equal(src.url, `https://doi.org/${src.doi}`);
  }
});

test('đồng bộ xóa câu chuyện cũ không có nguồn, giữ câu chuyện có nguồn do người khác thêm', async () => {
  await Story.collection.insertMany([
    { slug: 'hope-sea-turtle', title: 'Câu chuyện cũ', species: 'x', imageUrl: 'x', summary: 'x', message: 'x' },
    {
      slug: 'custom-sourced',
      title: 'Câu chuyện bổ sung',
      species: 'x',
      summary: 'x',
      message: 'x',
      source: { title: 't', authors: ['a'], journal: 'j', year: 2020, url: 'https://doi.org/10.1/abc' },
    },
  ]);
  const result = await syncStories();
  assert.equal(result.removedUnsourced, 1);
  assert.equal(await Story.countDocuments({ slug: 'hope-sea-turtle' }), 0);
  assert.equal(await Story.countDocuments({ slug: 'custom-sourced' }), 1);
  assert.equal(await Story.countDocuments(), loadSeedStories().length + 1);

  // chạy lại không tạo bản sao
  await syncStories();
  assert.equal(await Story.countDocuments(), loadSeedStories().length + 1);
});

test('câu chuyện trả về sau check-in luôn có nguồn', async () => {
  for (let i = 0; i < 20; i += 1) {
    const story = serializeStory(await pickRandomStory());
    assert.match(story.source.url, /^https:\/\//);
    assert.ok(story.source.authors.length > 0);
  }
});
