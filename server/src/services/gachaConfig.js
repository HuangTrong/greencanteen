import { GachaConfig } from '../models/GachaConfig.js';
import { GachaMedia } from '../models/GachaMedia.js';
import { GachaStock } from '../models/GachaStock.js';
import { GACHA_PRIZE_TYPE, PROBABILITY_TOTAL_PPM, drawPrize, keychainStockKey } from './gacha.js';
import { mediaUrl } from './gachaMedia.js';
import { AdminError, invalidInput, notFound } from './adminErrors.js';

const PRIZE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const MAX_PRIZES = 50;
const MAX_NOTE = 500;
const MAX_DESCRIPTION = 300;
const MAX_CLAIM_INSTRUCTIONS = 500;
const MAX_QUANTITY = 1_000_000;

const isDuplicateKey = (err) => Number(err?.code) === 11000;
const inEffect = (now) => ({
  status: 'published',
  effectiveFrom: { $lte: now },
  $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
});

/** Giải mã nạp điện thoại của dữ liệu cũ: không còn được rút hay xuất bản */
export const isLegacyPrize = (prize) => prize.prizeType !== GACHA_PRIZE_TYPE;

/** Phiên bản chỉ gồm móc khóa mới được dùng để quay; phiên bản cũ còn giải mã nạp được coi như không có cấu hình */
export const isKeychainConfig = (config) => Boolean(config) && !config.prizes.some(isLegacyPrize);

/** Giải tham gia rút thăm: móc khóa đang bật, xác suất lớn hơn 0, theo đúng thứ tự trong cấu hình */
export const drawablePrizes = (config) => config.prizes.filter((prize) => !isLegacyPrize(prize) && prize.enabled && prize.probabilityPpm > 0);

const findInEffect = (now) => GachaConfig.findOne(inEffect(now)).sort({ effectiveFrom: -1, version: -1 }).lean();

/**
 * Cấu hình đang hiệu lực: bản đã xuất bản có effectiveFrom gần nhất. Không có bản nào → null: quay thưởng tạm dừng, lượt quay được
 * giữ. Không tự tạo cấu hình mặc định vì móc khóa, ảnh và nơi nhận quà phải do quản trị viên nhập.
 */
export async function getActiveGachaConfig(now = new Date()) {
  return findInEffect(now);
}

async function reserveUnits(key, amount, limit) {
  if (amount > limit) return false;
  const filter = { _id: key, used: { $lte: limit - amount } };
  try {
    await GachaStock.updateOne(filter, { $inc: { used: amount } }, { upsert: true });
    return true;
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Bộ đếm đã có: hoặc hai yêu cầu đầu tiên cùng tạo, hoặc đã chạm giới hạn → thử cập nhật đúng điều kiện, không upsert
    const { modifiedCount } = await GachaStock.updateOne(filter, { $inc: { used: amount } });
    return modifiedCount === 1;
  }
}

const releaseUnits = (key, amount) => GachaStock.updateOne({ _id: key }, { $inc: { used: -amount } });

/** Số móc khóa đã trúng theo mã giải, cộng dồn mọi phiên bản: Map prizeId → số đã trúng */
export async function keychainUsage(prizeIds) {
  const ids = [...new Set(prizeIds)];
  if (ids.length === 0) return new Map();
  const counters = await GachaStock.find({ _id: { $in: ids.map(keychainStockKey) } }).lean();
  const used = new Map(counters.map((counter) => [counter._id, counter.used]));
  return new Map(ids.map((prizeId) => [prizeId, Math.max(0, used.get(keychainStockKey(prizeId)) || 0)]));
}

export const remainingOf = (prize, usage) => Math.max(0, prize.maxQuantity - (usage.get(prize.prizeId) || 0));

/**
 * Rút một lượt theo cấu hình. Xác suất cố định: số rút trúng mẫu đã hết thì tính là không trúng, xác suất các mẫu khác không đổi.
 * Mọi mẫu đều đã hết (hoặc không có mẫu nào) → { unavailable: 'out_of_stock' }, không rút, lượt được giữ.
 * Trả về { prize, release } khi trúng (đã giữ một móc khóa trong kho, release() để trả lại) hoặc { prize: null } khi không trúng.
 */
export async function drawFromConfig(config) {
  const prizes = drawablePrizes(config);
  const usage = await keychainUsage(prizes.map((prize) => prize.prizeId));
  if (!prizes.some((prize) => remainingOf(prize, usage) > 0)) return { unavailable: 'out_of_stock' };

  const drawn = drawPrize(prizes);
  if (!drawn || remainingOf(drawn, usage) === 0) return { prize: null };
  const key = keychainStockKey(drawn.prizeId);
  // Hai lượt cùng lúc tranh móc khóa cuối cùng: lượt chậm hơn tính là không trúng, đúng như khi mẫu đã hết
  if (!(await reserveUnits(key, 1, drawn.maxQuantity))) return { prize: null };
  return { prize: drawn, release: () => releaseUnits(key, 1) };
}

// ---- Kiểm tra dữ liệu nhập ----

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function normalizePrize(raw, index, fields) {
  const at = (name) => `prizes.${index}.${name}`;
  const imageId = text(raw?.imageId);
  const prize = {
    prizeId: text(raw?.prizeId),
    label: text(raw?.label),
    prizeType: GACHA_PRIZE_TYPE,
    description: text(raw?.description),
    imageId: imageId || null,
    probabilityPpm: raw?.probabilityPpm,
    // Không gửi thì mặc định bật; đã gửi thì phải là boolean: chuỗi "false" hay số 0 không được hiểu thành "đang bật"
    enabled: raw?.enabled === undefined ? true : raw.enabled,
    maxQuantity: raw?.maxQuantity,
  };
  if (!PRIZE_ID.test(prize.prizeId)) fields[at('prizeId')] = 'Mã giải chỉ gồm chữ thường, số và dấu gạch ngang (tối đa 40 ký tự).';
  if (typeof prize.enabled !== 'boolean') fields[at('enabled')] = 'Trạng thái bật/tắt không hợp lệ.';
  if (!prize.label || prize.label.length > 80) fields[at('label')] = 'Tên móc khóa cần từ 1 đến 80 ký tự.';
  if (prize.description.length > MAX_DESCRIPTION) fields[at('description')] = `Mô tả tối đa ${MAX_DESCRIPTION} ký tự.`;
  if (!prize.imageId) fields[at('imageId')] = 'Chọn ảnh móc khóa.';
  else if (!OBJECT_ID.test(prize.imageId)) fields[at('imageId')] = 'Ảnh không hợp lệ.';
  if (!Number.isSafeInteger(prize.probabilityPpm) || prize.probabilityPpm < 0 || prize.probabilityPpm > PROBABILITY_TOTAL_PPM) {
    fields[at('probabilityPpm')] = 'Xác suất là số từ 0 đến 100, tối đa 4 chữ số thập phân.';
  }
  if (!Number.isSafeInteger(prize.maxQuantity) || prize.maxQuantity < 1 || prize.maxQuantity > MAX_QUANTITY) {
    fields[at('maxQuantity')] = 'Nhập tổng số móc khóa của mẫu này (số nguyên dương).';
  }
  return prize;
}

function parseDate(value, field, fields) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    fields[field] = 'Thời điểm không hợp lệ.';
    return null;
  }
  return date;
}

/**
 * Chuẩn hóa dữ liệu bản nháp. Không tin giá trị client: mọi trường được đọc tường minh, trường lạ bị bỏ qua. Chỉ nhận móc khóa:
 * giải mã nạp của bản nháp cũ bị bỏ khi lưu lại. Ngân sách VND chỉ dùng cho giải mã nạp nên luôn để trống.
 */
export function normalizeConfigInput(body) {
  const fields = {};
  if (!Array.isArray(body?.prizes) || body.prizes.length > MAX_PRIZES) {
    throw invalidInput({ prizes: `Danh sách móc khóa tối đa ${MAX_PRIZES} dòng.` });
  }
  const prizes = body.prizes.map((raw, index) => normalizePrize(raw, index, fields));
  const seen = new Set();
  prizes.forEach((prize, index) => {
    if (seen.has(prize.prizeId)) fields[`prizes.${index}.prizeId`] = 'Mã giải bị trùng.';
    seen.add(prize.prizeId);
  });

  const note = text(body.note);
  if (note.length > MAX_NOTE) fields.note = `Ghi chú tối đa ${MAX_NOTE} ký tự.`;
  const claimInstructions = text(body.claimInstructions);
  if (claimInstructions.length > MAX_CLAIM_INSTRUCTIONS) fields.claimInstructions = `Hướng dẫn nhận quà tối đa ${MAX_CLAIM_INSTRUCTIONS} ký tự.`;

  const effectiveFrom = parseDate(body.effectiveFrom, 'effectiveFrom', fields);
  const effectiveTo = parseDate(body.effectiveTo, 'effectiveTo', fields);
  if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) fields.effectiveTo = 'Thời điểm kết thúc phải sau thời điểm bắt đầu.';

  if (Object.keys(fields).length > 0) throw invalidInput(fields);
  return { prizes, budgetVnd: null, note, claimInstructions, effectiveFrom, effectiveTo };
}

/** Ảnh của từng móc khóa phải có trong thư viện và đúng loại ảnh móc khóa */
export async function assertPrizeImages(prizes) {
  const ids = [...new Set(prizes.map((prize) => String(prize.imageId)).filter((id) => OBJECT_ID.test(id)))];
  const found = await GachaMedia.find({ _id: { $in: ids }, kind: 'keychain' }).select('_id').lean();
  const known = new Set(found.map((media) => media._id.toString()));
  const fields = {};
  prizes.forEach((prize, index) => {
    if (!known.has(String(prize.imageId))) fields[`prizes.${index}.imageId`] = 'Không tìm thấy ảnh móc khóa này trong thư viện ảnh.';
  });
  if (Object.keys(fields).length > 0) throw invalidInput(fields);
}

/**
 * Điều kiện để xuất bản: chỉ có móc khóa, có ít nhất một mẫu đang bật, tổng xác suất trúng không quá 100%, mỗi mẫu đang bật còn
 * móc khóa để phát, có hướng dẫn nhận quà, hiệu lực hợp lệ. usage: Map prizeId → số đã trúng (keychainUsage).
 */
export function validateForPublish(config, now = new Date(), usage = new Map()) {
  const fields = {};
  const enabled = config.prizes.filter((prize) => prize.enabled);
  if (enabled.length === 0) fields.prizes = 'Cần ít nhất một mẫu móc khóa đang bật.';
  config.prizes.forEach((prize, index) => {
    const at = (name) => `prizes.${index}.${name}`;
    if (isLegacyPrize(prize)) {
      fields[at('label')] = 'Mã nạp điện thoại không còn được phát. Xóa dòng này.';
      return;
    }
    if (!prize.enabled) return;
    if (prize.probabilityPpm < 1) fields[at('probabilityPpm')] = 'Mẫu đang bật cần xác suất lớn hơn 0.';
    if (!prize.imageId) fields[at('imageId')] = 'Chọn ảnh móc khóa.';
    const used = usage.get(prize.prizeId) || 0;
    if (Number.isSafeInteger(prize.maxQuantity) && prize.maxQuantity <= used) {
      fields[at('maxQuantity')] = `Đã trúng ${used} móc khóa của mẫu này: số lượng phải lớn hơn ${used} mới còn quà để phát.`;
    }
  });
  const total = enabled.reduce((sum, prize) => sum + prize.probabilityPpm, 0);
  if (total > PROBABILITY_TOTAL_PPM) {
    fields.probabilityTotal = `Tổng xác suất trúng của các mẫu đang bật tối đa 100% (hiện tại ${total / 10_000}%).`;
  }
  if (!text(config.claimInstructions)) {
    fields.claimInstructions = 'Nhập hướng dẫn nhận quà: nơi nhận, thời gian, cần mang gì, hạn nhận.';
  }
  const from = config.effectiveFrom || now;
  if (from.getTime() < now.getTime() - 60_000) fields.effectiveFrom = 'Thời điểm hiệu lực đã qua. Để trống để áp dụng ngay.';
  if (config.effectiveTo && config.effectiveTo <= (from > now ? from : now)) fields.effectiveTo = 'Thời điểm kết thúc phải ở tương lai và sau thời điểm bắt đầu.';
  if (Object.keys(fields).length > 0) throw invalidInput(fields, 'Cấu hình chưa đủ điều kiện xuất bản.');
  return from > now ? from : now;
}

async function nextVersion() {
  const latest = await GachaConfig.findOne().sort({ version: -1 }).select('version').lean();
  return (latest?.version || 0) + 1;
}

async function draftBase(basedOnId) {
  if (basedOnId === undefined || basedOnId === null) {
    return (await getActiveGachaConfig()) || GachaConfig.findOne({ status: 'published' }).sort({ version: -1 }).lean();
  }
  if (typeof basedOnId !== 'string' || !OBJECT_ID.test(basedOnId)) throw invalidInput({ basedOnId: 'Phiên bản không hợp lệ.' });
  const base = await GachaConfig.findById(basedOnId).lean();
  if (!base) throw notFound('Không tìm thấy phiên bản để sao chép.');
  return base;
}

/**
 * Bản nháp mới sao từ một phiên bản có sẵn (mặc định là bản đang hiệu lực, không có thì bản xuất bản gần nhất); chỉ chép các mẫu
 * móc khóa, không chép giải mã nạp cũ. Số phiên bản lấy theo unique index.
 */
export async function createDraftConfig(actor, { basedOnId } = {}) {
  const base = await draftBase(basedOnId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await GachaConfig.create({
        version: await nextVersion(),
        status: 'draft',
        prizes: (base?.prizes || []).filter((prize) => !isLegacyPrize(prize)),
        budgetVnd: null,
        claimInstructions: base?.claimInstructions || '',
        note: '',
        basedOnVersion: base?.version,
        createdBy: actor.id,
        createdByLabel: actor.label,
        updatedBy: actor.id,
        updatedByLabel: actor.label,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }
  throw new AdminError(409, 'version_conflict', 'Không cấp được số phiên bản. Vui lòng thử lại.');
}

function serializePrize(prize) {
  const common = {
    prizeId: prize.prizeId,
    label: prize.label,
    prizeType: prize.prizeType || null,
    probabilityPpm: prize.probabilityPpm,
    enabled: prize.enabled !== false,
    maxQuantity: prize.maxQuantity ?? null,
  };
  if (isLegacyPrize(prize)) return { ...common, legacy: true, carrier: prize.carrier || '', amountVnd: prize.amountVnd ?? null };
  const imageId = prize.imageId ? prize.imageId.toString() : null;
  return { ...common, legacy: false, description: prize.description || '', imageId, imageUrl: mediaUrl(imageId) };
}

export function serializeConfig(config, { currentId = null } = {}) {
  const id = config._id.toString();
  return {
    id,
    version: config.version,
    revision: config.__v ?? 0,
    status: config.status,
    isCurrent: currentId === id,
    legacy: !isKeychainConfig(config),
    prizes: config.prizes.map(serializePrize),
    budgetVnd: config.budgetVnd ?? null,
    claimInstructions: config.claimInstructions || '',
    effectiveFrom: config.effectiveFrom || null,
    effectiveTo: config.effectiveTo || null,
    note: config.note || '',
    basedOnVersion: config.basedOnVersion ?? null,
    createdByLabel: config.createdByLabel || '',
    updatedByLabel: config.updatedByLabel || '',
    publishedByLabel: config.publishedByLabel || '',
    publishedAt: config.publishedAt || null,
    endedByLabel: config.endedByLabel || '',
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}
