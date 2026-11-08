import net from 'net';
import { Story } from '../models/Story.js';
import { AdminError, invalidInput, notFound, versionConflict } from './adminErrors.js';
import { escapeRegex, parsePaging } from './adminQuery.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOI = /^10\.\d{4,9}\/\S+$/;
const TEXT_LIMITS = { title: 160, species: 200, summary: 2000, caveat: 1000, message: 500 };
const SOURCE_TEXT_LIMITS = { title: 300, journal: 200, volume: 20, issue: 20, pages: 40 };
const MAX_URL = 500;
const MAX_AUTHORS = 30;
const EDITABLE = ['title', 'species', 'icon', 'imageUrl', 'summary', 'caveat', 'message'];

const asText = (value) => (typeof value === 'string' ? value.trim() : '');

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// Tên miền không phân giải được trên Internet (RFC 6761, 6762, 8375 và tên hay dùng trong mạng nội bộ)
const INTERNAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|invalid|test)$/i;

/**
 * SEC-04: ảnh câu chuyện do trình duyệt của mọi sinh viên tự tải, liên kết nguồn do họ bấm. Chỉ nhận tên miền công khai trên cổng
 * HTTPS mặc định: không địa chỉ IP (kể cả dạng số viết tắt mà trình phân tích URL quy về IP), không tên một nhãn hay tên mạng nội bộ,
 * không kèm tài khoản. Tên miền công khai trỏ vào IP nội bộ thì không kiểm được ở đây (máy chủ không phân giải DNS hộ trình duyệt).
 */
export function isPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || net.isIP(host)) return false;
  return host.includes('.') && !INTERNAL_NAME.test(host);
}

const PUBLIC_URL_MESSAGE = 'phải trỏ tới tên miền công khai trên cổng HTTPS mặc định (không địa chỉ IP, máy trong mạng nội bộ hay tài khoản trong URL).';

function normalizeSource(raw, fields) {
  const source = {
    title: asText(raw?.title),
    authors: Array.isArray(raw?.authors) ? raw.authors.map(asText).filter(Boolean) : [],
    journal: asText(raw?.journal),
    year: raw?.year === '' || raw?.year === null || raw?.year === undefined ? undefined : raw.year,
    volume: asText(raw?.volume),
    issue: asText(raw?.issue),
    pages: asText(raw?.pages),
    doi: asText(raw?.doi),
    url: asText(raw?.url),
  };
  for (const [key, max] of Object.entries(SOURCE_TEXT_LIMITS)) {
    if (source[key].length > max) fields[`source.${key}`] = `Tối đa ${max} ký tự.`;
  }
  if (source.authors.length > MAX_AUTHORS || source.authors.some((name) => name.length > 120)) {
    fields['source.authors'] = `Tối đa ${MAX_AUTHORS} tác giả, mỗi tên tối đa 120 ký tự.`;
  }
  if (source.year !== undefined && (!Number.isInteger(source.year) || source.year < 1900 || source.year > 2100)) {
    fields['source.year'] = 'Năm phải là số nguyên từ 1900 đến 2100.';
  }
  if (source.doi && !DOI.test(source.doi)) fields['source.doi'] = 'DOI không đúng định dạng (10.xxxx/...).';
  if (source.url && (source.url.length > MAX_URL || !isHttpsUrl(source.url))) fields['source.url'] = 'URL nguồn phải dùng https://.';
  else if (source.url && !isPublicHttpsUrl(source.url)) fields['source.url'] = `URL nguồn ${PUBLIC_URL_MESSAGE}`;
  return source;
}

/** Đọc tường minh từng trường: trạng thái, người tạo, dấu thời gian trong body không có tác dụng */
function normalizeInput(body) {
  const fields = {};
  const value = {};
  for (const key of EDITABLE) value[key] = asText(body?.[key]);
  if (!value.title) fields.title = 'Cần nhập tiêu đề.';
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    if (value[key].length > max) fields[key] = `Tối đa ${max} ký tự.`;
  }
  if (value.icon.length > 8) fields.icon = 'Biểu tượng tối đa 8 ký tự.';
  if (value.imageUrl && (value.imageUrl.length > MAX_URL || !isHttpsUrl(value.imageUrl))) fields.imageUrl = 'URL ảnh phải dùng https://.';
  else if (value.imageUrl && !isPublicHttpsUrl(value.imageUrl)) fields.imageUrl = `URL ảnh ${PUBLIC_URL_MESSAGE}`;
  value.source = normalizeSource(body?.source, fields);
  if (Object.keys(fields).length > 0) throw invalidInput(fields);
  return value;
}

export function serializeAdminStory(story) {
  return {
    id: story._id.toString(),
    revision: story.__v ?? 0,
    slug: story.slug,
    status: story.status || 'published',
    origin: story.origin || 'external',
    title: story.title,
    species: story.species || '',
    icon: story.icon || '',
    imageUrl: story.imageUrl || '',
    summary: story.summary || '',
    caveat: story.caveat || '',
    message: story.message || '',
    source: {
      title: story.source?.title || '',
      authors: story.source?.authors || [],
      journal: story.source?.journal || '',
      year: story.source?.year ?? null,
      volume: story.source?.volume || '',
      issue: story.source?.issue || '',
      pages: story.source?.pages || '',
      doi: story.source?.doi || '',
      url: story.source?.url || '',
    },
    publishedAt: story.publishedAt || null,
    adminEditedAt: story.adminEditedAt || null,
    createdByLabel: story.createdByLabel || '',
    updatedByLabel: story.updatedByLabel || '',
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
  };
}

export async function listStories(query) {
  const { page, pageSize, skip } = parsePaging(query);
  const filter = {};
  if (['draft', 'published', 'archived'].includes(query.status)) filter.status = query.status;
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '';
  if (q) filter.title = { $regex: escapeRegex(q), $options: 'i' };
  const [rows, total] = await Promise.all([
    Story.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
    Story.countDocuments(filter),
  ]);
  return { items: rows.map(serializeAdminStory), page, pageSize, total };
}

export async function loadStory(id) {
  const story = await Story.findById(id);
  if (!story) throw notFound('Không tìm thấy câu chuyện.');
  return story;
}

/** Ghi chồng bản đã được người khác sửa bị chặn: client gửi kèm revision của bản đang mở */
function assertRevision(story, revision) {
  if (revision !== story.__v) throw versionConflict();
}

function stampEdit(story, actor) {
  story.adminEditedAt = new Date();
  story.updatedByLabel = actor.label;
}

export async function createStory(actor, body) {
  const slug = asText(body?.slug);
  const value = normalizeInput(body);
  if (!SLUG.test(slug) || slug.length > 80) {
    throw invalidInput({ slug: 'Slug chỉ gồm chữ thường không dấu, số và dấu gạch ngang (tối đa 80 ký tự).' });
  }
  try {
    return await Story.create({
      ...value,
      slug,
      status: 'draft',
      origin: 'admin',
      adminEditedAt: new Date(),
      createdByLabel: actor.label,
      updatedByLabel: actor.label,
    });
  } catch (err) {
    if (Number(err?.code) === 11000) throw new AdminError(409, 'slug_taken', 'Slug này đã được dùng.', { fields: { slug: 'Slug này đã được dùng.' } });
    throw err;
  }
}

export async function updateStory(actor, id, body) {
  const story = await loadStory(id);
  assertRevision(story, body?.revision);
  story.set(normalizeInput(body));
  stampEdit(story, actor);
  await story.save();
  return story;
}

export async function publishStory(actor, id, revision) {
  const story = await loadStory(id);
  assertRevision(story, revision);
  story.status = 'published';
  story.publishedAt = new Date();
  stampEdit(story, actor);
  await story.save(); // kiểm tra đầy đủ trường bắt buộc và nguồn HTTPS ngay tại đây
  return story;
}

export async function unpublishStory(actor, id, revision) {
  const story = await loadStory(id);
  assertRevision(story, revision);
  if (story.status !== 'published') throw new AdminError(409, 'not_published', 'Câu chuyện chưa được xuất bản.');
  story.status = 'archived';
  stampEdit(story, actor);
  await story.save();
  return story;
}
