import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Story } from '../models/Story.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(__dirname, '../data/stories.json');

// Chỉ câu chuyện có nguồn mở được mới được hiển thị
const SOURCED = { 'source.url': { $regex: /^https:\/\// } };
// Bản ghi có từ trước khi có trường status (chưa qua syncStories) được coi là đã xuất bản; nháp và bài đã gỡ thì không
const PUBLISHED = { status: { $in: ['published', null] } };

export function loadSeedStories() {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
}

/**
 * Đồng bộ câu chuyện từ data/stories.json mỗi lần khởi động. Nội dung admin quản lý không bao giờ bị ghi đè hay xóa:
 * seed chỉ thêm câu chuyện còn thiếu và chỉ cập nhật bản ghi origin 'seed' chưa từng được admin sửa (adminEditedAt).
 * Mọi điều kiện nằm trong cùng lệnh ghi nên admin sửa đúng lúc server khởi động cũng không mất nội dung.
 * Dữ liệu cũ chưa có origin được phân loại một lần: bộ câu chuyện cũ không nguồn bị xóa, câu chuyện có nguồn được giữ.
 */
export async function syncStories() {
  const stories = loadSeedStories();
  const slugs = stories.map((s) => s.slug);
  for (const story of stories) {
    await new Story(story).validate(); // dữ liệu seed thiếu nguồn → dừng khởi động thay vì hiển thị câu chuyện không kiểm chứng
  }

  const legacy = { origin: { $exists: false } };
  const { deletedCount } = await Story.deleteMany({ ...legacy, slug: { $nin: slugs }, $nor: [SOURCED] });
  await Story.updateMany({ ...legacy, slug: { $in: slugs } }, { $set: { origin: 'seed', status: 'published' } });
  await Story.updateMany(legacy, { $set: { origin: 'external', status: 'published' } });

  let upserted = 0;
  let keptAdminManaged = 0;
  for (const story of stories) {
    try {
      await Story.updateOne(
        { slug: story.slug, origin: 'seed', adminEditedAt: null },
        { $set: story, $setOnInsert: { status: 'published', publishedAt: new Date() } },
        { upsert: true }
      );
      upserted += 1;
    } catch (err) {
      // Đã có câu chuyện cùng slug nhưng không khớp điều kiện trên, tức là admin đang quản lý: giữ nguyên
      if (Number(err?.code) !== 11000) throw err;
      keptAdminManaged += 1;
    }
  }
  return { upserted, keptAdminManaged, removedUnsourced: deletedCount };
}

export async function pickRandomStory() {
  const [story] = await Story.aggregate([{ $match: { ...SOURCED, ...PUBLISHED } }, { $sample: { size: 1 } }]);
  return story || null;
}

export function serializeStory(story) {
  if (!story) return null;
  const { source = {} } = story;
  return {
    slug: story.slug,
    title: story.title,
    species: story.species,
    icon: story.icon || '🌊',
    imageUrl: story.imageUrl || '',
    summary: story.summary,
    caveat: story.caveat || '',
    message: story.message,
    source: {
      title: source.title,
      authors: source.authors || [],
      journal: source.journal,
      year: source.year,
      volume: source.volume || '',
      issue: source.issue || '',
      pages: source.pages || '',
      doi: source.doi || '',
      url: source.url,
    },
  };
}
