import path from 'path';
import { MAX_INPUT_PIXELS } from './image.js';
import { CATEGORIES, CATEGORY_LABELS, VisionEngineError } from './visionShared.js';
import { verifyModelFiles } from './visionModels.js';

// Câu mô tả tiếng Anh (CLIP học chủ yếu từ chú thích tiếng Anh); mỗi loại đúng 4 câu để không loại nào được lợi vì
// có nhiều câu hơn. Điểm của từng câu được cộng lại theo loại.
export const CLIP_PROMPTS = {
  reusable_bottle: [
    'a photo of a reusable stainless steel water bottle',
    'a photo of a thermos flask',
    'a photo of a reusable plastic sports water bottle with a lid',
    'a photo of a glass water bottle',
  ],
  reusable_cup: [
    'a photo of a ceramic coffee mug',
    'a photo of a reusable tumbler with a lid',
    'a photo of a stainless steel travel mug',
    'a photo of a reusable glass cup',
  ],
  single_use_plastic_cup: [
    'a photo of a disposable plastic cup with a straw',
    'a photo of bubble tea in a plastic cup with a sealed lid',
    'a photo of a clear disposable plastic cup',
    'a photo of iced coffee in a plastic takeaway cup',
  ],
  other_container: [
    'a photo of a disposable plastic water bottle',
    'a photo of a paper coffee cup',
    'a photo of a soda can',
    'a photo of a juice carton box',
  ],
  no_container: [
    'a photo of an empty table',
    'a photo of a person without any cup or bottle',
    'a photo of a room with no drink container',
    'a photo of an open hand holding nothing',
  ],
  unclear: [
    'a very blurry photo',
    'a very dark photo',
    'an out of focus photo of an unrecognizable object',
    'a photo of a random texture',
  ],
};
const LABEL_TO_CATEGORY = new Map(Object.entries(CLIP_PROMPTS).flatMap(([category, prompts]) => prompts.map((p) => [p, category])));
const ALL_PROMPTS = [...LABEL_TO_CATEGORY.keys()];

/**
 * Gộp điểm của từng câu mô tả thành xác suất của từng loại, chuẩn hóa tổng = 1 (đúng cho cả CLIP — softmax — và SigLIP
 * — sigmoid). Trả danh sách { category, probability } giảm dần, hoặc null nếu không có điểm hợp lệ.
 */
export function aggregateScores(output) {
  const sums = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const { label, score } of output || []) {
    const category = LABEL_TO_CATEGORY.get(label);
    if (category && Number.isFinite(score) && score > 0) sums[category] += score;
  }
  const total = Object.values(sums).reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return CATEGORIES.map((category) => ({ category, probability: Math.round((sums[category] / total) * 10000) / 10000 })).sort(
    (a, b) => b.probability - a.probability
  );
}

const classifiers = new Map();

/** Nạp mô hình một lần cho mỗi (mô hình, thư mục); chỉ đọc tệp cục bộ đã đúng mã băm, không bao giờ tải từ mạng */
export function loadClassifier(cfg) {
  const key = `${cfg.clip.model}|${cfg.clip.dir}`;
  if (!classifiers.has(key)) {
    const loading = (async () => {
      const problems = await verifyModelFiles(cfg.clip.model, cfg.clip.dir);
      if (problems.length) {
        const detail = problems.map((p) => `${p.file || cfg.clip.model}: ${p.problem}`).join(', ');
        throw new VisionEngineError('not_configured', `Mô hình ${cfg.clip.model} chưa sẵn sàng (${detail}) — chạy "npm run vision:download".`);
      }
      const { env: hf, pipeline } = await import('@huggingface/transformers');
      hf.allowRemoteModels = false;
      hf.allowLocalModels = true;
      hf.useFSCache = false;
      hf.localModelPath = `${cfg.clip.dir}${path.sep}`;
      return pipeline('zero-shot-image-classification', cfg.clip.model, { dtype: 'q8', device: 'cpu', local_files_only: true });
    })();
    loading.catch(() => classifiers.delete(key));
    classifiers.set(key, loading);
  }
  return classifiers.get(key);
}

// Ảnh "bom giải nén" (tệp nhỏ, kích thước khổng lồ): RawImage.fromBlob giải mã toàn bộ ảnh rồi mới thu nhỏ — PNG
// 12000×12000 chỉ ~440 KB nhưng chiếm thêm ~1,4 GB RAM. Vì vậy: từ chối ảnh quá MAX_INPUT_PIXELS điểm ảnh và thu nhỏ ngay
// trong lúc giải mã (libvips đọc theo dòng, JPEG/WebP giải mã sẵn ở tỉ lệ nhỏ) → bộ nhớ không phụ thuộc kích thước ảnh gốc.
const DECODE_MAX_SIDE = 1024; // CLIP chỉ dùng 224×224

async function decodeImage(buffer) {
  const [{ RawImage }, { default: sharp }] = await Promise.all([import('@huggingface/transformers'), import('sharp')]);
  const { data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // theo hướng chụp trong EXIF
    .flatten({ background: '#ffffff' }) // nền trong suốt → trắng
    .resize(DECODE_MAX_SIDE, DECODE_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new RawImage(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, info.channels);
}

// Đưa về cùng kích thước rồi làm mờ: chữ cỡ nhãn dán không còn đọc được, hình dáng và màu của vật chứa vẫn còn. Độ mờ chọn bằng tập ảnh
// test/fixtures/vision/adversarial; chữ rất lớn, nét đậm vẫn có thể còn đọc được sau khi làm mờ.
const SECOND_LOOK_SIDE = 448;
const SECOND_LOOK_BLUR_SIGMA = 8;

/** Bản ảnh đã làm mờ chữ cho lần nhìn thứ hai (F-26) */
export async function suppressText(buffer) {
  const { default: sharp } = await import('sharp');
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(SECOND_LOOK_SIDE, SECOND_LOOK_SIDE, { fit: 'inside' })
    .blur(SECOND_LOOK_BLUR_SIGMA)
    .jpeg({ quality: 90 })
    .toBuffer();
}

const percent = (p) => `${Math.round(p * 100)}%`;

async function inferClip({ buffer, mimeType }, cfg, { load = loadClassifier, decode = decodeImage }) {
  const classifier = await load(cfg);
  let image;
  try {
    image = await decode(buffer, mimeType);
  } catch (err) {
    throw new VisionEngineError('invalid_image', err?.message || 'không giải mã được ảnh');
  }
  const ranked = aggregateScores(await classifier(image, ALL_PROMPTS, { hypothesis_template: '{}' }));
  if (!ranked) throw new VisionEngineError('invalid_response', 'CLIP không trả về điểm hợp lệ');
  const [top, second] = ranked;
  return {
    category: top.category,
    confidence: Math.round(top.probability * 1000) / 1000,
    reason: `Nhận diện tại máy chủ (CLIP): ${CATEGORY_LABELS[top.category]} ${percent(top.probability)}; tiếp theo: ${CATEGORY_LABELS[second.category].toLowerCase()} ${percent(second.probability)}.`,
    model: `clip:${cfg.clip.model}`,
    ranked,
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new VisionEngineError('timeout', `CLIP chạy quá ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Suy luận tốn CPU → chạy lần lượt từng ảnh; quá cfg.maxQueue ảnh đang chờ thì từ chối ngay (busy) thay vì làm treo server
let queue = Promise.resolve();
let pending = 0;

/** Phân loại bằng CLIP zero-shot trong tiến trình. Trả { category, confidence, reason, model, ranked } hoặc ném VisionEngineError */
export async function classifyWithClip(image, cfg, deps = {}) {
  if (pending >= cfg.maxQueue) throw new VisionEngineError('busy', `hàng đợi CLIP đầy (${pending} ảnh)`);
  pending += 1;
  const run = queue.then(() => withTimeout(inferClip(image, cfg, deps), cfg.timeoutMs));
  queue = run.catch(() => {});
  try {
    return await run;
  } finally {
    pending -= 1;
  }
}
