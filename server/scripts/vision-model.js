// Quản lý tệp mô hình nhận diện ảnh (chạy trên máy chủ, cần Internet một lần lúc cài đặt):
//   npm run vision:download [mô hình]  — tải theo commit đã ghim, kiểm tra kích thước + mã băm trước khi ghi
//   npm run vision:verify   [mô hình]  — kiểm tra lại tệp đã có (chạy server không bao giờ tự tải)
// Mặc định: VISION_CLASSIFIER_MODEL trong .env, hoặc onnxmodelzoo/mobilenetv3_small_075_Opset17.
// Danh sách: src/data/classifier-models.json (bộ phân loại ONNX chạy trên CPU)
import dotenv from 'dotenv';

dotenv.config();

const { DEFAULT_CLASSIFIER_MODEL, MODEL_MANIFEST, downloadModel, modelDir, verifyModelFiles } = await import('../src/services/visionModels.js');

const [command, modelArg] = process.argv.slice(2);
const model = modelArg || process.env.VISION_CLASSIFIER_MODEL?.trim() || DEFAULT_CLASSIFIER_MODEL;
const entry = MODEL_MANIFEST[model];
const dir = modelDir();

if (!['download', 'verify'].includes(command) || !entry) {
  console.error('Cách dùng: npm run vision:download [mô hình] | npm run vision:verify [mô hình]');
  console.error(`Mô hình đã ghim: ${Object.keys(MODEL_MANIFEST).join(', ')}`);
  process.exit(1);
}

const totalMb = Object.values(entry.files).reduce((sum, f) => sum + f.size, 0) / 1048576;
console.log(`Mô hình: ${model} @ ${entry.source === 'local' ? 'huấn luyện tại chỗ (ghim bằng sha256)' : entry.revision} (${totalMb.toFixed(1)} MB) → ${dir}`);
console.log(`Giấy phép: ${entry.license}`);

try {
  // VISION_MODEL_URL: chỉ cho mô hình huấn luyện tại chỗ (không có trên Hugging Face); tệp vẫn phải đúng sha256 trong manifest
  if (command === 'download') await downloadModel(model, { dir, url: process.env.VISION_MODEL_URL?.trim() || null });
  const problems = await verifyModelFiles(model, dir);
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p.file}: ${p.problem}`);
    console.error(`Mô hình chưa sẵn sàng — chạy "npm run vision:download ${model}".`);
    process.exit(1);
  }
  console.log('Tất cả tệp khớp kích thước và mã băm trong manifest — server có thể nhận diện ngoại tuyến.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
