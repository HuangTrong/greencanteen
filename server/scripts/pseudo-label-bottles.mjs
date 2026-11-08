// Gợi ý nhãn chai nước bằng bộ phân loại ONNX đang cấu hình của server (VISION_CLASSIFIER_MODEL), chạy ngoại tuyến trên CPU,
// không gửi ảnh đi đâu:
//   node scripts/pseudo-label-bottles.mjs <thư mục ảnh> <tệp-out.json> [--raw-only] [--validate <thư mục đối chiếu>]
// Tách ảnh "water bottle" lẫn lộn (nhôm / thủy tinh / PET) thành reusable_bottle vs other_container theo chính sách nghiệp vụ.
// Ngưỡng thận trọng: p(nhãn) >= 0.5 VÀ chênh lệch với nhãn kia >= 0.1; dưới ngưỡng → bỏ ảnh (không dùng).
// Kết quả chỉ là GỢI Ý để người duyệt lại, không dùng thẳng làm nhãn huấn luyện: mô hình gợi ý nhãn sai thì mô hình học từ nhãn đó
// sai theo. Trước 2026-11-07 script dùng CLIP; CLIP đã gỡ khỏi server nên giờ dùng chung bộ phân loại với check-in.
// Chất lượng bộ lọc được đo trên ảnh có nhãn khi truyền --validate <thư mục> (thư mục con theo loại nghiệp vụ).
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const validateDir = option('--validate');
const rawOnly = args.includes('--raw-only');
const [inputDir, outFile] = args.filter((arg) => !arg.startsWith('--'));
if (!inputDir || !outFile || !fs.existsSync(inputDir)) {
  console.error('Cách dùng: node scripts/pseudo-label-bottles.mjs <thư mục ảnh> <out.json> [--raw-only] [--validate <thư mục đối chiếu>]');
  process.exit(1);
}

const { visionConfig } = await import('../src/services/vision.js');
const { classifyWithClassifier } = await import('../src/services/visionClassifier.js');
const { inspectImage } = await import('../src/services/image.js');

const cfg = visionConfig();
if (cfg.engine !== 'classifier' || cfg.problem) {
  console.error(`Bộ phân loại chưa dùng được (VISION_ENGINE=${cfg.engine || 'không hợp lệ'}, ${cfg.problem || 'mô hình chưa cấu hình'}).`);
  console.error('Đặt VISION_ENGINE=classifier, VISION_CLASSIFIER_MODEL trong manifest và tải mô hình bằng npm run vision:model.');
  process.exit(1);
}

const REUSABLE_PROB = Number(process.env.PSEUDO_REUSABLE_MIN || 0.5);
const MARGIN = Number(process.env.PSEUDO_MARGIN || 0.1);

function listImages(dir, { recursive = false, skipAug = false } = {}) {
  const entries = recursive ? fs.readdirSync(dir, { recursive: true }) : fs.readdirSync(dir);
  return entries
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .filter((name) => !skipAug || !/_aug/i.test(name))
    .map((name) => path.join(dir, name));
}

async function score(file) {
  const buffer = fs.readFileSync(file);
  const image = inspectImage(buffer);
  if (!image.ok) return { file, error: image.code };
  try {
    const result = await classifyWithClassifier({ buffer, mimeType: image.mimeType }, cfg);
    return { file, ranked: result.ranked };
  } catch (err) {
    // Lỗi bộ nhận diện không phải nhãn: ghi lại để biết, ảnh không được gợi ý nhãn nào
    return { file, error: err?.status || err?.message };
  }
}

const labelOf = (ranked) => {
  const probs = Object.fromEntries((ranked || []).map((r) => [r.category, r.probability]));
  const reusable = probs.reusable_bottle ?? 0;
  const other = probs.other_container ?? 0;
  if (reusable >= REUSABLE_PROB && reusable - other >= MARGIN) return 'reusable_bottle';
  if (other >= REUSABLE_PROB && other - reusable >= MARGIN) return 'other_container';
  return null; // quá mơ hồ → không dùng
};

const results = [];
const files = listImages(inputDir, { recursive: true, skipAug: rawOnly });
console.log(`Gợi ý nhãn ${files.length} ảnh bằng bộ phân loại ${cfg.classifier.model}; ngưỡng p>=${REUSABLE_PROB}, chênh >= ${MARGIN}`);
let done = 0;
for (const file of files) {
  const r = await score(file);
  r.label = r.ranked ? labelOf(r.ranked) : null;
  delete r.ranked;
  results.push(r);
  done += 1;
  if (done % 100 === 0) console.log(`  ${done}/${files.length}`);
}
const counts = results.reduce((acc, r) => {
  const key = r.error ? 'error' : (r.label ?? 'dropped');
  return { ...acc, [key]: (acc[key] ?? 0) + 1 };
}, {});
console.log('Kết quả:', JSON.stringify(counts));

if (validateDir) {
  const truth = ['reusable_bottle', 'other_container', 'single_use_plastic_cup', 'reusable_cup', 'no_container', 'unclear'];
  let kept = 0;
  let correct = 0;
  let errors = 0;
  const table = {};
  for (const expected of truth) {
    const dir = path.join(validateDir, expected);
    if (!fs.existsSync(dir)) continue;
    for (const file of listImages(dir)) {
      const r = await score(file);
      table[expected] = table[expected] || { total: 0, reusable: 0, other: 0, dropped: 0, error: 0 };
      table[expected].total += 1;
      if (r.error) {
        table[expected].error += 1;
        errors += 1;
        continue;
      }
      const predicted = labelOf(r.ranked);
      if (predicted === expected) correct += 1;
      if (predicted) kept += 1;
      table[expected][predicted === 'reusable_bottle' ? 'reusable' : predicted === 'other_container' ? 'other' : 'dropped'] += 1;
    }
  }
  const total = Object.values(table).reduce((sum, row) => sum + row.total, 0);
  console.log('Đối chiếu bộ lọc:', JSON.stringify(table, null, 2));
  // Ảnh lỗi bộ nhận diện không được tính là đúng hay sai
  console.log(`Đúng nhãn: ${correct}/${total - errors} ảnh chấm được; được gợi ý nhãn: ${kept}; lỗi bộ nhận diện: ${errors}`);
}

fs.writeFileSync(
  outFile,
  JSON.stringify({ model: `classifier:${cfg.classifier.model}`, thresholds: { reusableMin: REUSABLE_PROB, margin: MARGIN }, results }, null, 2)
);
console.log(`Đã ghi ${outFile}`);
