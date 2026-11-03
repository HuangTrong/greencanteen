import { GachaConfig } from '../models/GachaConfig.js';
import { GachaStock } from '../models/GachaStock.js';
import { DEFAULT_PRIZES, GACHA_PRIZE_TYPE, PROBABILITY_TOTAL_PPM, pickPrize } from './gacha.js';
import { AdminError, invalidInput, notFound } from './adminErrors.js';

const PRIZE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_PRIZES = 50;
const MAX_NOTE = 500;

const isDuplicateKey = (err) => Number(err?.code) === 11000;
const inEffect = (now) => ({
  status: 'published',
  effectiveFrom: { $lte: now },
  $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
});

/** Lần đầu chạy (hoặc DB trống): tạo phiên bản 1 từ bộ giải cố định trước đây để Gacha hoạt động y như cũ */
export async function ensureDefaultGachaConfig() {
  if (await GachaConfig.exists({})) return false;
  try {
    await GachaConfig.create({
      version: 1,
      status: 'published',
      prizes: DEFAULT_PRIZES,
      effectiveFrom: new Date(0),
      note: 'Cấu hình khởi tạo từ bộ giải cố định trước khi có quản trị Gacha.',
      createdByLabel: 'hệ thống',
      publishedByLabel: 'hệ thống',
      publishedAt: new Date(),
    });
    return true;
  } catch (err) {
    if (isDuplicateKey(err)) return false; // tiến trình khác vừa tạo
    throw err;
  }
}

const findInEffect = (now) => GachaConfig.findOne(inEffect(now)).sort({ effectiveFrom: -1, version: -1 }).lean();

/** Cấu hình đang hiệu lực: bản đã xuất bản có effectiveFrom gần nhất. Hết bản hiệu lực → null, Gacha tạm dừng */
export async function getActiveGachaConfig(now = new Date()) {
  const config = await findInEffect(now);
  if (config) return config;
  // Another request may create the default config between our initial read and this call.
  // Re-read regardless of who won the unique-index race so concurrent first spins can proceed.
  await ensureDefaultGachaConfig();
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

async function tryReserve(config, prize) {
  const stockKey = `${config._id}:prize:${prize.prizeId}`;
  const budgetKey = `${config._id}:budget`;
  const hasStockLimit = prize.maxQuantity !== null && prize.maxQuantity !== undefined;
  const hasBudget = config.budgetVnd !== null && config.budgetVnd !== undefined;

  if (hasStockLimit && !(await reserveUnits(stockKey, 1, prize.maxQuantity))) return null;
  if (hasBudget && !(await reserveUnits(budgetKey, prize.amountVnd, config.budgetVnd))) {
    if (hasStockLimit) await releaseUnits(stockKey, 1);
    return null;
  }
  return async () => {
    if (hasStockLimit) await releaseUnits(stockKey, 1);
    if (hasBudget) await releaseUnits(budgetKey, prize.amountVnd);
  };
}

/** Rút giải theo xác suất; giải đã hết kho hoặc vượt ngân sách bị loại rồi rút lại trong các giải còn lại */
export async function reservePrize(config) {
  let candidates = config.prizes.filter((prize) => prize.enabled && prize.probabilityPpm > 0);
  while (candidates.length > 0) {
    const prize = pickPrize(candidates);
    const release = await tryReserve(config, prize);
    if (release) return { prize, release };
    candidates = candidates.filter((candidate) => candidate.prizeId !== prize.prizeId);
  }
  return null;
}

// ---- Kiểm tra dữ liệu nhập ----

const optionalPositiveInt = (value) => value === null || value === undefined || value === '' || (Number.isSafeInteger(value) && value > 0);

function normalizePrize(raw, index, fields) {
  const at = (name) => `prizes.${index}.${name}`;
  const prize = {
    prizeId: typeof raw?.prizeId === 'string' ? raw.prizeId.trim() : '',
    label: typeof raw?.label === 'string' ? raw.label.trim() : '',
    prizeType: GACHA_PRIZE_TYPE,
    carrier: typeof raw?.carrier === 'string' ? raw.carrier.trim() : '',
    amountVnd: raw?.amountVnd,
    probabilityPpm: raw?.probabilityPpm,
    enabled: raw?.enabled !== false,
    maxQuantity: raw?.maxQuantity === undefined || raw?.maxQuantity === '' ? null : raw.maxQuantity,
  };
  if (!PRIZE_ID.test(prize.prizeId)) fields[at('prizeId')] = 'Mã giải chỉ gồm chữ thường, số và dấu gạch ngang (tối đa 40 ký tự).';
  if (!prize.label || prize.label.length > 80) fields[at('label')] = 'Tên giải cần từ 1 đến 80 ký tự.';
  if (!prize.carrier || prize.carrier.length > 40) fields[at('carrier')] = 'Nhà mạng cần từ 1 đến 40 ký tự.';
  if (!Number.isSafeInteger(prize.amountVnd) || prize.amountVnd < 1000 || prize.amountVnd > 10_000_000 || prize.amountVnd % 1000 !== 0) {
    fields[at('amountVnd')] = 'Mệnh giá là số nguyên VND, từ 1.000 đến 10.000.000 và chia hết cho 1.000.';
  }
  if (!Number.isSafeInteger(prize.probabilityPpm) || prize.probabilityPpm < 0 || prize.probabilityPpm > PROBABILITY_TOTAL_PPM) {
    fields[at('probabilityPpm')] = 'Xác suất không hợp lệ.';
  }
  if (!optionalPositiveInt(prize.maxQuantity)) fields[at('maxQuantity')] = 'Giới hạn kho là số nguyên dương hoặc để trống.';
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

/** Chuẩn hóa dữ liệu bản nháp. Không tin giá trị client: mọi trường được đọc tường minh, trường lạ bị bỏ qua. */
export function normalizeConfigInput(body) {
  const fields = {};
  if (!Array.isArray(body?.prizes) || body.prizes.length > MAX_PRIZES) {
    throw invalidInput({ prizes: `Danh sách giải cần có từ 1 đến ${MAX_PRIZES} dòng.` });
  }
  const prizes = body.prizes.map((raw, index) => normalizePrize(raw, index, fields));
  const seen = new Set();
  prizes.forEach((prize, index) => {
    if (seen.has(prize.prizeId)) fields[`prizes.${index}.prizeId`] = 'Mã giải bị trùng.';
    seen.add(prize.prizeId);
  });

  const budgetVnd = body.budgetVnd === undefined || body.budgetVnd === '' ? null : body.budgetVnd;
  if (!optionalPositiveInt(budgetVnd)) fields.budgetVnd = 'Ngân sách là số nguyên VND dương hoặc để trống.';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > MAX_NOTE) fields.note = `Ghi chú tối đa ${MAX_NOTE} ký tự.`;

  const effectiveFrom = parseDate(body.effectiveFrom, 'effectiveFrom', fields);
  const effectiveTo = parseDate(body.effectiveTo, 'effectiveTo', fields);
  if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) fields.effectiveTo = 'Thời điểm kết thúc phải sau thời điểm bắt đầu.';

  if (Object.keys(fields).length > 0) throw invalidInput(fields);
  return { prizes, budgetVnd, note, effectiveFrom, effectiveTo };
}

/** Điều kiện để xuất bản: tổng xác suất các giải đang bật đúng 100%, hiệu lực hợp lệ, ngân sách phát được ít nhất một giải */
export function validateForPublish(config, now = new Date()) {
  const fields = {};
  const enabled = config.prizes.filter((prize) => prize.enabled);
  if (enabled.length === 0) fields.prizes = 'Cần ít nhất một giải đang bật.';
  config.prizes.forEach((prize, index) => {
    if (prize.enabled && prize.probabilityPpm < 1) fields[`prizes.${index}.probabilityPpm`] = 'Giải đang bật cần xác suất lớn hơn 0.';
  });
  const total = enabled.reduce((sum, prize) => sum + prize.probabilityPpm, 0);
  if (enabled.length > 0 && total !== PROBABILITY_TOTAL_PPM) {
    fields.probabilityTotal = `Tổng xác suất các giải đang bật phải bằng 100% (hiện tại ${total / 10_000}%).`;
  }
  if (config.budgetVnd !== null && config.budgetVnd !== undefined && enabled.length > 0) {
    const cheapest = Math.min(...enabled.map((prize) => prize.amountVnd));
    if (config.budgetVnd < cheapest) fields.budgetVnd = 'Ngân sách nhỏ hơn mệnh giá thấp nhất nên không phát được giải nào.';
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
  if (basedOnId === undefined || basedOnId === null) return getActiveGachaConfig();
  if (typeof basedOnId !== 'string' || !/^[a-f0-9]{24}$/i.test(basedOnId)) throw invalidInput({ basedOnId: 'Phiên bản không hợp lệ.' });
  const base = await GachaConfig.findById(basedOnId).lean();
  if (!base) throw notFound('Không tìm thấy phiên bản để sao chép.');
  return base;
}

/** Bản nháp mới sao từ một phiên bản có sẵn (mặc định là bản đang hiệu lực); số phiên bản lấy theo unique index */
export async function createDraftConfig(actor, { basedOnId } = {}) {
  const base = await draftBase(basedOnId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await GachaConfig.create({
        version: await nextVersion(),
        status: 'draft',
        prizes: base?.prizes?.length ? base.prizes : DEFAULT_PRIZES,
        budgetVnd: base?.budgetVnd ?? null,
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

export function serializeConfig(config, { currentId = null } = {}) {
  const id = config._id.toString();
  return {
    id,
    version: config.version,
    revision: config.__v ?? 0,
    status: config.status,
    isCurrent: currentId === id,
    prizes: config.prizes.map(({ prizeId, label, prizeType, carrier, amountVnd, probabilityPpm, enabled, maxQuantity }) => ({
      prizeId,
      label,
      prizeType,
      carrier,
      amountVnd,
      probabilityPpm,
      enabled,
      maxQuantity: maxQuantity ?? null,
    })),
    budgetVnd: config.budgetVnd ?? null,
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
