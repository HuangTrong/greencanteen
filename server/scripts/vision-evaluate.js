// Đánh giá bộ nhận diện bằng ảnh đã gán nhãn của trường — chạy hoàn toàn tại máy chủ, không gửi ảnh ra ngoài:
//   npm run vision:evaluate -- <thư mục> [--engine clip|ollama|ensemble] [--json kết-quả.json]
// <thư mục> gồm các thư mục con theo loại: reusable_bottle/ reusable_cup/ single_use_plastic_cup/ other_container/
// no_container/ unclear/ (ảnh JPEG, PNG, WebP). In ma trận nhầm lẫn, tỉ lệ chấp nhận nhầm / từ chối nhầm và quét ngưỡng
// để chọn VISION_CONFIDENCE_THRESHOLD.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const { CATEGORIES, CATEGORY_LABELS, REWARDABLE_CATEGORIES, classifyContainerImage, visionConfig } = await import('../src/services/vision.js');
const { inspectImage } = await import('../src/services/image.js');

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const engine = option('--engine');
const jsonOut = option('--json');
const root = args[0];
if (!root || !fs.existsSync(root)) {
  console.error('Cách dùng: npm run vision:evaluate -- <thư mục ảnh có gán nhãn> [--engine clip|ollama|ensemble] [--json kết-quả.json]');
  process.exit(1);
}
if (engine) process.env.VISION_ENGINE = engine;
delete process.env.VISION_SIMULATION; // đánh giá luôn dùng bộ nhận diện thật

const cfg = visionConfig({ evaluating: true });
if (cfg.mode !== 'local') {
  console.error(`Bộ nhận diện chưa sẵn sàng (${cfg.problem}). Kiểm tra VISION_ENGINE / VISION_OLLAMA_URL / VISION_CLIP_MODEL.`);
  process.exit(1);
}

const samples = [];
for (const expected of CATEGORIES) {
  const dir = path.join(root, expected);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).sort()) {
    if (/\.(jpe?g|png|webp)$/i.test(name)) samples.push({ expected, file: path.join(dir, name) });
  }
}
if (!samples.length) {
  console.error(`Không thấy ảnh nào trong các thư mục con: ${CATEGORIES.join(', ')}`);
  process.exit(1);
}

console.log(`Đánh giá ${samples.length} ảnh bằng ${cfg.engine}, ngưỡng hiện tại ${cfg.threshold}...`);
const results = [];
for (const sample of samples) {
  const buffer = fs.readFileSync(sample.file);
  const image = inspectImage(buffer);
  if (!image.ok) {
    results.push({ ...sample, status: image.code, predicted: null, confidence: null });
    continue;
  }
  const started = Date.now();
  const r = await classifyContainerImage({ buffer, mimeType: image.mimeType }, cfg);
  results.push({ ...sample, status: r.status, predicted: r.category, confidence: r.confidence, ms: Date.now() - started });
}

const classified = results.filter((r) => r.status === 'classified');
const accepted = (r, t) => REWARDABLE_CATEGORIES.has(r.predicted) && r.confidence >= t;
const rates = (t) => {
  const negatives = classified.filter((r) => !REWARDABLE_CATEGORIES.has(r.expected));
  const positives = classified.filter((r) => REWARDABLE_CATEGORIES.has(r.expected));
  return {
    threshold: t,
    falseAcceptRate: negatives.length ? negatives.filter((r) => accepted(r, t)).length / negatives.length : null,
    falseRejectRate: positives.length ? positives.filter((r) => !accepted(r, t)).length / positives.length : null,
  };
};
const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

console.log(`\nĐộ chính xác theo loại: ${pct(classified.filter((r) => r.predicted === r.expected).length / (classified.length || 1))} (${classified.length} ảnh chấm được, ${results.length - classified.length} lỗi)`);
console.log('\nMa trận nhầm lẫn (hàng = nhãn đúng, cột = dự đoán):');
console.log(['', ...CATEGORIES].map((c) => c.padEnd(24)).join(''));
for (const expected of CATEGORIES) {
  const row = CATEGORIES.map((predicted) => String(classified.filter((r) => r.expected === expected && r.predicted === predicted).length).padEnd(24));
  console.log(expected.padEnd(24) + row.join(''));
}
const current = rates(cfg.threshold);
console.log(`\nỞ ngưỡng ${cfg.threshold}: chấp nhận nhầm ${pct(current.falseAcceptRate)} (ảnh không phải bình/ly cá nhân mà được thưởng), từ chối nhầm ${pct(current.falseRejectRate)}`);
console.log('\nQuét ngưỡng (chọn ngưỡng có tỉ lệ chấp nhận nhầm chấp nhận được):');
const sweep = [];
for (let t = 0.5; t <= 1.0001; t += 0.05) sweep.push(rates(Math.round(t * 100) / 100));
for (const s of sweep) console.log(`  ${s.threshold.toFixed(2)}  chấp nhận nhầm ${pct(s.falseAcceptRate).padStart(6)}  từ chối nhầm ${pct(s.falseRejectRate).padStart(6)}`);
const slow = classified.reduce((max, r) => Math.max(max, r.ms), 0);
console.log(`\nThời gian nhận diện chậm nhất: ${slow} ms. Nhãn: ${CATEGORIES.map((c) => `${c} = ${CATEGORY_LABELS[c]}`).join('; ')}`);

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ engine: cfg.engine, threshold: cfg.threshold, results, sweep }, null, 2));
  console.log(`Đã ghi ${jsonOut}`);
}
