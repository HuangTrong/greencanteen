// Đo hiệu năng bộ nhận diện ảnh (bộ phân loại ONNX trên CPU) TẠI MÁY CHỦ — hoàn toàn ngoại tuyến:
//   npm run vision:benchmark -- [--model <id>] [--images <thư mục>] [--runs 30] [--concurrency 4] [--json kết-quả.json]
// Ghi nhận: thời gian nạp mô hình, độ trễ từng ảnh (p50/p95), RSS đỉnh, hành vi khi gửi đồng thời.
// Đây là số đo máy CHẠY SCRIPT, không phải số đo Railway — ghi rõ môi trường khi trích dẫn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import dotenv from 'dotenv';

dotenv.config();

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const engine = (option('--engine') || 'classifier').toLowerCase();
if (engine !== 'classifier') {
  console.error(`Engine "${engine}" không còn: server chỉ còn bộ phân loại ONNX (classifier); CLIP và Ollama đã bị gỡ.`);
  process.exit(1);
}
const modelOverride = option('--model');
const runs = Number(option('--runs') || 30);
const concurrency = Number(option('--concurrency') || 4);
const jsonOut = option('--json');
let imagesDir = option('--images') || path.join('test', 'fixtures', 'vision');
if (!fs.existsSync(imagesDir)) {
  console.error(`Không thấy thư mục ảnh: ${imagesDir}`);
  process.exit(1);
}

if (modelOverride) process.env.VISION_CLASSIFIER_MODEL = modelOverride;
process.env.VISION_ENGINE = engine;
delete process.env.VISION_SIMULATION;

const { visionConfig } = await import('../src/services/vision.js');
const { classifyWithClassifier, loadClassifier } = await import('../src/services/visionClassifier.js');

const cfg = visionConfig();
if (cfg.mode !== 'local') {
  console.error(`Bộ nhận diện chưa sẵn sàng (${cfg.problem}). Kiểm tra VISION_ENGINE / VISION_CLASSIFIER_MODEL / mô hình đã tải.`);
  process.exit(1);
}

// Thu ảnh: mọi tệp JPEG/PNG/WebP trong thư mục (không đệ quy) — mã băm riêng bằng byte nối thêm để không bị coi là trùng
const files = fs.readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
if (!files.length) {
  console.error(`Không có ảnh nào trong ${imagesDir}`);
  process.exit(1);
}
const samples = files.map((name) => ({ name, buffer: fs.readFileSync(path.join(imagesDir, name)) }));
console.log(`Mô hình: ${cfg.classifier.model} | ${samples.length} ảnh | ${runs} lượt/ảnh | đồng thời ${concurrency}`);
console.log(`Môi trường: Node ${process.version}, ${process.platform}, CPUs ${os.cpus().length} × ${os.cpus()[0]?.model || '?'}`);

const classify = classifyWithClassifier;

// RSS đỉnh: bám theo nền; của tiến trình gồm cả mô hình đã nạp
let peakRss = process.memoryUsage().rss;
const monitor = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 25);

// 1) Nạp mô hình
const loadStart = performance.now();
await loadClassifier(cfg);
const loadMs = performance.now() - loadStart;
const rssAfterLoad = process.memoryUsage().rss;
console.log(`Nạp mô hình: ${loadMs.toFixed(0)} ms; RSS sau nạp: ${(rssAfterLoad / 1048576).toFixed(0)} MB`);

// 2) Làm ấm (JIT, bộ nhớ đệm libvips)
for (const sample of samples.slice(0, 2)) await classify({ buffer: sample.buffer, mimeType: 'image/png' }, cfg).catch(() => {});

// 3) Tuần tự: mỗi ảnh chạy `runs` lượt
const latencies = [];
const perImage = new Map();
for (const sample of samples) {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const result = await classify({ buffer: sample.buffer, mimeType: 'image/png' }, cfg);
    times.push(performance.now() - start);
    perImage.set(sample.name, { category: result.category, confidence: result.confidence });
  }
  latencies.push(...times);
}
latencies.sort((a, b) => a - b);
const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
console.log(`Tuần tự (${latencies.length} lượt): p50 ${p(0.5).toFixed(1)} ms | p95 ${p(0.95).toFixed(1)} ms | max ${latencies[latencies.length - 1].toFixed(1)} ms`);
for (const [name, r] of perImage) console.log(`  ${name}: ${r.category} @ ${r.confidence}`);

// 4) Đồng thời: chạy `concurrency` ảnh khác nhau cùng lúc (ảnh chưa nạp sẵn mô hình)
peakRss = Math.max(peakRss, process.memoryUsage().rss);
const batchStart = performance.now();
const batch = await Promise.allSettled(
  Array.from({ length: concurrency }, (_, i) => {
    const sample = samples[i % samples.length];
    return classify({ buffer: Buffer.concat([sample.buffer, Buffer.from(`c${i}`)]), mimeType: 'image/png' }, cfg);
  })
);
const batchMs = performance.now() - batchStart;
const fulfilled = batch.filter((r) => r.status === 'fulfilled').length;
const busy = batch.filter((r) => r.status === 'rejected' && r.reason?.status === 'busy').length;
console.log(`Đồng thời ${concurrency} ảnh: ${batchMs.toFixed(1)} ms | xong ${fulfilled}, từ chối vì bận ${busy}`);

// 5) Ảnh lớn (giới hạn hợp lệ của server: bên dưới trần 100 MP)
const { default: sharp } = await import('sharp');
const large = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: { r: 120, g: 160, b: 200 } } }).png().toBuffer();
const largeStart = performance.now();
const largeResult = await classify({ buffer: large, mimeType: 'image/png' }, cfg);
const largeMs = performance.now() - largeStart;
console.log(`Ảnh 6000×6000 PNG (${(large.length / 1048576).toFixed(1)} MB): ${largeMs.toFixed(1)} ms → ${largeResult.category}`);

clearInterval(monitor);
peakRss = Math.max(peakRss, process.memoryUsage().rss);
console.log(`RSS đỉnh đo được: ${(peakRss / 1048576).toFixed(0)} MB (tiến trình gồm mô hình)`);

if (jsonOut) {
  fs.writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        engine,
        model: cfg.classifier.model,
        node: process.version,
        cpus: os.cpus().length,
        loadMs: Math.round(loadMs),
        rssAfterLoadMb: Math.round(rssAfterLoad / 1048576),
        sequential: { runs: latencies.length, p50Ms: Math.round(p(0.5) * 10) / 10, p95Ms: Math.round(p(0.95) * 10) / 10, maxMs: Math.round(latencies[latencies.length - 1] * 10) / 10 },
        concurrent: { count: concurrency, totalMs: Math.round(batchMs), fulfilled, busyRejected: busy },
        largeImage6000: { ms: Math.round(largeMs) },
        peakRssMb: Math.round(peakRss / 1048576),
        perImage: Object.fromEntries(perImage),
      },
      null,
      2
    )
  );
  console.log(`Đã ghi ${jsonOut}`);
}
