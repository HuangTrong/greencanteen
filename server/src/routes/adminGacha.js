import { Router } from 'express';
import { GachaConfig } from '../models/GachaConfig.js';
import { GachaReward } from '../models/GachaReward.js';
import { GachaStock } from '../models/GachaStock.js';
import { adminAction, adminRead, requireReauth } from '../middleware/admin.js';
import { AdminError, notFound, versionConflict } from '../services/adminErrors.js';
import { adminActor } from '../services/audit.js';
import {
  createDraftConfig,
  getActiveGachaConfig,
  normalizeConfigInput,
  serializeConfig,
  validateForPublish,
} from '../services/gachaConfig.js';
import { parsePaging } from '../services/adminQuery.js';

const router = Router();

const configTarget = (config) => ({ type: 'gacha_config', id: config._id, label: `v${config.version}` });

router.param('id', (req, res, next, id) => {
  if (/^[a-f0-9]{24}$/i.test(id)) return next();
  res.status(404).json({ error: 'Không tìm thấy cấu hình.', code: 'not_found' });
});

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
    const [currentId, issued, stock] = await Promise.all([
      currentConfigId(),
      GachaReward.aggregate([
        { $match: { configVersion: config.version } },
        { $group: { _id: '$prizeId', count: { $sum: 1 }, faceValueVnd: { $sum: '$amountVnd' } } },
      ]),
      GachaStock.findById(`${config._id}:budget`).lean(),
    ]);
    return {
      ...serializeConfig(config, { currentId }),
      issued: issued.map(({ _id, count, faceValueVnd }) => ({ prizeId: _id, count, faceValueVnd })),
      budgetUsedVnd: stock?.used ?? 0,
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
    config.set({ ...input, updatedBy: req.admin._id, updatedByLabel: adminActor(req.admin).label });
    await config.save();
    ctx.meta = {
      prizes: input.prizes.length,
      budgetVnd: input.budgetVnd,
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
    const effectiveFrom = validateForPublish(config);
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
    ctx.meta = { version: published.version, effectiveFrom, effectiveTo: published.effectiveTo, budgetVnd: published.budgetVnd };
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

export default router;
