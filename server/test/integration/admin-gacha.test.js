// Cấu hình Gacha theo phiên bản: kiểm tra xác suất, hiệu lực, kho, ngân sách, dấu phiên bản trên phần thưởng, đồng thời
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { User } from '../../src/models/User.js';
import { GachaConfig } from '../../src/models/GachaConfig.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { GachaStock } from '../../src/models/GachaStock.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { DEFAULT_PRIZES, pickPrize } from '../../src/services/gacha.js';
import { ensureDefaultGachaConfig, getActiveGachaConfig, reservePrize } from '../../src/services/gachaConfig.js';
import { recoverOutboxes } from '../../src/services/rewards.js';
import { createClient, registerUser, setEnv, startTestServer } from '../helpers.js';
import { ADMIN_ENV, auditEntries, enrolledAdmin, expireReauth } from '../adminHelpers.js';

let ctx;
let admin;

const PRIZE = (overrides = {}) => ({
  prizeId: 'topup-10k',
  label: 'Mã nạp điện thoại',
  carrier: 'Viettel',
  amountVnd: 10_000,
  probabilityPpm: 1_000_000,
  enabled: true,
  maxQuantity: null,
  ...overrides,
});

async function studentWithSpins(spins) {
  const client = createClient(ctx.base);
  const res = await registerUser(client);
  await User.updateOne({ _id: res.data.user.id }, { $set: { pendingGachaSpins: spins } });
  return { client, id: res.data.user.id };
}

const newDraft = async () => (await admin.client.post('/api/admin/gacha/configs', { json: {} })).data;
const saveDraft = (draft, patch) =>
  admin.client.put(`/api/admin/gacha/configs/${draft.id}`, {
    json: { prizes: draft.prizes, budgetVnd: draft.budgetVnd, note: draft.note, effectiveFrom: draft.effectiveFrom, effectiveTo: draft.effectiveTo, revision: draft.revision, ...patch },
  });
const publish = (config) => admin.client.post(`/api/admin/gacha/configs/${config.id}/publish`, { json: { revision: config.revision } });

/** Tạo, lưu và xuất bản một cấu hình mới, có hiệu lực ngay */
async function publishConfig(patch) {
  const saved = await saveDraft(await newDraft(), patch);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const res = await publish(saved.data);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
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
  await GachaConfig.collection.deleteMany({});
  await GachaStock.collection.deleteMany({});
  await GachaReward.collection.deleteMany({});
  await ensureDefaultGachaConfig();
});

describe('cấu hình mặc định', () => {
  test('phiên bản 1 giữ nguyên bộ giải cũ: 12 giải, tổng đúng 100%, mọi giải bật', async () => {
    const config = await getActiveGachaConfig();
    assert.equal(config.version, 1);
    assert.equal(config.prizes.length, 12);
    assert.equal(config.prizes.reduce((sum, prize) => sum + prize.probabilityPpm, 0), 1_000_000);
    assert.deepEqual([...new Set(config.prizes.map((p) => p.amountVnd))], [10_000, 20_000, 50_000]);
    const spread = config.prizes.map((p) => p.probabilityPpm);
    assert.ok(Math.max(...spread) - Math.min(...spread) <= 1, 'đồng xác suất, lệch tối đa 1 phần triệu');
  });

  test('tạo mặc định chạy lại hoặc chạy đồng thời vẫn chỉ có một bản', async () => {
    await Promise.all([ensureDefaultGachaConfig(), ensureDefaultGachaConfig(), ensureDefaultGachaConfig()]);
    assert.equal(await GachaConfig.countDocuments(), 1);
    await GachaConfig.collection.deleteMany({});
    await Promise.all(Array.from({ length: 5 }, () => ensureDefaultGachaConfig()));
    assert.equal(await GachaConfig.countDocuments(), 1);
  });

  test('DB chưa có cấu hình: lượt quay đầu tiên tự tạo phiên bản 1 và hoạt động như cũ', async () => {
    await GachaConfig.collection.deleteMany({});
    const { client } = await studentWithSpins(1);
    const res = await client.post('/api/gacha/spin');
    assert.equal(res.status, 200);
    assert.match(res.data.prize.topUpCode, /^GC-(10|20|50)K-[0-9A-F]{8}$/);
    assert.equal(res.data.prize.label, 'Mã nạp điện thoại');
  });
});

describe('dấu phiên bản trên phần thưởng', () => {
  test('mỗi phần thưởng lưu đúng id, phiên bản và mã giải của cấu hình đã tạo ra nó', async () => {
    const first = await studentWithSpins(2);
    await first.client.post('/api/gacha/spin');
    const v2 = await publishConfig({ prizes: [PRIZE({ prizeId: 'chi-50k', amountVnd: 50_000, carrier: 'Mobifone' })] });
    const res = await first.client.post('/api/gacha/spin');
    assert.equal(res.data.prize.amountVnd, 50_000);

    const rewards = await GachaReward.find({ userId: first.id }).sort({ createdAt: 1 }).lean();
    assert.deepEqual(rewards.map((r) => r.configVersion), [1, v2.version]);
    assert.equal(String(rewards[1].configId), v2.id);
    assert.equal(rewards[1].prizeId, 'chi-50k');
    assert.equal(rewards[1].carrier, 'Mobifone');
    assert.ok(DEFAULT_PRIZES.some((p) => p.prizeId === rewards[0].prizeId));
  });

  test('dấu phiên bản còn nguyên sau khôi phục outbox', async () => {
    const { id } = await studentWithSpins(1);
    const config = await getActiveGachaConfig();
    const rewardId = new mongoose.Types.ObjectId();
    await User.updateOne(
      { _id: id },
      { $push: { gachaOutbox: { _id: rewardId, studentId: 'x', carrier: 'Viettel', amountVnd: 10000, topUpCode: 'GC-10K-TEST', configId: config._id, configVersion: config.version, prizeId: 'p', createdAt: new Date() } } }
    );
    await recoverOutboxes();
    const doc = await GachaReward.findById(rewardId).lean();
    assert.equal(doc.configVersion, config.version);
    assert.equal(String(doc.configId), String(config._id));
  });

  test('client không quyết định được kết quả: giá trị gửi kèm bị bỏ qua', async () => {
    await publishConfig({ prizes: [PRIZE()] });
    const { client } = await studentWithSpins(1);
    const res = await client.post('/api/gacha/spin', { json: { amountVnd: 10_000_000, prizeId: 'gia-mao', configVersion: 99, probabilityPpm: 1 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.prize.amountVnd, 10_000);
  });
});

describe('kiểm tra khi xuất bản', () => {
  test('tổng xác suất khác đúng 100% bị từ chối; biên 999.999 / 1.000.001 phần triệu', async () => {
    for (const total of [999_999, 1_000_001]) {
      const prizes = [PRIZE({ probabilityPpm: total - 500_000 }), PRIZE({ prizeId: 'b', probabilityPpm: 500_000 })];
      const saved = await saveDraft(await newDraft(), { prizes });
      assert.equal(saved.status, 200, 'nháp được lưu dù chưa đủ 100%');
      const res = await publish(saved.data);
      assert.equal(res.status, 400, String(total));
      assert.ok(res.data.fields.probabilityTotal, String(total));
    }
    assert.equal(await GachaConfig.countDocuments({ status: 'published' }), 1, 'không có phiên bản mới nào được xuất bản');
  });

  test('giải đang tắt không tính vào tổng; giải đang bật có xác suất 0 bị từ chối; phải có ít nhất một giải bật', async () => {
    const okPrizes = [PRIZE(), PRIZE({ prizeId: 'tat', enabled: false, probabilityPpm: 300_000 })];
    assert.equal((await publishConfig({ prizes: okPrizes })).status, 'published');

    const zero = await saveDraft(await newDraft(), { prizes: [PRIZE(), PRIZE({ prizeId: 'khong', probabilityPpm: 0 })] });
    assert.ok((await publish(zero.data)).data.fields['prizes.1.probabilityPpm']);

    const none = await saveDraft(await newDraft(), { prizes: [PRIZE({ enabled: false })] });
    assert.ok((await publish(none.data)).data.fields.prizes);
  });

  test('dữ liệu giải sai bị từ chối ngay khi lưu; tiền và xác suất phải là số nguyên', async () => {
    const draft = await newDraft();
    const cases = [
      [{ amountVnd: 10_000.5 }, 'amountVnd'],
      [{ amountVnd: 999 }, 'amountVnd'],
      [{ amountVnd: 10_500 }, 'amountVnd'],
      [{ amountVnd: 10_001_000 }, 'amountVnd'],
      [{ amountVnd: '10000' }, 'amountVnd'],
      [{ probabilityPpm: 0.5 }, 'probabilityPpm'],
      [{ probabilityPpm: -1 }, 'probabilityPpm'],
      [{ probabilityPpm: 1_000_001 }, 'probabilityPpm'],
      [{ maxQuantity: 0 }, 'maxQuantity'],
      [{ maxQuantity: 1.5 }, 'maxQuantity'],
      [{ prizeId: 'Có Dấu' }, 'prizeId'],
      [{ label: '' }, 'label'],
      [{ carrier: 'x'.repeat(41) }, 'carrier'],
    ];
    for (const [patch, field] of cases) {
      const res = await saveDraft(draft, { prizes: [PRIZE(patch)] });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.ok(res.data.fields[`prizes.0.${field}`], JSON.stringify(patch));
    }
    assert.ok((await saveDraft(draft, { prizes: [PRIZE(), PRIZE()] })).data.fields['prizes.1.prizeId'], 'mã giải trùng');
    assert.equal((await saveDraft(draft, { prizes: 'khong-phai-mang' })).status, 400);
    assert.equal((await saveDraft(draft, { prizes: Array.from({ length: 51 }, (_, i) => PRIZE({ prizeId: `p${i}` })) })).status, 400);
    assert.ok((await saveDraft(draft, { budgetVnd: 1.5 })).data.fields.budgetVnd);
    assert.ok((await saveDraft(draft, { note: 'x'.repeat(501) })).data.fields.note);
  });

  test('hiệu lực: kết thúc phải sau bắt đầu; bắt đầu không ở quá khứ; ngân sách nhỏ hơn giải rẻ nhất bị từ chối', async () => {
    const now = Date.now();
    const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
    const draft = await newDraft();
    assert.ok((await saveDraft(draft, { effectiveFrom: iso(3_600_000), effectiveTo: iso(1_800_000) })).data.fields.effectiveTo);
    assert.ok((await saveDraft(draft, { effectiveFrom: 'khong-phai-ngay' })).data.fields.effectiveFrom);

    const past = await saveDraft(await newDraft(), { prizes: [PRIZE()], effectiveFrom: iso(-3_600_000) });
    assert.ok((await publish(past.data)).data.fields.effectiveFrom);
    const pastEnd = await saveDraft(await newDraft(), { prizes: [PRIZE()], effectiveTo: iso(-1000) });
    assert.ok((await publish(pastEnd.data)).data.fields.effectiveTo);
    const poor = await saveDraft(await newDraft(), { prizes: [PRIZE()], budgetVnd: 5000 });
    assert.ok((await publish(poor.data)).data.fields.budgetVnd);
  });

  test('xuất bản cần xác thực lại; người xuất bản và thời điểm được lưu; nhật ký ghi lại', async () => {
    const saved = await saveDraft(await newDraft(), { prizes: [PRIZE()] });
    await expireReauth(admin.client);
    const res = await publish(saved.data);
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'reauth_required');
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
  });

  test('hai người xuất bản cùng một bản nháp: một thành công, một 409; bản đã xuất bản không sửa được', async () => {
    const saved = await saveDraft(await newDraft(), { prizes: [PRIZE()] });
    const results = await Promise.all([publish(saved.data), publish(saved.data)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const edit = await admin.client.put(`/api/admin/gacha/configs/${saved.data.id}`, { json: { prizes: [PRIZE()], revision: results.find((r) => r.status === 200).data.revision } });
    assert.equal(edit.status, 409);
    assert.equal(edit.data.code, 'not_draft');
    const discard = await admin.client.post(`/api/admin/gacha/configs/${saved.data.id}/discard`, { json: { revision: 1 } });
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

  test('tạo nháp từ phiên bản không tồn tại: báo 404, không âm thầm dùng bộ giải mặc định', async () => {
    const before = await GachaConfig.countDocuments();
    const res = await admin.client.post('/api/admin/gacha/configs', { json: { basedOnId: '0123456789abcdef01234567' } });
    assert.equal(res.status, 404);
    assert.equal(await GachaConfig.countDocuments(), before);
    assert.equal((await admin.client.post('/api/admin/gacha/configs', { json: { basedOnId: { $ne: null } } })).status, 400);
  });

  test('hủy bản nháp: không còn trong danh sách, không ảnh hưởng bản đang hiệu lực', async () => {
    const draft = await newDraft();
    assert.equal((await admin.client.post(`/api/admin/gacha/configs/${draft.id}/discard`, { json: { revision: draft.revision } })).status, 200);
    const list = (await admin.client.get('/api/admin/gacha/configs')).data;
    assert.ok(!list.items.some((item) => item.id === draft.id));
    assert.equal((await getActiveGachaConfig()).version, 1);
  });
});

describe('thời điểm hiệu lực', () => {
  test('bản hẹn giờ chưa có tác dụng trước giờ bắt đầu, có tác dụng sau đó', async () => {
    const from = new Date(Date.now() + 60 * 60 * 1000);
    const scheduled = await publishConfig({ prizes: [PRIZE()], effectiveFrom: from.toISOString() });
    assert.equal(scheduled.isCurrent, false);
    assert.equal((await getActiveGachaConfig()).version, 1);
    assert.equal((await getActiveGachaConfig(new Date(from.getTime() + 1000))).version, scheduled.version);
  });

  test('hết hạn thì quay về bản còn hiệu lực gần nhất', async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000);
    const limited = await publishConfig({ prizes: [PRIZE()], effectiveTo: until.toISOString() });
    assert.equal((await getActiveGachaConfig()).version, limited.version);
    assert.equal((await getActiveGachaConfig(new Date(until.getTime() + 1000))).version, 1);
  });

  test('ngừng hiệu lực sớm cần xác thực lại; không còn bản nào thì Gacha tạm dừng, không mất lượt', async () => {
    const list = (await admin.client.get('/api/admin/gacha/configs')).data;
    const current = list.items.find((item) => item.isCurrent);
    await expireReauth(admin.client);
    assert.equal((await admin.client.post(`/api/admin/gacha/configs/${current.id}/end`)).data.code, 'reauth_required');

    admin = await enrolledAdmin(ctx.base);
    const ended = await admin.client.post(`/api/admin/gacha/configs/${current.id}/end`);
    assert.equal(ended.status, 200);
    assert.equal(ended.data.isCurrent, false);
    assert.equal((await admin.client.post(`/api/admin/gacha/configs/${current.id}/end`)).data.code, 'not_in_effect');

    const { client, id } = await studentWithSpins(1);
    const res = await client.post('/api/gacha/spin');
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'gacha_not_configured');
    assert.equal((await User.findById(id).lean()).pendingGachaSpins, 1, 'lượt được giữ');
  });
});

describe('giới hạn kho và ngân sách', () => {
  test('kho giới hạn không bao giờ phát vượt, kể cả khi nhiều người quay đồng thời; lượt của người không nhận được giải được giữ', async () => {
    const config = await publishConfig({ prizes: [PRIZE({ maxQuantity: 3 })] });
    const students = await Promise.all(Array.from({ length: 10 }, () => studentWithSpins(1)));
    const results = await Promise.all(students.map((s) => s.client.post('/api/gacha/spin')));
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    assert.equal(results.filter((r) => r.status === 409 && r.data.code === 'gacha_out_of_stock').length, 7);
    assert.equal(await GachaReward.countDocuments({ configVersion: config.version }), 3);
    const remaining = await User.find({ _id: { $in: students.map((s) => s.id) } }).select('pendingGachaSpins').lean();
    assert.equal(remaining.reduce((sum, user) => sum + user.pendingGachaSpins, 0), 7);
  });

  test('giải hết kho thì rút trong các giải còn lại', async () => {
    await publishConfig({
      prizes: [PRIZE({ prizeId: 'hiem', amountVnd: 50_000, probabilityPpm: 900_000, maxQuantity: 1 }), PRIZE({ prizeId: 'nhieu', probabilityPpm: 100_000 })],
    });
    const { client } = await studentWithSpins(6);
    const amounts = [];
    for (let i = 0; i < 6; i += 1) amounts.push((await client.post('/api/gacha/spin')).data.prize.amountVnd);
    assert.equal(amounts.filter((a) => a === 50_000).length, 1);
    assert.equal(amounts.filter((a) => a === 10_000).length, 5);
  });

  test('ngân sách là trần tuyệt đối theo tổng mệnh giá (số nguyên VND), kể cả đồng thời', async () => {
    const config = await publishConfig({ prizes: [PRIZE()], budgetVnd: 30_000 });
    const students = await Promise.all(Array.from({ length: 8 }, () => studentWithSpins(1)));
    const results = await Promise.all(students.map((s) => s.client.post('/api/gacha/spin')));
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    const detail = (await admin.client.get(`/api/admin/gacha/configs/${config.id}`)).data;
    assert.equal(detail.budgetUsedVnd, 30_000);
    assert.deepEqual(detail.issued.map(({ count, faceValueVnd }) => [count, faceValueVnd]), [[3, 30_000]]);
  });

  test('hết ngân sách cho giải đắt thì vẫn phát giải rẻ còn vừa; hoàn trả khi trừ lượt thất bại', async () => {
    const config = await publishConfig({
      prizes: [PRIZE({ prizeId: 'dat', amountVnd: 50_000, probabilityPpm: 500_000 }), PRIZE({ prizeId: 're', probabilityPpm: 500_000 })],
      budgetVnd: 15_000,
    });
    const { client } = await studentWithSpins(1);
    const res = await client.post('/api/gacha/spin');
    assert.equal(res.status, 200);
    assert.equal(res.data.prize.amountVnd, 10_000);

    const active = await getActiveGachaConfig();
    await GachaStock.collection.updateOne({ _id: `${config.id}:budget` }, { $set: { used: 0 } });
    const reservation = await reservePrize(active);
    assert.equal((await GachaStock.findById(`${config.id}:budget`).lean()).used, reservation.prize.amountVnd);
    await reservation.release();
    assert.equal((await GachaStock.findById(`${config.id}:budget`).lean()).used, 0);
  });

  test('còn kho nhưng hết ngân sách: trả lại suất kho vừa giữ, sinh viên giữ lượt', async () => {
    const config = await publishConfig({ prizes: [PRIZE({ amountVnd: 20_000, maxQuantity: 5 })], budgetVnd: 30_000 });
    const { client, id } = await studentWithSpins(2);
    assert.equal((await client.post('/api/gacha/spin')).status, 200);
    const second = await client.post('/api/gacha/spin');
    assert.deepEqual([second.status, second.data.code], [409, 'gacha_out_of_stock']);
    assert.equal((await GachaStock.findById(`${config.id}:prize:topup-10k`).lean()).used, 1);
    assert.equal((await GachaStock.findById(`${config.id}:budget`).lean()).used, 20_000);
    assert.equal((await User.findById(id).lean()).pendingGachaSpins, 1);
  });

  test('F-41: lỗi DB đúng lúc trừ lượt → giữ nguyên kho đã giữ: lệnh ghi có thể đã thành công nên trả lại có nguy cơ phát vượt', async () => {
    const config = await publishConfig({ prizes: [PRIZE({ maxQuantity: 1 })], budgetVnd: 10_000 });
    const { client, id } = await studentWithSpins(1);
    const original = { update: User.findOneAndUpdate, error: console.error };
    User.findOneAndUpdate = () => Promise.reject(new Error('DB lỗi'));
    console.error = () => {};
    try {
      assert.equal((await client.post('/api/gacha/spin')).status, 500);
    } finally {
      User.findOneAndUpdate = original.update;
      console.error = original.error;
    }
    assert.equal((await GachaStock.findById(`${config.id}:prize:topup-10k`).lean()).used, 1);
    assert.equal((await GachaStock.findById(`${config.id}:budget`).lean()).used, 10_000);
    assert.equal((await User.findById(id).lean()).pendingGachaSpins, 1, 'lượt được giữ');
    assert.equal((await client.post('/api/gacha/spin')).data.code, 'gacha_out_of_stock');
  });

  test('hết lượt thì không tốn kho: yêu cầu vượt số lượt được hoàn trả', async () => {
    const config = await publishConfig({ prizes: [PRIZE({ maxQuantity: 10 })] });
    const { client } = await studentWithSpins(1);
    const results = await Promise.all(Array.from({ length: 6 }, () => client.post('/api/gacha/spin')));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal((await GachaStock.findById(`${config.id}:prize:topup-10k`).lean()).used, 1);
  });
});

describe('phân bố xác suất', () => {
  test('tỉ lệ thực tế nằm trong khoảng tin cậy của xác suất cấu hình', () => {
    const prizes = [PRIZE({ prizeId: 'a', probabilityPpm: 100_000 }), PRIZE({ prizeId: 'b', probabilityPpm: 900_000 })];
    const rolls = 20_000;
    let hits = 0;
    for (let i = 0; i < rolls; i += 1) if (pickPrize(prizes).prizeId === 'a') hits += 1;
    // Độ lệch chuẩn của phân phối nhị thức ≈ 42 lượt; 6 lần độ lệch chuẩn gần như không thể rơi ngoài do ngẫu nhiên
    assert.ok(Math.abs(hits - 2000) < 6 * 42.4, `lệch quá lớn: ${hits}`);
  });
});

describe('xem cấu hình', () => {
  test('danh sách có phân trang và đánh dấu bản đang hiệu lực; chi tiết có số đã phát theo giải', async () => {
    await publishConfig({ prizes: [PRIZE()] });
    const list = (await admin.client.get('/api/admin/gacha/configs?pageSize=1')).data;
    assert.equal(list.items.length, 1);
    assert.equal(list.total, 2);
    assert.equal(list.items[0].isCurrent, true);
    assert.equal(list.items[0].id, list.currentId);

    const { client } = await studentWithSpins(2);
    await client.post('/api/gacha/spin');
    const detail = (await admin.client.get(`/api/admin/gacha/configs/${list.currentId}`)).data;
    assert.deepEqual(detail.issued, [{ prizeId: 'topup-10k', count: 1, faceValueVnd: 10_000 }]);
    assert.equal((await admin.client.get('/api/admin/gacha/configs/abc')).status, 404);
    assert.equal((await admin.client.get('/api/admin/gacha/configs/0123456789abcdef01234567')).status, 404);
  });

  test('phần thưởng cũ không có phiên bản vẫn hiển thị được với sinh viên', async () => {
    const { client, id } = await studentWithSpins(0);
    await GachaReward.collection.insertOne({ userId: new mongoose.Types.ObjectId(id), studentId: 'x', amountVnd: 10000, carrier: 'Viettel', topUpCode: 'GC-10K-CU', createdAt: new Date() });
    const list = await client.get('/api/gacha/rewards');
    assert.equal(list.data.rewards[0].topUpCode, 'GC-10K-CU');
  });
});
