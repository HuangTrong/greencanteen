// Bước tự kiểm của bộ phân loại, giống lúc server nạp mô hình, chạy tay trên máy triển khai (vd. trong `railway ssh`):
//   npm run vision:selfcheck [mô hình] [--json]
// Chấm các ảnh chuẩn (src/data/vision-selfcheck) rồi so xác suất theo loại với giá trị ghi trong manifest lúc hiệu chỉnh.
// Mã thoát 0 = đạt; 1 = lệch quá dung sai, thiếu tệp hoặc lỗi. --json in số đo của máy này theo định dạng selfCheck.images
// (chỉ dùng để ghi lại sau khi đã chấm lại mô hình trên máy đó bằng ảnh có nhãn).
import os from 'node:os';
import dotenv from 'dotenv';

dotenv.config();

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const modelArg = args.find((arg) => !arg.startsWith('--'));
if (modelArg) process.env.VISION_CLASSIFIER_MODEL = modelArg;

const { visionConfig } = await import('../src/services/vision.js');
const { CLASSIFIER_MANIFEST } = await import('../src/services/visionModels.js');
const { compareSelfCheck, measureSelfCheck, openClassifierSession, rankedDeviation } = await import('../src/services/visionClassifier.js');

const cfg = visionConfig();
const model = cfg.classifier.model;
const spec = CLASSIFIER_MANIFEST[model]?.selfCheck;
if (!spec) {
  console.error(`Mô hình "${model}" không có trong manifest hoặc không khai báo selfCheck.`);
  process.exit(1);
}

try {
  const loaded = await openClassifierSession(cfg);
  const measured = await measureSelfCheck(loaded, spec);
  if (asJson) {
    console.log(JSON.stringify(measured, null, 2));
    process.exit(0);
  }
  const ort = await import('onnxruntime-node');
  console.log(`Mô hình ${model} | ${cfg.classifier.threads} luồng | Node ${process.version} ${process.platform}/${process.arch} | ${os.cpus()[0]?.model || 'CPU không rõ'} | onnxruntime ${ort.env?.versions?.common || 'không rõ'}`);
  measured.forEach((image, i) => {
    const deviation = (look) => {
      const ranked = Object.entries(image[look]).map(([category, probability]) => ({ category, probability }));
      return rankedDeviation(ranked, spec.images[i][look]).maxDiff.toFixed(4);
    };
    console.log(`  ${image.file}: lệch lần nhìn đầu ${deviation('firstLook')}, ảnh làm mờ ${deviation('secondLook')}`);
  });
  const summary = compareSelfCheck(measured, spec);
  console.log(`${summary.passed ? 'ĐẠT' : 'KHÔNG ĐẠT'}: lệch lớn nhất ${summary.maxDiff} (cho phép ${summary.tolerance})${summary.worst ? ` ở ${summary.worst}` : ''}`);
  process.exit(summary.passed ? 0 : 1);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
