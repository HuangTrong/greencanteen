import { Router } from 'express';
import multer from 'multer';
import { GachaConfig } from '../models/GachaConfig.js';
import { GachaMedia } from '../models/GachaMedia.js';
import { GachaReward } from '../models/GachaReward.js';
import { GachaStock } from '../models/GachaStock.js';
import { User } from '../models/User.js';
import { adminAction, adminRead, requireReauth } from '../middleware/admin.js';
import { AdminError, invalidInput, notFound, versionConflict } from '../services/adminErrors.js';
import { adminActor, writeAudit } from '../services/audit.js';
import { GACHA_PRIZE_TYPE, normalizeClaimCode } from '../services/gacha.js';
import {
  assertPrizeImages,
  createDraftConfig,
  getActiveGachaConfig,
  isLegacyPrize,
  keychainUsage,
  normalizeConfigInput,
  serializeConfig,
  validateForPublish,
} from '../services/gachaConfig.js';
import { MAX_MEDIA_UPLOAD_BYTES, MEDIA_KINDS, inspectMedia, mediaUrl, renderMedia, serializeMedia } from '../services/gachaMedia.js';
import { scanForMalware } from '../services/malwareScan.js';
import { maskStudentId } from '../services/privacy.js';
import { parsePaging } from '../services/adminQuery.js';

// Quay thưởng tri ân: phiên bản cấu hình (móc khóa, xác suất, nơi nhận quà), thư viện ảnh / sticker, danh sách trao quà
const router = Router();

const configTarget = (config) => ({ type: 'gacha_config', id: config._id, label: `v${config.version}` });
const mediaTarget = (media) => ({ type: 'gacha_media', id: media._id, label: media.name });
const rewardTarget = (reward) => ({ type: 'gacha_reward', id: reward._id, label: reward.prizeLabel || '' });

const MAX_NAME = 80;
const MAX_DELIVERY_NOTE = 300;
const MAX_MEDIA_LIST = 300;

router.param('id', (req, res, next, id) => {
  if (/^[a-f0-9]{24}$/i.test(id)) return next();
  res.status(404).json({ error: 'Không tìm thấy dữ liệu.', code: 'not_found' });
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

// ---- Phiên bản cấu hình ----

async function loadConfig(id) {
  const config = await GachaConfig.findById(id);
  if (!config) throw notFound('Không tìm thấy cấu hình.');
  return config;
}

const currentConfigId = async () => (await getActiveGachaConfig())?._id.toString() ?? null;

function assertDraft(config, revision) {
  if (config.status !== 'draft') throw new AdminError(409, 'not_draft', 'Chỉ sửa được bản nháp. Hãy tạo bản nháp mới từ phiên bản này.');
  if (revision !== config.__v) throw versionConflict();
}

const keychainIds = (config) => config.prizes.filter((prize) => !isLegacyPrize(prize)).map((prize) => prize.prizeId);

router.get(
  '/configs',
  adminRead(async (req) => {
    const { page, pageSize, skip } = parsePaging(req.query);
    const filter = { status: { $ne: 'discarded' } };
    const [rows, total, currentId] = await Promise.all([
      GachaConfig.find(filter).sort({ version: -1 }).skip(skip).limit(pageSize).lean(),
      GachaConfig.countDocuments(filter),
      currentConfigId(),
    ]);
    return { items: rows.map((row) => serializeConfig(row, { currentId })), page, pageSize, total, currentId };
  })
);

router.post(
  '/configs',
  adminAction('gacha.config_create', async (req, ctx) => {
    const config = await createDraftConfig(adminActor(req.admin), { basedOnId: req.body.basedOnId });
    ctx.target = configTarget(config);
    ctx.meta = { basedOnVersion: config.basedOnVersion };
    ctx.status = 201;
    return serializeConfig(config);
  })
);

router.get(
  '/configs/:id',
  adminRead(async (req) => {
    const config = await loadConfig(req.params.id);
    const [currentId, results, usage, budget] = await Promise.all([
      currentConfigId(),
      GachaReward.aggregate([
        { $match: { configVersion: config.version } },
        { $group: { _id: '$prizeId', count: { $sum: 1 }, faceValueVnd: { $sum: { $ifNull: ['$amountVnd', 0] } } } },
      ]),
      keychainUsage(keychainIds(config)),
      config.budgetVnd === null || config.budgetVnd === undefined ? null : GachaStock.findById(`${config._id}:budget`).lean(),
    ]);
    // Lượt không trúng không có prizeId: nhóm null
    const wins = results.filter((row) => row._id !== null && row._id !== undefined);
    const losses = results.find((row) => row._id === null || row._id === undefined)?.count ?? 0;
    const winCount = wins.reduce((sum, row) => sum + row.count, 0);
    return {
      ...serializeConfig(config, { currentId }),
      issued: wins.map(({ _id, count, faceValueVnd }) => ({ prizeId: _id, count, faceValueVnd })),
      spins: { total: winCount + losses, wins: winCount, losses },
      // Số móc khóa đã trúng của từng mẫu, cộng dồn mọi phiên bản dùng cùng mã giải
      usage: [...usage].map(([prizeId, used]) => ({ prizeId, used })),
      budgetUsedVnd: budget?.used ?? 0,
    };
  })
);

router.put(
  '/configs/:id',
  adminAction('gacha.config_update', async (req, ctx) => {
    const config = await loadConfig(req.params.id);
    ctx.target = configTarget(config);
    assertDraft(config, req.body.revision);
    const input = normalizeConfigInput(req.body);
    await assertPrizeImages(input.prizes);
    config.set({ ...input, updatedBy: req.admin._id, updatedByLabel: adminActor(req.admin).label });
    await config.save();
    ctx.meta = {
      prizes: input.prizes.length,
      totalProbabilityPpm: input.prizes.filter((prize) => prize.enabled).reduce((sum, prize) => sum + prize.probabilityPpm, 0),
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    };
    return serializeConfig(config);
  })
);

router.post(
  '/configs/:id/publish',
  requireReauth,
  adminAction('gacha.config_publish', async (req, ctx) => {
    const config = await loadConfig(req.params.id);
    ctx.target = configTarget(config);
    assertDraft(config, req.body.revision);
    const effectiveFrom = validateForPublish(config, new Date(), await keychainUsage(keychainIds(config)));
    await assertPrizeImages(config.prizes);
    const actor = adminActor(req.admin);
    // Điều kiện trong cùng lệnh ghi: hai người bấm xuất bản đồng thời chỉ một người thành công
    const published = await GachaConfig.findOneAndUpdate(
      { _id: config._id, status: 'draft', __v: config.__v },
      {
        $set: { status: 'published', effectiveFrom, publishedBy: actor.id, publishedByLabel: actor.label, publishedAt: new Date() },
        $inc: { __v: 1 },
      },
      { new: true }
    );
    if (!published) throw versionConflict();
    ctx.meta = {
      version: published.version,
      effectiveFrom,
      effectiveTo: published.effectiveTo,
      prizes: published.prizes.filter((prize) => prize.enabled).map((prize) => ({ prizeId: prize.prizeId, probabilityPpm: prize.probabilityPpm, maxQuantity: prize.maxQuantity })),
    };
    return serializeConfig(published, { currentId: await currentConfigId() });
  })
);

router.post(
  '/configs/:id/end',
  requireReauth,
  adminAction('gacha.config_end', async (req, ctx) => {
    const config = await loadConfig(req.params.id);
    ctx.target = configTarget(config);
    const now = new Date();
    const ended = await GachaConfig.findOneAndUpdate(
      { _id: config._id, status: 'published', $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }] },
      { $set: { effectiveTo: now, endedByLabel: adminActor(req.admin).label }, $inc: { __v: 1 } },
      { new: true }
    );
    if (!ended) throw new AdminError(409, 'not_in_effect', 'Phiên bản này không còn hiệu lực.');
    ctx.meta = { version: ended.version, endedAt: now };
    return serializeConfig(ended, { currentId: await currentConfigId() });
  })
);

router.post(
  '/configs/:id/discard',
  adminAction('gacha.config_discard', async (req, ctx) => {
    const config = await loadConfig(req.params.id);
    ctx.target = configTarget(config);
    assertDraft(config, req.body.revision);
    config.status = 'discarded';
    config.updatedByLabel = adminActor(req.admin).label;
    await config.save();
    return { ok: true };
  })
);

// ---- Thư viện ảnh móc khóa, sticker trúng / không trúng ----

const mediaKind = (value) => (MEDIA_KINDS.includes(value) ? value : null);

router.get(
  '/media',
  adminRead(async (req) => {
    const kind = mediaKind(req.query.kind);
    const rows = await GachaMedia.find(kind ? { kind } : {}).sort({ createdAt: -1 }).limit(MAX_MEDIA_LIST).lean();
    return { items: rows.map(serializeMedia) };
  })
);

// Giữ trong bộ nhớ: xử lý xong là bỏ, không để lại tệp tạm trên đĩa
function receiveMedia(req, res, next) {
  const upload = multer({ limits: { fileSize: MAX_MEDIA_UPLOAD_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 1024 } }).single('image');
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Ảnh quá lớn (tối đa 8 MB).', code: 'image_too_large' });
    }
    res.status(400).json({ error: 'Gửi một ảnh trong trường "image" kèm loại và tên ảnh.', code: 'invalid_upload' });
  });
}

router.post(
  '/media',
  receiveMedia,
  adminAction('gacha.media_create', async (req, ctx) => {
    const kind = mediaKind(req.body?.kind);
    const name = text(req.body?.name);
    const fields = {};
    if (!kind) fields.kind = 'Chọn loại ảnh: móc khóa, sticker trúng hoặc sticker không trúng.';
    if (!name || name.length > MAX_NAME) fields.name = `Tên ảnh cần từ 1 đến ${MAX_NAME} ký tự.`;
    if (Object.keys(fields).length > 0) throw invalidInput(fields);
    ctx.meta = { kind, name, bytes: req.file?.size ?? 0 };

    const buffer = req.file?.buffer;
    ctx.meta.sourceType = inspectMedia(buffer);
    // Quét trước khi giải mã, như ảnh của sinh viên. clamd không trả lời → từ chối, không bỏ qua lớp này
    const scan = await scanForMalware(buffer);
    if (scan.status === 'unavailable') {
      throw new AdminError(503, 'scan_unavailable', 'Máy chủ chưa kiểm tra được ảnh này. Vui lòng thử lại sau ít phút.');
    }
    if (scan.status === 'infected') {
      await writeAudit(req, { action: 'upload.malware_blocked', result: 'denied', reason: 'malware_detected', meta: { upload: 'gacha_media', signature: scan.signature } });
      throw new AdminError(422, 'malware_detected', 'Tệp này bị từ chối vì không an toàn.');
    }

    const rendered = await renderMedia(buffer, kind);
    const label = adminActor(req.admin).label;
    const media = await GachaMedia.create({ kind, name, active: true, ...rendered, createdByLabel: label, updatedByLabel: label });
    ctx.target = mediaTarget(media);
    ctx.meta = { ...ctx.meta, width: rendered.width, height: rendered.height, animated: rendered.animated, storedBytes: rendered.bytes };
    ctx.status = 201;
    return serializeMedia(media);
  })
);

async function loadMedia(id) {
  const media = await GachaMedia.findById(id);
  if (!media) throw notFound('Không tìm thấy ảnh.');
  return media;
}

router.patch(
  '/media/:id',
  adminAction('gacha.media_update', async (req, ctx) => {
    const media = await loadMedia(req.params.id);
    ctx.target = mediaTarget(media);
    const changes = {};
    const fields = {};
    if (req.body?.name !== undefined) {
      const name = text(req.body.name);
      if (!name || name.length > MAX_NAME) fields.name = `Tên ảnh cần từ 1 đến ${MAX_NAME} ký tự.`;
      else changes.name = name;
    }
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== 'boolean') fields.active = 'Trạng thái không hợp lệ.';
      else changes.active = req.body.active;
    }
    if (Object.keys(fields).length > 0) throw invalidInput(fields);
    if (Object.keys(changes).length === 0) throw invalidInput({ name: 'Không có thay đổi nào.' });
    ctx.meta = { before: { name: media.name, active: media.active }, after: changes };
    media.set({ ...changes, updatedByLabel: adminActor(req.admin).label });
    await media.save();
    return serializeMedia(media);
  })
);

/**
 * Ảnh móc khóa đang được bản nháp hoặc phiên bản còn (hoặc sắp) hiệu lực dùng thì không xóa được: người trúng sẽ thấy ảnh trống.
 * Phiên bản đã kết thúc và kết quả quay cũ vẫn tham chiếu được ảnh đã xóa; giao diện hiện ô trống thay ảnh.
 */
async function assertMediaUnused(media) {
  if (media.kind !== 'keychain') return;
  const now = new Date();
  const user = await GachaConfig.findOne({
    'prizes.imageId': media._id,
    $or: [{ status: 'draft' }, { status: 'published', $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }] }],
  })
    .sort({ version: -1 })
    .select('version status')
    .lean();
  if (user) {
    const where = user.status === 'draft' ? `bản nháp phiên bản ${user.version}` : `phiên bản ${user.version} đang hoặc sắp hiệu lực`;
    throw new AdminError(409, 'media_in_use', `Ảnh đang được dùng ở ${where}. Gỡ ảnh khỏi bản nháp hoặc ngừng phiên bản đó trước khi xóa.`);
  }
}

router.delete(
  '/media/:id',
  adminAction('gacha.media_delete', async (req, ctx) => {
    const media = await loadMedia(req.params.id);
    ctx.target = mediaTarget(media);
    ctx.meta = { kind: media.kind, name: media.name };
    await assertMediaUnused(media);
    await GachaMedia.deleteOne({ _id: media._id });
    return { ok: true };
  })
);

// ---- Trao quà: lượt trúng móc khóa, mã nhận quà, xác nhận đã trao ----

const DELIVERY_STATUSES = ['pending', 'delivered'];

async function serializeRewards(rows) {
  const users = await User.find({ _id: { $in: [...new Set(rows.map((row) => String(row.userId)))] } })
    .select('name studentId')
    .lean();
  const byId = new Map(users.map((user) => [user._id.toString(), user]));
  return rows.map((row) => {
    const user = byId.get(String(row.userId));
    return {
      id: row._id.toString(),
      claimCode: row.claimCode || '',
      prizeLabel: row.prizeLabel || '',
      imageUrl: mediaUrl(row.imageId),
      configVersion: row.configVersion ?? null,
      deliveryStatus: row.deliveryStatus || 'pending',
      deliveredAt: row.deliveredAt || null,
      deliveredByLabel: row.deliveredByLabel || '',
      deliveryNote: row.deliveryNote || '',
      createdAt: row.createdAt,
      // Dữ liệu cá nhân che như danh sách tài khoản; đối chiếu đầy đủ ở trang chi tiết tài khoản (bỏ che cần xác thực lại)
      winner: user ? { id: user._id.toString(), name: user.name, studentId: maskStudentId(user.studentId) } : null,
    };
  });
}

router.get(
  '/rewards',
  adminRead(async (req) => {
    const { page, pageSize, skip } = parsePaging(req.query);
    const filter = { prizeType: GACHA_PRIZE_TYPE };
    if (DELIVERY_STATUSES.includes(req.query.status)) filter.deliveryStatus = req.query.status;
    // Tra đúng nguyên mã: không tìm theo một phần mã để không dò dần được mã của người khác
    const code = normalizeClaimCode(req.query.q);
    if (code) filter.claimCode = code;
    const [rows, total, pending] = await Promise.all([
      GachaReward.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      GachaReward.countDocuments(filter),
      GachaReward.countDocuments({ prizeType: GACHA_PRIZE_TYPE, deliveryStatus: 'pending' }),
    ]);
    return { items: await serializeRewards(rows), page, pageSize, total, pending };
  })
);

async function loadKeychainReward(id) {
  const reward = await GachaReward.findOne({ _id: id, prizeType: GACHA_PRIZE_TYPE }).lean();
  if (!reward) throw notFound('Không tìm thấy lượt trúng móc khóa này.');
  return reward;
}

router.post(
  '/rewards/:id/deliver',
  adminAction('gacha.reward_deliver', async (req, ctx) => {
    const reward = await loadKeychainReward(req.params.id);
    ctx.target = rewardTarget(reward);
    const note = text(req.body?.note);
    if (note.length > MAX_DELIVERY_NOTE) throw invalidInput({ note: `Ghi chú tối đa ${MAX_DELIVERY_NOTE} ký tự.` });
    const updated = await GachaReward.findOneAndUpdate(
      { _id: reward._id, prizeType: GACHA_PRIZE_TYPE, deliveryStatus: { $ne: 'delivered' } },
      { $set: { deliveryStatus: 'delivered', deliveredAt: new Date(), deliveredByLabel: adminActor(req.admin).label, deliveryNote: note } },
      { new: true, lean: true }
    );
    if (!updated) throw new AdminError(409, 'already_delivered', 'Móc khóa này đã được xác nhận trao trước đó.');
    ctx.meta = { configVersion: reward.configVersion, prizeId: reward.prizeId, note };
    const [row] = await serializeRewards([updated]);
    return row;
  })
);

router.post(
  '/rewards/:id/undeliver',
  adminAction('gacha.reward_undeliver', async (req, ctx) => {
    const reward = await loadKeychainReward(req.params.id);
    ctx.target = rewardTarget(reward);
    const reason = text(req.body?.reason);
    if (reason.length < 3 || reason.length > MAX_DELIVERY_NOTE) throw invalidInput({ reason: `Lý do cần từ 3 đến ${MAX_DELIVERY_NOTE} ký tự.` });
    ctx.meta = { reason, deliveredAt: reward.deliveredAt, deliveredByLabel: reward.deliveredByLabel };
    const updated = await GachaReward.findOneAndUpdate(
      { _id: reward._id, prizeType: GACHA_PRIZE_TYPE, deliveryStatus: 'delivered' },
      { $set: { deliveryStatus: 'pending', deliveryNote: '' }, $unset: { deliveredAt: 1, deliveredByLabel: 1 } },
      { new: true, lean: true }
    );
    if (!updated) throw new AdminError(409, 'not_delivered', 'Móc khóa này chưa được xác nhận trao.');
    const [row] = await serializeRewards([updated]);
    return row;
  })
);

export default router;
