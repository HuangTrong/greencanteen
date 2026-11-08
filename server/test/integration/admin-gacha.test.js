// Quay thưởng tri ân: phiên bản cấu hình móc khóa, xác suất có phần không trúng, số lượng dùng chung qua các phiên bản, đồng thời,
// ảnh & sticker, trao quà, thể lệ công khai, bản PWA cũ, migration từ mã nạp demo
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { User } from '../../src/models/User.js';
import { GachaConfig } from '../../src/models/GachaConfig.js';
import { GachaMedia } from '../../src/models/GachaMedia.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { GachaStock } from '../../src/models/GachaStock.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { SystemMarker } from '../../src/models/SystemMarker.js';
import { drawPrize } from '../../src/services/gacha.js';
import { getActiveGachaConfig } from '../../src/services/gachaConfig.js';
import { runMigrations } from '../../src/services/migrations.js';
import { recoverOutboxes } from '../../src/services/rewards.js';
import { createClient, realFetch, registerUser, setEnv, startTestServer } from '../helpers.js';
import { ADMIN_ENV, auditEntries, enrolledAdmin, expireReauth } from '../adminHelpers.js';
import { animatedGif, createMedia, legacyTopUpConfig, pngImage } from '../gachaHelpers.js';

let ctx;
let admin;
let image;

const CLAIM_CODE = /^TA-[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/;
const INSTRUCTIONS = 'Nhận tại quầy căn tin tầng 1, 11h-13h, mang mã nhận quà và thẻ sinh viên.';

const PRIZE = (overrides = {}) => ({
  prizeId: 'la-xanh',
  label: 'Lá xanh',
  description: 'Móc khóa hình lá',
  imageId: image.id,
  probabilityPpm: 1_000_000,
  enabled: true,
  maxQuantity: 100,
  ...overrides,
});

async function studentWithSpins(spins) {
  const client = createClient(ctx.base);
  const res = await registerUser(client);
  await User.updateOne({ _id: res.data.user.id }, { $set: { pendingGachaSpins: spins } });
  return { client, id: res.data.user.id, studentId: res.body.studentId };
}

const spinsOf = async (id) => (await User.findById(id).lean()).pendingGachaSpins;
const draw = (student, json) => student.client.post('/api/gacha/draw', json ? { json } : undefined);

/** Số rút cố định cho lượt quay (chỉ thay lần rút trong 1.000.000; mã nhận quà vẫn ngẫu nhiên thật) */
async function withDraw(value, fn) {
  const original = crypto.randomInt;
  crypto.randomInt = (...args) => (args[0] === 1_000_000 && args.length === 1 ? value : original(...args));
  try {
    return await fn();
  } finally {
    crypto.randomInt = original;
  }
}

const newDraft = async (body = {}) => (await admin.client.post('/api/admin/gacha/configs', { json: body })).data;
const saveDraft = (draft, patch) =>
  admin.client.put(`/api/admin/gacha/configs/${draft.id}`, {
    json: {
      prizes: draft.prizes,
      claimInstructions: draft.claimInstructions,
      note: draft.note,
      effectiveFrom: draft.effectiveFrom,
      effectiveTo: draft.effectiveTo,
      revision: draft.revision,
      ...patch,
    },
  });
const publish = (config) => admin.client.post(`/api/admin/gacha/configs/${config.id}/publish`, { json: { revision: config.revision } });

/** Tạo, lưu và xuất bản một cấu hình mới qua khu quản trị, có hiệu lực ngay */
async function publishConfig(patch = {}) {
  const saved = await saveDraft(await newDraft(), { prizes: [PRIZE()], claimInstructions: INSTRUCTIONS, ...patch });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const res = await publish(saved.data);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

function imageForm(buffer, { kind = 'keychain', name = 'Lá xanh', filename = 'anh.png', type = 'image/png' } = {}) {
  const form = new FormData();
  form.append('kind', kind);
  form.append('name', name);
  form.append('image', new Blob([buffer], { type }), filename);
  return form;
}

before(async () => {
  setEnv(ADMIN_ENV);
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(ADMIN_ENV);
  await RateLimit.deleteMany({});
  admin = await enrolledAdmin(ctx.base);
  await Promise.all([GachaConfig, GachaStock, GachaReward, GachaMedia].map((Model) => Model.collection.deleteMany({})));
  const media = await createMedia();
  image = { id: media._id.toString() };
});

describe('chưa có cấu hình móc khóa', () => {
  test('DB trống: không tự tạo cấu hình; quay báo tạm dừng và giữ lượt; thể lệ báo không hoạt động', async () => {
    const student = await studentWithSpins(1);
    const res = await draw(student);
    assert.deepEqual([res.status, res.data.code], [503, 'gacha_not_configured']);
    assert.equal(await spinsOf(student.id), 1);
    assert.equal(await GachaConfig.countDocuments(), 0);
    assert.deepEqual((await createClient(ctx.base).get('/api/gacha/rules', { csrf: false })).data, { active: false, prizes: [] });
  });

  test('phiên bản mã nạp cũ còn hiệu lực không được dùng để quay; bản nháp sao từ nó không chép giải mã nạp', async () => {
    await legacyTopUpConfig();
    const student = await studentWithSpins(1);
    assert.equal((await draw(student)).data.code, 'gacha_not_configured');
    const draft = await newDraft();
    assert.deepEqual(draft.prizes, []);
    assert.equal(draft.legacy, false);
  });
});

describe('rút thăm', () => {
  test('trúng: trả móc khóa, ảnh, mã nhận quà, hướng dẫn nhận quà; lưu dấu phiên bản; trừ lượt; số đã trúng tăng', async () => {
    const config = await publishConfig();
    const student = await studentWithSpins(2);
    const res = await draw(student);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.outcome, 'win');
    assert.equal(res.data.prize.type, 'keychain');
    assert.equal(res.data.prize.label, 'Lá xanh');
    assert.equal(res.data.prize.imageUrl, `/api/gacha/media/${image.id}`);
    assert.match(res.data.prize.claimCode, CLAIM_CODE);
    assert.equal(res.data.claimInstructions, INSTRUCTIONS);
    assert.equal(res.data.pendingGachaSpins, 1);

    const reward = await GachaReward.findById(res.data.rewardId).lean();
    assert.equal(reward.outcome, 'win');
    assert.equal(reward.prizeType, 'keychain');
    assert.equal(reward.deliveryStatus, 'pending');
    assert.equal(reward.claimCode, res.data.prize.claimCode);
    assert.equal(reward.configVersion, config.version);
    assert.equal(String(reward.configId), config.id);
    assert.equal(reward.prizeId, 'la-xanh');
    assert.equal((await GachaStock.findById('keychain:la-xanh').lean()).used, 1);
  });

  test('không trúng: lượt bị trừ, kết quả được ghi, không có mã nhận quà và không tốn móc khóa', async () => {
    const config = await publishConfig({ prizes: [PRIZE({ probabilityPpm: 10_000 })] });
    const student = await studentWithSpins(1);
    const res = await withDraw(999_999, () => draw(student));
    assert.equal(res.status, 200);
    assert.equal(res.data.outcome, 'lose');
    assert.equal(res.data.prize, null);
    assert.equal(res.data.claimInstructions, '');
    assert.equal(await spinsOf(student.id), 0);
    const reward = await GachaReward.findById(res.data.rewardId).lean();
    assert.deepEqual([reward.outcome, reward.configVersion, reward.claimCode, reward.prizeType], ['lose', config.version, undefined, undefined]);
    assert.equal(await GachaStock.countDocuments(), 0);
  });

  test('biên khoảng rút: số cuối cùng của khoảng còn trúng, số kế tiếp không trúng', async () => {
    await publishConfig({ prizes: [PRIZE({ probabilityPpm: 250_000 })] });
    const student = await studentWithSpins(2);
    assert.equal((await withDraw(249_999, () => draw(student))).data.outcome, 'win');
    assert.equal((await withDraw(250_000, () => draw(student))).data.outcome, 'lose');
  });

  test('mẫu đã hết: số rút trúng mẫu đó tính là không trúng, xác suất mẫu khác không đổi; mọi mẫu đều hết thì giữ lượt', async () => {
    await publishConfig({
      prizes: [PRIZE({ prizeId: 'hiem', probabilityPpm: 900_000, maxQuantity: 1 }), PRIZE({ prizeId: 'thuong', probabilityPpm: 100_000, maxQuantity: 1 })],
    });
    await GachaStock.collection.insertOne({ _id: 'keychain:hiem', used: 1 });
    const student = await studentWithSpins(3);
    const lost = await withDraw(0, () => draw(student));
    assert.equal(lost.data.outcome, 'lose', 'rơi vào khoảng của mẫu đã hết');
    const won = await withDraw(900_000, () => draw(student));
    assert.equal(won.data.outcome, 'win');
    assert.equal(won.data.prize.label, 'Lá xanh');
    assert.equal(await spinsOf(student.id), 1);

    const none = await draw(student);
    assert.deepEqual([none.status, none.data.code], [409, 'gacha_out_of_stock']);
    assert.equal(await spinsOf(student.id), 1, 'không còn móc khóa nào: lượt được giữ');
  });

  test('số lượng dùng chung qua các phiên bản: phiên bản mới không cấp lại móc khóa đã trúng', async () => {
    await publishConfig({ prizes: [PRIZE({ maxQuantity: 2 })] });
    const student = await studentWithSpins(5);
    for (let i = 0; i < 2; i += 1) assert.equal((await draw(student)).data.outcome, 'win');
    assert.equal((await draw(student)).data.code, 'gacha_out_of_stock');

    const copy = await newDraft();
    assert.equal(copy.prizes[0].maxQuantity, 2);
    const refused = await publish(copy);
    assert.match(refused.data.fields['prizes.0.maxQuantity'], /Đã trúng 2/);
    const saved = await saveDraft(copy, { prizes: [{ ...copy.prizes[0], maxQuantity: 3 }] });
    assert.equal((await publish(saved.data)).status, 200);
    assert.equal((await draw(student)).data.outcome, 'win');
    assert.equal((await draw(student)).data.code, 'gacha_out_of_stock');
    assert.equal((await GachaStock.findById('keychain:la-xanh').lean()).used, 3);
  });

  test('nhiều người quay đồng thời: không bao giờ phát vượt số lượng; người quay khi đã hết giữ được lượt', async () => {
    await publishConfig({ prizes: [PRIZE({ maxQuantity: 3 })] });
    const students = await Promise.all(Array.from({ length: 10 }, () => studentWithSpins(1)));
    const results = await Promise.all(students.map((s) => draw(s)));
    const wins = results.filter((r) => r.data.outcome === 'win').length;
    const losses = results.filter((r) => r.data.outcome === 'lose').length;
    const kept = results.filter((r) => r.data.code === 'gacha_out_of_stock').length;
    assert.equal(wins, 3);
    assert.equal(wins + losses + kept, 10);
    assert.equal((await GachaStock.findById('keychain:la-xanh').lean()).used, 3);
    const remaining = await User.find({ _id: { $in: students.map((s) => s.id) } }).select('pendingGachaSpins').lean();
    assert.equal(remaining.reduce((sum, user) => sum + user.pendingGachaSpins, 0), kept);
  });

  test('hết lượt thì không tốn móc khóa: yêu cầu vượt số lượt được hoàn trả', async () => {
    await publishConfig({ prizes: [PRIZE({ maxQuantity: 10 })] });
    const student = await studentWithSpins(1);
    const results = await Promise.all(Array.from({ length: 6 }, () => draw(student)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.data.code === 'no_spins').length, 5);
    assert.equal((await GachaStock.findById('keychain:la-xanh').lean()).used, 1);
  });

  test('lỗi DB đúng lúc trừ lượt: giữ móc khóa đã giữ (lệnh ghi có thể đã thành công), sinh viên giữ lượt', async () => {
    await publishConfig({ prizes: [PRIZE({ maxQuantity: 1 })] });
    const student = await studentWithSpins(1);
    const original = { update: User.findOneAndUpdate, error: console.error };
    User.findOneAndUpdate = () => Promise.reject(new Error('DB lỗi'));
    console.error = () => {};
    try {
      assert.equal((await draw(student)).status, 500);
    } finally {
      User.findOneAndUpdate = original.update;
      console.error = original.error;
    }
    assert.equal((await GachaStock.findById('keychain:la-xanh').lean()).used, 1);
    assert.equal(await spinsOf(student.id), 1);
    assert.equal((await draw(student)).data.code, 'gacha_out_of_stock');
  });

  test('client không quyết định được kết quả: giá trị gửi kèm bị bỏ qua', async () => {
    await publishConfig({ prizes: [PRIZE({ probabilityPpm: 1 })] });
    const student = await studentWithSpins(1);
    const res = await withDraw(500_000, () => draw(student, { outcome: 'win', prizeId: 'gia-mao', probabilityPpm: 1_000_000, claimCode: 'TA-AAAAA-AAAAA' }));
    assert.equal(res.data.outcome, 'lose');
    assert.equal(await GachaReward.countDocuments({ claimCode: 'TA-AAAAA-AAAAA' }), 0);
    const other = await studentWithSpins(1);
    assert.equal((await draw(other, { studentId: student.studentId })).status, 403);
  });

  test('khôi phục outbox giữ nguyên kết quả, dấu phiên bản và mã nhận quà', async () => {
    const config = await publishKeychain();
    const { id } = await studentWithSpins(0);
    const rewardId = new mongoose.Types.ObjectId();
    const entry = {
      _id: rewardId,
      studentId: 'x',
      outcome: 'win',
      prizeType: 'keychain',
      prizeId: 'la-xanh',
      prizeLabel: 'Lá xanh',
      claimCode: 'TA-23456-789AB',
      deliveryStatus: 'pending',
      configId: config._id,
      configVersion: config.version,
      createdAt: new Date(),
    };
    await User.updateOne({ _id: id }, { $push: { gachaOutbox: entry } });
    await recoverOutboxes();
    const doc = await GachaReward.findById(rewardId).lean();
    assert.deepEqual([doc.outcome, doc.claimCode, doc.deliveryStatus, doc.configVersion], ['win', 'TA-23456-789AB', 'pending', config.version]);
  });
});

async function publishKeychain() {
  const saved = await publishConfig();
  return GachaConfig.findById(saved.id).lean();
}

describe('kiểm tra khi lưu và xuất bản', () => {
  test('tổng xác suất tối đa 100%: 1.000.001 phần triệu bị từ chối, đúng 100% và dưới 100% được', async () => {
    const over = await saveDraft(await newDraft(), {
      prizes: [PRIZE({ probabilityPpm: 500_001 }), PRIZE({ prizeId: 'b', probabilityPpm: 500_000 })],
      claimInstructions: INSTRUCTIONS,
    });
    assert.equal(over.status, 200, 'nháp được lưu dù vượt 100%');
    const refused = await publish(over.data);
    assert.equal(refused.status, 400);
    assert.ok(refused.data.fields.probabilityTotal);
    await publishConfig({ prizes: [PRIZE({ probabilityPpm: 500_000 }), PRIZE({ prizeId: 'b', probabilityPpm: 500_000 })] });
    await publishConfig({ prizes: [PRIZE({ probabilityPpm: 1 })] });
  });

  test('mẫu đang bật cần xác suất > 0; mẫu tắt không tính vào tổng; cần ít nhất một mẫu bật; cần hướng dẫn nhận quà', async () => {
    await publishConfig({ prizes: [PRIZE(), PRIZE({ prizeId: 'tat', enabled: false, probabilityPpm: 300_000 })] });
    const zero = await saveDraft(await newDraft(), { prizes: [PRIZE(), PRIZE({ prizeId: 'khong', probabilityPpm: 0 })] });
    assert.ok((await publish(zero.data)).data.fields['prizes.1.probabilityPpm']);
    const none = await saveDraft(await newDraft(), { prizes: [PRIZE({ enabled: false })] });
    assert.ok((await publish(none.data)).data.fields.prizes);
    const noInstructions = await saveDraft(await newDraft(), { prizes: [PRIZE()], claimInstructions: '   ' });
    assert.ok((await publish(noInstructions.data)).data.fields.claimInstructions);
  });

  test('dữ liệu mẫu sai bị từ chối ngay khi lưu; xác suất và số lượng phải là số nguyên', async () => {
    const sticker = await createMedia('win', 'Pháo hoa');
    const draft = await newDraft();
    const cases = [
      [{ imageId: '' }, 'imageId'],
      [{ imageId: 'abc' }, 'imageId'],
      [{ imageId: '0123456789abcdef01234567' }, 'imageId'],
      [{ imageId: sticker._id.toString() }, 'imageId'],
      [{ probabilityPpm: 0.5 }, 'probabilityPpm'],
      [{ probabilityPpm: -1 }, 'probabilityPpm'],
      [{ probabilityPpm: 1_000_001 }, 'probabilityPpm'],
      [{ probabilityPpm: '1000' }, 'probabilityPpm'],
      [{ maxQuantity: null }, 'maxQuantity'],
      [{ maxQuantity: 0 }, 'maxQuantity'],
      [{ maxQuantity: 1.5 }, 'maxQuantity'],
      [{ maxQuantity: '10' }, 'maxQuantity'],
      [{ prizeId: 'Có Dấu' }, 'prizeId'],
      [{ label: '' }, 'label'],
      [{ description: 'x'.repeat(301) }, 'description'],
      // Bật/tắt phải là boolean: chuỗi "false" hay số 0 không được hiểu thành "đang bật" rồi tham gia rút thăm
      [{ enabled: 'false' }, 'enabled'],
      [{ enabled: 0 }, 'enabled'],
      [{ enabled: null }, 'enabled'],
    ];
    for (const [patch, field] of cases) {
      const res = await saveDraft(draft, { prizes: [PRIZE(patch)] });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.ok(res.data.fields[`prizes.0.${field}`], JSON.stringify(patch));
    }
    assert.ok((await saveDraft(draft, { prizes: [PRIZE(), PRIZE()] })).data.fields['prizes.1.prizeId'], 'mã giải trùng');
    assert.equal((await saveDraft(draft, { prizes: 'khong-phai-mang' })).status, 400);
    assert.equal((await saveDraft(draft, { prizes: Array.from({ length: 51 }, (_, i) => PRIZE({ prizeId: `p${i}` })) })).status, 400);
    assert.ok((await saveDraft(draft, { note: 'x'.repeat(501) })).data.fields.note);
    assert.ok((await saveDraft(draft, { claimInstructions: 'x'.repeat(501) })).data.fields.claimInstructions);
  });

  test('lưu nháp bỏ giải mã nạp cũ và ngân sách gửi kèm', async () => {
    const draft = await newDraft();
    const res = await saveDraft(draft, {
      prizes: [{ ...PRIZE(), prizeType: 'phone_topup', carrier: 'Viettel', amountVnd: 10_000 }],
      budgetVnd: 50_000,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.budgetVnd, null);
    assert.equal(res.data.prizes[0].prizeType, 'keychain');
    assert.ok(!('carrier' in res.data.prizes[0]));
  });

  test('hiệu lực: kết thúc phải sau bắt đầu; bắt đầu không ở quá khứ', async () => {
    const now = Date.now();
    const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
    const draft = await newDraft();
    assert.ok((await saveDraft(draft, { effectiveFrom: iso(3_600_000), effectiveTo: iso(1_800_000) })).data.fields.effectiveTo);
    assert.ok((await saveDraft(draft, { effectiveFrom: 'khong-phai-ngay' })).data.fields.effectiveFrom);
    const base = { prizes: [PRIZE()], claimInstructions: INSTRUCTIONS };
    const past = await saveDraft(await newDraft(), { ...base, effectiveFrom: iso(-3_600_000) });
    assert.ok((await publish(past.data)).data.fields.effectiveFrom);
    const pastEnd = await saveDraft(await newDraft(), { ...base, effectiveTo: iso(-1000) });
    assert.ok((await publish(pastEnd.data)).data.fields.effectiveTo);
  });

  test('xuất bản cần xác thực lại; người xuất bản và thời điểm được lưu; nhật ký ghi xác suất, số lượng', async () => {
    const saved = await saveDraft(await newDraft(), { prizes: [PRIZE({ probabilityPpm: 1_000 })], claimInstructions: INSTRUCTIONS });
    await expireReauth(admin.client);
    const res = await publish(saved.data);
    assert.deepEqual([res.status, res.data.code], [403, 'reauth_required']);
    assert.equal((await GachaConfig.findById(saved.data.id).lean()).status, 'draft');

    admin = await enrolledAdmin(ctx.base);
    const ok = await publish(saved.data);
    assert.equal(ok.status, 200);
    assert.ok(ok.data.publishedByLabel);
    assert.ok(ok.data.publishedAt);
    assert.equal(ok.data.isCurrent, true);
    const [entry] = await auditEntries({ action: 'gacha.config_publish', targetId: saved.data.id });
    assert.equal(entry.result, 'success');
    assert.equal(entry.meta.version, saved.data.version);
    assert.deepEqual(entry.meta.prizes, [{ prizeId: 'la-xanh', probabilityPpm: 1_000, maxQuantity: 100 }]);
  });

  test('hai người xuất bản cùng một bản nháp: một thành công, một 409; bản đã xuất bản không sửa được', async () => {
    const saved = await saveDraft(await newDraft(), { prizes: [PRIZE()], claimInstructions: INSTRUCTIONS });
    const results = await Promise.all([publish(saved.data), publish(saved.data)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const revision = results.find((r) => r.status === 200).data.revision;
    const edit = await admin.client.put(`/api/admin/gacha/configs/${saved.data.id}`, { json: { prizes: [PRIZE()], revision } });
    assert.equal(edit.data.code, 'not_draft');
    const discard = await admin.client.post(`/api/admin/gacha/configs/${saved.data.id}/discard`, { json: { revision } });
    assert.equal(discard.data.code, 'not_draft');
  });

  test('sửa nháp bằng bản đã mở cũ → 409', async () => {
    const draft = await newDraft();
    assert.equal((await saveDraft(draft, { note: 'lần một' })).status, 200);
    assert.equal((await saveDraft(draft, { note: 'lần hai' })).data.code, 'version_conflict');
  });

  test('số phiên bản không trùng khi nhiều người tạo nháp đồng thời', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => admin.client.post('/api/admin/gacha/configs', { json: {} })));
    assert.deepEqual(results.map((r) => r.status), Array(5).fill(201));
    assert.equal(new Set(results.map((r) => r.data.version)).size, 5);
  });

  test('tạo nháp từ phiên bản không tồn tại báo 404; bản nháp mới sao mẫu và hướng dẫn của bản đang hiệu lực', async () => {
    const current = await publishConfig();
    const before = await GachaConfig.countDocuments();
    assert.equal((await admin.client.post('/api/admin/gacha/configs', { json: { basedOnId: '0123456789abcdef01234567' } })).status, 404);
    assert.equal((await admin.client.post('/api/admin/gacha/configs', { json: { basedOnId: { $ne: null } } })).status, 400);
    assert.equal(await GachaConfig.countDocuments(), before);
    const copy = await newDraft();
    assert.equal(copy.basedOnVersion, current.version);
    assert.equal(copy.claimInstructions, INSTRUCTIONS);
    assert.deepEqual(copy.prizes.map((p) => [p.prizeId, p.imageId, p.probabilityPpm]), [['la-xanh', image.id, 1_000_000]]);
  });

  test('hủy bản nháp: không còn trong danh sách, không ảnh hưởng bản đang hiệu lực', async () => {
    const current = await publishConfig();
    const draft = await newDraft();
    assert.equal((await admin.client.post(`/api/admin/gacha/configs/${draft.id}/discard`, { json: { revision: draft.revision } })).status, 200);
    const list = (await admin.client.get('/api/admin/gacha/configs')).data;
    assert.ok(!list.items.some((item) => item.id === draft.id));
    assert.equal((await getActiveGachaConfig()).version, current.version);
  });
});

describe('thời điểm hiệu lực', () => {
  test('bản hẹn giờ chưa có tác dụng trước giờ bắt đầu, có tác dụng sau đó', async () => {
    const first = await publishConfig();
    const from = new Date(Date.now() + 60 * 60 * 1000);
    const scheduled = await publishConfig({ effectiveFrom: from.toISOString() });
    assert.equal(scheduled.isCurrent, false);
    assert.equal((await getActiveGachaConfig()).version, first.version);
    assert.equal((await getActiveGachaConfig(new Date(from.getTime() + 1000))).version, scheduled.version);
  });

  test('hết hạn thì quay về bản còn hiệu lực gần nhất', async () => {
    const first = await publishConfig();
    const until = new Date(Date.now() + 60 * 60 * 1000);
    const limited = await publishConfig({ effectiveTo: until.toISOString() });
    assert.equal((await getActiveGachaConfig()).version, limited.version);
    assert.equal((await getActiveGachaConfig(new Date(until.getTime() + 1000))).version, first.version);
  });

  test('ngừng hiệu lực sớm cần xác thực lại; không còn bản nào thì tạm dừng, không mất lượt', async () => {
    const current = await publishConfig();
    await expireReauth(admin.client);
    assert.equal((await admin.client.post(`/api/admin/gacha/configs/${current.id}/end`)).data.code, 'reauth_required');

    admin = await enrolledAdmin(ctx.base);
    const ended = await admin.client.post(`/api/admin/gacha/configs/${current.id}/end`);
    assert.equal(ended.status, 200);
    assert.equal(ended.data.isCurrent, false);
    assert.equal((await admin.client.post(`/api/admin/gacha/configs/${current.id}/end`)).data.code, 'not_in_effect');

    const student = await studentWithSpins(1);
    assert.deepEqual([(await draw(student)).status, await spinsOf(student.id)], [503, 1]);
  });
});

describe('phân bố xác suất', () => {
  test('tỉ lệ thực tế nằm trong khoảng tin cậy của xác suất cấu hình, phần còn lại là không trúng', () => {
    const prizes = [
      { prizeId: 'a', probabilityPpm: 100_000 },
      { prizeId: 'b', probabilityPpm: 200_000 },
    ];
    const rolls = 50_000;
    const counts = { a: 0, b: 0, none: 0 };
    for (let i = 0; i < rolls; i += 1) counts[drawPrize(prizes)?.prizeId ?? 'none'] += 1;
    // Nhị thức: độ lệch chuẩn ≈ √(n·p·(1−p)); 6 lần độ lệch chuẩn gần như không thể rơi ngoài do ngẫu nhiên
    for (const [key, p] of [['a', 0.1], ['b', 0.2], ['none', 0.7]]) {
      const sd = Math.sqrt(rolls * p * (1 - p));
      assert.ok(Math.abs(counts[key] - rolls * p) < 6 * sd, `${key}: ${counts[key]}`);
    }
  });
});

describe('xem cấu hình', () => {
  test('danh sách phân trang, đánh dấu bản đang hiệu lực; chi tiết có lượt trúng theo mẫu, lượt không trúng, số đã trúng chung', async () => {
    await publishConfig({ prizes: [PRIZE({ maxQuantity: 5 })] });
    const current = await publishConfig({ prizes: [PRIZE({ probabilityPpm: 500_000, maxQuantity: 5 })] });
    const list = (await admin.client.get('/api/admin/gacha/configs?pageSize=1')).data;
    assert.equal(list.items.length, 1);
    assert.equal(list.total, 2);
    assert.equal(list.items[0].id, current.id);
    assert.equal(list.currentId, current.id);

    const student = await studentWithSpins(3);
    await withDraw(0, () => draw(student));
    await withDraw(10, () => draw(student));
    await withDraw(999_999, () => draw(student));
    const detail = (await admin.client.get(`/api/admin/gacha/configs/${current.id}`)).data;
    assert.deepEqual(detail.issued.map(({ prizeId, count }) => [prizeId, count]), [['la-xanh', 2]]);
    assert.deepEqual(detail.spins, { total: 3, wins: 2, losses: 1 });
    assert.deepEqual(detail.usage, [{ prizeId: 'la-xanh', used: 2 }]);
    assert.equal(detail.prizes[0].imageUrl, `/api/gacha/media/${image.id}`);
    assert.equal((await admin.client.get('/api/admin/gacha/configs/abc')).status, 404);
    assert.equal((await admin.client.get('/api/admin/gacha/configs/0123456789abcdef01234567')).status, 404);
  });

  test('phiên bản mã nạp cũ vẫn xem được với các trường cũ', async () => {
    const { insertedId } = await legacyTopUpConfig();
    const detail = (await admin.client.get(`/api/admin/gacha/configs/${insertedId}`)).data;
    assert.equal(detail.legacy, true);
    assert.deepEqual([detail.prizes[0].carrier, detail.prizes[0].amountVnd, detail.prizes[0].legacy], ['Viettel', 10_000, true]);
  });
});

describe('ảnh & sticker', () => {
  test('tải ảnh PNG: lưu thành WebP, phục vụ công khai dạng image/webp có cache; nhật ký ghi lại', async () => {
    const res = await admin.client.post('/api/admin/gacha/media', { form: imageForm(await pngImage({ r: 200, g: 50, b: 50 }, 40)) });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.deepEqual([res.data.kind, res.data.name, res.data.width, res.data.height, res.data.animated], ['keychain', 'Lá xanh', 40, 40, false]);
    const served = await realFetch(ctx.base + res.data.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/webp');
    assert.match(served.headers.get('cache-control'), /public/);
    assert.equal((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).format, 'webp');
    const [entry] = await auditEntries({ action: 'gacha.media_create', targetId: res.data.id });
    assert.equal(entry.result, 'success');
  });

  test('GIF động giữ chuyển động sau khi nén lại', async () => {
    const res = await admin.client.post('/api/admin/gacha/media', { form: imageForm(await animatedGif(), { kind: 'win', name: 'Pháo hoa', filename: 'phao-hoa.gif', type: 'image/gif' }) });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.animated, true);
    const served = Buffer.from(await (await realFetch(ctx.base + res.data.url)).arrayBuffer());
    const meta = await sharp(served, { animated: true }).metadata();
    assert.deepEqual([meta.format, meta.pages], ['webp', 3]);
  });

  test('tệp không phải ảnh bị từ chối theo nội dung; loại và tên sai báo đúng trường; sinh viên không tải được', async () => {
    const fake = await admin.client.post('/api/admin/gacha/media', { form: imageForm(Buffer.from('không phải ảnh'), { filename: 'gia.png' }) });
    assert.deepEqual([fake.status, fake.data.code], [415, 'image_type_unsupported']);
    const badKind = await admin.client.post('/api/admin/gacha/media', { form: imageForm(await pngImage(), { kind: 'khac' }) });
    assert.ok(badKind.data.fields.kind);
    const noName = await admin.client.post('/api/admin/gacha/media', { form: imageForm(await pngImage(), { name: '  ' }) });
    assert.ok(noName.data.fields.name);
    const student = await studentWithSpins(0);
    assert.equal((await student.client.post('/api/admin/gacha/media', { form: imageForm(await pngImage()) })).status, 401);
    assert.equal(await GachaMedia.countDocuments(), 1, 'chỉ còn ảnh tạo sẵn');
  });

  test('đổi tên, bật/tắt; sticker đang tắt không được chọn cho màn hình kết quả', async () => {
    await publishConfig();
    const on = await createMedia('win', 'Pháo hoa');
    const off = await createMedia('win', 'Ngôi sao', false);
    const student = await studentWithSpins(3);
    for (let i = 0; i < 2; i += 1) assert.equal((await draw(student)).data.sticker.url, `/api/gacha/media/${on._id}`);

    const renamed = await admin.client.patch(`/api/admin/gacha/media/${off._id}`, { json: { name: 'Ngôi sao vàng', active: true } });
    assert.deepEqual([renamed.data.name, renamed.data.active], ['Ngôi sao vàng', true]);
    await admin.client.patch(`/api/admin/gacha/media/${on._id}`, { json: { active: false } });
    assert.equal((await draw(student)).data.sticker.name, 'Ngôi sao vàng');
    assert.ok((await admin.client.patch(`/api/admin/gacha/media/${on._id}`, { json: { name: '' } })).data.fields.name);
    assert.equal((await admin.client.patch(`/api/admin/gacha/media/${on._id}`, { json: { active: 'co' } })).status, 400);
  });

  test('chưa có sticker: kết quả không kèm sticker để giao diện dùng hình mặc định', async () => {
    await publishConfig();
    const res = await draw(await studentWithSpins(1));
    assert.equal(res.data.sticker, null);
  });

  test('xóa: ảnh móc khóa đang dùng ở bản nháp hoặc phiên bản còn hiệu lực bị chặn; không còn dùng thì xóa được', async () => {
    const current = await publishConfig();
    const blocked = await admin.client.del(`/api/admin/gacha/media/${image.id}`);
    assert.deepEqual([blocked.status, blocked.data.code], [409, 'media_in_use']);

    admin = await enrolledAdmin(ctx.base);
    await admin.client.post(`/api/admin/gacha/configs/${current.id}/end`);
    const draft = await newDraft();
    assert.equal((await admin.client.del(`/api/admin/gacha/media/${image.id}`)).data.code, 'media_in_use', 'bản nháp vừa sao vẫn dùng');
    await admin.client.post(`/api/admin/gacha/configs/${draft.id}/discard`, { json: { revision: draft.revision } });

    assert.equal((await admin.client.del(`/api/admin/gacha/media/${image.id}`)).status, 200);
    assert.equal((await realFetch(`${ctx.base}/api/gacha/media/${image.id}`)).status, 404);
    assert.equal((await realFetch(`${ctx.base}/api/gacha/media/khong-hop-le`)).status, 404);
    const [entry] = await auditEntries({ action: 'gacha.media_delete', result: 'success' });
    assert.equal(entry.targetId, image.id);
  });
});

describe('trao quà', () => {
  async function winner() {
    const student = await studentWithSpins(1);
    const res = await withDraw(0, () => draw(student));
    assert.equal(res.data.outcome, 'win');
    return { ...student, claimCode: res.data.prize.claimCode, rewardId: res.data.rewardId };
  }

  test('danh sách chỉ có lượt trúng móc khóa, che mã sinh viên, tìm theo đúng nguyên mã', async () => {
    await publishConfig({ prizes: [PRIZE({ probabilityPpm: 500_000 })] });
    const first = await winner();
    await winner();
    const loser = await studentWithSpins(1);
    await withDraw(999_999, () => draw(loser));

    const list = (await admin.client.get('/api/admin/gacha/rewards')).data;
    assert.equal(list.total, 2);
    assert.equal(list.pending, 2);
    const row = list.items.find((item) => item.id === first.rewardId);
    assert.equal(row.claimCode, first.claimCode);
    assert.notEqual(row.winner.studentId, first.studentId);
    assert.ok(!JSON.stringify(list).includes(first.studentId));

    const spaced = `  ${first.claimCode.toLowerCase().replace('-', ' - ')} `;
    assert.deepEqual((await admin.client.get(`/api/admin/gacha/rewards?q=${encodeURIComponent(spaced)}&status=`)).data.items.map((i) => i.id), [first.rewardId]);
    assert.equal((await admin.client.get(`/api/admin/gacha/rewards?q=${first.claimCode.slice(0, 8)}`)).data.total, 0, 'không tìm theo một phần mã');
  });

  test('xác nhận đã trao rồi hoàn tác; sinh viên thấy trạng thái; mọi thao tác ghi nhật ký', async () => {
    await publishConfig();
    const won = await winner();
    const delivered = await admin.client.post(`/api/admin/gacha/rewards/${won.rewardId}/deliver`, { json: { note: 'Đã đối chiếu thẻ SV' } });
    assert.equal(delivered.status, 200);
    assert.equal(delivered.data.deliveryStatus, 'delivered');
    assert.ok(delivered.data.deliveredByLabel);
    assert.equal(delivered.data.deliveryNote, 'Đã đối chiếu thẻ SV');
    assert.equal((await admin.client.post(`/api/admin/gacha/rewards/${won.rewardId}/deliver`, { json: {} })).data.code, 'already_delivered');

    const results = (await won.client.get('/api/gacha/results')).data;
    assert.equal(results.rewards[0].deliveryStatus, 'delivered');
    assert.ok(results.rewards[0].deliveredAt);

    assert.ok((await admin.client.post(`/api/admin/gacha/rewards/${won.rewardId}/undeliver`, { json: {} })).data.fields.reason);
    const undone = await admin.client.post(`/api/admin/gacha/rewards/${won.rewardId}/undeliver`, { json: { reason: 'Bấm nhầm người' } });
    assert.equal(undone.data.deliveryStatus, 'pending');
    assert.equal(undone.data.deliveredAt, null);
    assert.equal((await admin.client.post(`/api/admin/gacha/rewards/${won.rewardId}/undeliver`, { json: { reason: 'lần nữa' } })).data.code, 'not_delivered');
    assert.equal((await admin.client.post('/api/admin/gacha/rewards/0123456789abcdef01234567/deliver', { json: {} })).status, 404);

    const actions = (await auditEntries({ targetId: won.rewardId })).map((entry) => `${entry.action}:${entry.result}`);
    assert.ok(actions.includes('gacha.reward_deliver:success'));
    assert.ok(actions.includes('gacha.reward_undeliver:success'));
  });
});

describe('thể lệ công khai (/api/gacha/rules)', () => {
  const rules = () => createClient(ctx.base).get('/api/gacha/rules', { csrf: false });

  test('không cần đăng nhập; trả đúng bản đang hiệu lực, không lộ ghi chú, người xuất bản hay mã giải', async () => {
    const config = await publishConfig({ note: 'ghi chú nội bộ', prizes: [PRIZE({ probabilityPpm: 2_500 })] });
    const res = await rules();
    assert.equal(res.status, 200);
    assert.equal(res.data.active, true);
    assert.equal(res.data.version, config.version);
    assert.equal(res.data.claimInstructions, INSTRUCTIONS);
    assert.deepEqual(res.data.prizes, [
      { label: 'Lá xanh', description: 'Móc khóa hình lá', imageUrl: `/api/gacha/media/${image.id}`, probabilityPpm: 2_500, maxQuantity: 100, remaining: 100, available: true },
    ]);
    assert.doesNotMatch(JSON.stringify(res.data), /ghi chú nội bộ|kiểm thử|publishedBy|createdBy|prizeId/);
  });

  test('mẫu tắt không hiện; số còn lại và trạng thái hết theo số đã trúng dùng chung', async () => {
    await publishConfig({
      prizes: [
        PRIZE({ prizeId: 'hiem', label: 'Hiếm', probabilityPpm: 1_000, maxQuantity: 1 }),
        PRIZE({ prizeId: 're', label: 'Thường', probabilityPpm: 100_000, maxQuantity: 5 }),
        PRIZE({ prizeId: 'tat', label: 'Tắt', enabled: false, probabilityPpm: 0 }),
      ],
    });
    await GachaStock.collection.insertOne({ _id: 'keychain:hiem', used: 1 });
    const { data } = await rules();
    assert.deepEqual(
      data.prizes.map(({ label, remaining, available }) => [label, remaining, available]),
      [
        ['Hiếm', 0, false],
        ['Thường', 5, true],
      ]
    );
  });

  test('không còn bản nào hiệu lực: báo tạm dừng, không tự tạo cấu hình mới', async () => {
    const current = await publishConfig();
    assert.equal((await admin.client.post(`/api/admin/gacha/configs/${current.id}/end`)).status, 200);
    const count = await GachaConfig.countDocuments();
    assert.deepEqual((await rules()).data, { active: false, prizes: [] });
    assert.equal(await GachaConfig.countDocuments(), count);
  });
});

describe('kết quả của sinh viên và bản PWA cũ', () => {
  test('kết quả: liệt kê lượt trúng và mã nạp demo cũ, đếm cả lượt không trúng', async () => {
    await publishConfig({ prizes: [PRIZE({ probabilityPpm: 500_000 })] });
    const student = await studentWithSpins(2);
    await GachaReward.collection.insertOne({ userId: new mongoose.Types.ObjectId(student.id), studentId: 'x', amountVnd: 10000, carrier: 'Viettel', topUpCode: 'GC-10K-CU', createdAt: new Date(Date.now() - 60_000) });
    const won = await withDraw(0, () => draw(student));
    await withDraw(999_999, () => draw(student));

    const { data } = await student.client.get('/api/gacha/results');
    assert.deepEqual(data.stats, { spins: 3, wins: 1 });
    assert.deepEqual(data.rewards.map((r) => r.type), ['keychain', 'phone_topup']);
    assert.equal(data.rewards[0].claimCode, won.data.prize.claimCode);
    assert.equal(data.rewards[0].claimInstructions, INSTRUCTIONS);
    assert.equal(data.rewards[0].deliveryStatus, 'pending');
    assert.equal(data.rewards[1].topUpCode, 'GC-10K-CU');
  });

  test('bản PWA cũ: /spin báo tải lại trang và giữ lượt; /rewards chỉ trả mã nạp demo cũ', async () => {
    await publishConfig();
    const student = await studentWithSpins(2);
    await GachaReward.collection.insertOne({ userId: new mongoose.Types.ObjectId(student.id), studentId: 'x', amountVnd: 20000, carrier: 'Mobifone', topUpCode: 'GC-20K-CU', createdAt: new Date() });
    await draw(student);
    const old = await student.client.post('/api/gacha/spin');
    assert.deepEqual([old.status, old.data.code], [409, 'client_outdated']);
    assert.equal(await spinsOf(student.id), 1);
    const legacy = (await student.client.get('/api/gacha/rewards')).data;
    assert.deepEqual(legacy.rewards.map((r) => [r.topUpCode, r.amountVnd]), [['GC-20K-CU', 20000]]);
  });
});

describe('migration từ mã nạp demo', () => {
  test('phiên bản mã nạp đang hiệu lực bị ngừng, không xóa; chạy lại không đổi gì', async () => {
    const { insertedId } = await legacyTopUpConfig();
    await SystemMarker.deleteOne({ _id: 'migration:2026-11-gacha-keychain' });
    assert.ok((await runMigrations()).includes('2026-11-gacha-keychain'));
    const ended = await GachaConfig.findById(insertedId).lean();
    assert.ok(ended.effectiveTo <= new Date());
    assert.match(ended.endedByLabel, /chuyển sang móc khóa/);
    assert.equal(await getActiveGachaConfig(), null);
    assert.deepEqual(await runMigrations(), []);
    assert.equal(await GachaConfig.countDocuments(), 1);
  });
});
