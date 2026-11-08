import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MAX_INPUT_PIXELS } from './image.js';
import { CATEGORIES, CATEGORY_LABELS, VisionEngineError } from './visionShared.js';
import { CLASSIFIER_MANIFEST, modelFilePath, verifyModelFiles } from './visionModels.js';

/**
 * Bộ phân loại ONNX chạy TRỰC TIẾP trong tiến trình server bằng onnxruntime-node (engine 'classifier'), chỉ dùng CPU.
 * Đây là bộ nhận diện duy nhất của server. Mô hình trả logits (artifact hiện tại: 1000 lớp ImageNet), ánh xạ qua
 * classMapping trong manifest (src/data/classifier-models.json) thành các loại nghiệp vụ; chỉ số ngoài ánh xạ gộp
 * thành residual → 'unclear' khi chiếm ưu thế → ảnh ngoài phạm vi không bao giờ tự được thưởng.
 * Thông số tiền xử lý ĐỌC TỪ MANIFEST (đã đối chiếu pretrained_cfg của checkpoint trên Hugging Face),
 * không tự suy đoán cấu hình ImageNet chung.
 */

export function softmax(logits) {
  const out = new Float32Array(logits.length);
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  let total = 0;
  for (let i = 0; i < logits.length; i += 1) {
    out[i] = Math.exp(logits[i] - max);
    total += out[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= total;
  return out;
}

/**
 * Cộng xác suất softmax theo ánh xạ của từng loại nghiệp vụ; các lớp không ánh xạ thành residual.
 * Trả { ranked } — danh sách { category, probability } giảm dần (tổng = 1), trong đó residual
 * chiếm vị trí của 'unclear'. Loại không có lớp ánh xạ nào (vd. single_use_plastic_cup với
 * artifact ImageNet) luôn có điểm 0 → không bao giờ đứng đầu.
 */
export function aggregateMappedClasses(probabilities, classMapping) {
  const sums = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const category of CATEGORIES) {
    const indices = classMapping[category];
    if (category === 'unclear' || !Array.isArray(indices)) continue;
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= probabilities.length) continue;
      sums[category] += probabilities[index];
    }
  }
  let residual = 1;
  for (const category of CATEGORIES) residual -= sums[category];
  if (residual < 0) residual = 0;
  sums.unclear = residual;
  const round = (p) => Math.round(p * 10000) / 10000;
  return CATEGORIES.map((category) => ({ category, probability: round(sums[category]) })).sort((a, b) => b.probability - a.probability);
}

// Nạp session một lần cho mỗi (mô hình, thư mục); chỉ đọc tệp cục bộ đã đúng mã băm, không bao giờ tải từ mạng
const sessions = new Map();
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Mở session ONNX từ tệp đã đúng mã băm và kiểm kích thước vào/ra (chưa chạy bước tự kiểm) */
export async function openClassifierSession(cfg) {
  const entry = CLASSIFIER_MANIFEST[cfg.classifier.model];
  if (!entry) {
    throw new VisionEngineError('not_configured', `Mô hình phân loại "${cfg.classifier.model}" không có trong manifest (src/data/classifier-models.json).`);
  }
  const problems = await verifyModelFiles(cfg.classifier.model, cfg.classifier.dir);
  if (problems.length) {
    const detail = problems.map((p) => `${p.file || cfg.classifier.model}: ${p.problem}`).join(', ');
    throw new VisionEngineError('not_configured', `Mô hình ${cfg.classifier.model} chưa sẵn sàng (${detail}) — chạy "npm run vision:download".`);
  }
  const ort = await import('onnxruntime-node');
  const [modelFile] = Object.keys(entry.files);
  const session = await ort.InferenceSession.create(modelFilePath(cfg.classifier.model, modelFile, cfg.classifier.dir), {
    executionProviders: ['cpu'], // CPU-first, không CUDA/GPU
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    intraOpNumThreads: cfg.classifier.threads, // giới hạn chỉ định rõ ràng để không vượt CPU/RAM của container
    interOpNumThreads: 1,
  });
  const [width, height, channels] = [entry.input.crop, entry.input.crop, entry.input.shape[1]];
  const expected = [1, channels, height, width];
  const inputMeta = session.inputMetadata[0];
  if (JSON.stringify(inputMeta.shape) !== JSON.stringify(expected)) {
    throw new VisionEngineError('not_configured', `Kích thước đầu vào của mô hình (${JSON.stringify(inputMeta.shape)}) khác manifest (${JSON.stringify(expected)}).`);
  }
  // Số lớp đầu ra lấy từ chính mô hình (vd. [1, 1000]); kích thước có chiều động thì không biết trước → null
  const outputShape = session.outputMetadata?.[0]?.shape;
  const outputSize =
    Array.isArray(outputShape) && outputShape.length > 0 && outputShape.every((d) => Number.isInteger(d) && d > 0)
      ? outputShape.reduce((product, d) => product * d, 1)
      : null;
  return { session, entry, inputName: session.inputNames[0], outputName: session.outputNames[0], outputSize };
}

/** Độ lệch lớn nhất giữa xác suất theo loại (ranked) và giá trị chuẩn { loại: xác suất }; loại thiếu ở một bên tính là 0 */
export function rankedDeviation(ranked, expected) {
  const actual = Object.fromEntries((ranked || []).map((r) => [r.category, r.probability]));
  let maxDiff = 0;
  let category = null;
  for (const name of new Set([...Object.keys(actual), ...Object.keys(expected || {})])) {
    const diff = Math.abs((actual[name] ?? 0) - (expected?.[name] ?? 0));
    if (diff > maxDiff) {
      maxDiff = diff;
      category = name;
    }
  }
  return { maxDiff, category };
}

const toProbabilities = (ranked) => Object.fromEntries(ranked.map((r) => [r.category, r.probability]));

/**
 * Chấm các ảnh chuẩn của selfCheck (manifest) bằng session đã mở: lần nhìn đầu và bản làm mờ chữ của lần nhìn thứ hai.
 * Ảnh chuẩn phải đúng sha256 ghi trong manifest. Trả [{ file, sha256, firstLook, secondLook }] (xác suất theo loại).
 */
export async function measureSelfCheck(loaded, spec) {
  const measured = [];
  for (const image of spec.images) {
    const buffer = await fs.promises.readFile(path.resolve(serverRoot, image.file));
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (digest !== image.sha256) throw new Error(`ảnh chuẩn ${image.file} sai mã băm`);
    measured.push({
      file: image.file,
      sha256: digest,
      firstLook: toProbabilities(await rankImage(loaded, buffer)),
      secondLook: toProbabilities(await rankImage(loaded, await suppressText(buffer))),
    });
  }
  return measured;
}

/** So kết quả chấm ảnh chuẩn với giá trị ghi trong manifest → { images, maxDiff, worst, tolerance, passed } */
export function compareSelfCheck(measured, spec) {
  let maxDiff = 0;
  let worst = null;
  measured.forEach((image, i) => {
    for (const look of ['firstLook', 'secondLook']) {
      const ranked = Object.entries(image[look]).map(([category, probability]) => ({ category, probability }));
      const { maxDiff: diff, category } = rankedDeviation(ranked, spec.images[i][look]);
      if (diff > maxDiff) {
        maxDiff = diff;
        worst = `${image.file}, ${look === 'firstLook' ? 'lần nhìn đầu' : 'ảnh làm mờ'}, ${category}`;
      }
    }
  });
  return { images: measured.length, maxDiff: Math.round(maxDiff * 10000) / 10000, worst, tolerance: spec.tolerance, passed: maxDiff <= spec.tolerance };
}

/**
 * Bước tự kiểm khi nạp (mô hình có selfCheck trong manifest): chấm lại các ảnh chuẩn và so với giá trị đo lúc hiệu chỉnh. Máy khác (Linux,
 * CPU khác loại, thư viện khác bản) có thể làm mô hình int8 tính khác → số thưởng nhầm / nhận đúng đã đo không còn đúng. Lệch quá dung
 * sai: mặc định không nạp (check-in "chưa sẵn sàng"); VISION_SELF_CHECK=warn chỉ ghi lỗi, dành cho máy đã được chấm lại.
 */
async function runSelfCheck(loaded, cfg) {
  const spec = loaded.entry.selfCheck;
  let summary;
  try {
    summary = compareSelfCheck(await measureSelfCheck(loaded, spec), spec);
  } catch (err) {
    summary = { images: spec.images.length, maxDiff: null, worst: null, tolerance: spec.tolerance, passed: false, error: err?.message || String(err) };
  }
  if (summary.passed) return summary;
  const detail = summary.error || `lệch lớn nhất ${summary.maxDiff} ở ${summary.worst}, cho phép ${spec.tolerance}`;
  const message = `Mô hình ${cfg.classifier.model} không qua bước tự kiểm khi nạp (${detail}): máy này tính khác lúc hiệu chỉnh nên số đo thưởng nhầm / nhận đúng không còn đúng. Chấm lại trên máy này; chỉ đặt VISION_SELF_CHECK=warn khi đã chấp nhận kết quả mới.`;
  if (cfg.selfCheck === 'warn') {
    console.error(`[vision-self-check] ${message} (VISION_SELF_CHECK=warn: vẫn dùng mô hình)`);
    return summary;
  }
  const err = new VisionEngineError('not_configured', message);
  err.permanent = true;
  throw err;
}

export function loadClassifier(cfg) {
  const key = `${cfg.classifier.model}|${cfg.classifier.dir}`;
  if (!sessions.has(key)) {
    const loading = (async () => {
      const loaded = await openClassifierSession(cfg);
      if (loaded.entry.selfCheck) loaded.selfCheck = await runSelfCheck(loaded, cfg);
      return loaded;
    })();
    // Thiếu tệp, lỗi tạm → lần gọi sau thử nạp lại. Không qua tự kiểm là kết quả cố định của máy này → giữ lỗi tới khi khởi động lại
    loading.catch((err) => {
      if (!err?.permanent) sessions.delete(key);
    });
    sessions.set(key, loading);
  }
  return sessions.get(key);
}

// Tiền xử lý đúng theo manifest: EXIF → nền trắng → resize cạnh ngắn 256 (giữ tỉ lệ) → cắt giữa crop×crop
// → RGB float32 NCHW chuẩn hóa (x/255 − mean)/std. Ảnh bom giải nén bị chặn bởi limitInputPixels.
export async function preprocessImage(buffer, input) {
  const { default: sharp } = await import('sharp');
  const { crop } = input;
  let data;
  let info;
  try {
    ({ data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // theo hướng chụp trong EXIF
      .flatten({ background: '#ffffff' }) // nền trong suốt → trắng
      .resize(input.resize, input.resize, { fit: 'cover', position: 'centre', kernel: input.interpolation === 'cubic' ? 'cubic' : 'lanczos3' })
      .extract({ left: Math.floor((input.resize - crop) / 2), top: Math.floor((input.resize - crop) / 2), width: crop, height: crop })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch (err) {
    throw new VisionEngineError('invalid_image', err?.message || 'không giải mã được ảnh');
  }
  if (info.width !== crop || info.height !== crop || info.channels !== 3) {
    throw new VisionEngineError('invalid_image', `ảnh sau tiền xử lý ${info.width}x${info.height}x${info.channels}, kỳ vọng ${crop}x${crop}x3`);
  }
  const pixels = crop * crop;
  const tensor = new Float32Array(3 * pixels);
  const [meanR, meanG, meanB] = input.mean;
  const [stdR, stdG, stdB] = input.std;
  for (let i = 0; i < pixels; i += 1) {
    tensor[i] = (data[i * 3] / 255 - meanR) / stdR;
    tensor[pixels + i] = (data[i * 3 + 1] / 255 - meanG) / stdG;
    tensor[2 * pixels + i] = (data[i * 3 + 2] / 255 - meanB) / stdB;
  }
  return tensor;
}

// Lần nhìn thứ hai (F-26): đưa về cùng kích thước rồi làm mờ — chữ cỡ nhãn dán không còn đọc được, hình dáng và màu
// của vật chứa vẫn còn. Độ mờ chọn bằng tập ảnh test/fixtures/vision/adversarial; chữ rất lớn, nét đậm vẫn có thể còn
// đọc được sau khi làm mờ.
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

/**
 * Đầu ra của mô hình phải đúng dạng trước khi được coi là kết quả phân loại, như phản hồi của bộ nhận diện cũ phải đúng schema: đủ số lớp
 * mô hình khai báo (không biết thì ít nhất phải có mọi lớp trong ánh xạ) và mọi giá trị hữu hạn. NaN đi qua softmax thành độ tin cậy
 * NaN: không vượt ngưỡng nên không thưởng nhầm, nhưng lỗi bộ nhận diện sẽ bị ghi thành lượt check-in bị từ chối (hoặc thành lỗi 500).
 * Trả về mô tả lỗi, hoặc null nếu dùng được.
 */
export function logitsProblem(logits, { expectedLength = null, classMapping = {} } = {}) {
  if (!logits || typeof logits.length !== 'number') return 'thiếu tensor đầu ra';
  if (expectedLength !== null) {
    if (logits.length !== expectedLength) return `${logits.length} giá trị, mô hình khai báo ${expectedLength}`;
  } else {
    const mapped = Object.values(classMapping).filter(Array.isArray).flat().filter(Number.isInteger);
    const required = mapped.length > 0 ? Math.max(...mapped) + 1 : 1;
    if (logits.length < required) return `${logits.length} giá trị, ánh xạ cần ít nhất ${required}`;
  }
  for (let i = 0; i < logits.length; i += 1) {
    if (!Number.isFinite(logits[i])) return `giá trị không hữu hạn ở lớp ${i}`;
  }
  return null;
}

/** Một lượt suy luận trên session đã mở → xác suất theo loại nghiệp vụ (ranked); dùng chung cho check-in và bước tự kiểm */
async function rankImage({ session, entry, inputName, outputName, outputSize = null }, buffer) {
  let tensorData;
  try {
    tensorData = await preprocessImage(buffer, entry.input);
  } catch (err) {
    if (err instanceof VisionEngineError) throw err;
    throw new VisionEngineError('invalid_image', err?.message || 'không giải mã được ảnh');
  }
  const ort = await import('onnxruntime-node');
  const input = new ort.Tensor('float32', tensorData, entry.input.shape);
  const results = await session.run({ [inputName]: input });
  const logits = results?.[outputName]?.data;
  const problem = logitsProblem(logits, { expectedLength: outputSize, classMapping: entry.classMapping });
  if (problem) throw new VisionEngineError('invalid_response', `đầu ra của bộ phân loại không hợp lệ: ${problem}`);
  return aggregateMappedClasses(softmax(logits), entry.classMapping);
}

async function inferClassifier({ buffer }, cfg) {
  const ranked = await rankImage(await loadClassifier(cfg), buffer);
  const [top, second] = ranked;
  return {
    category: top.category,
    confidence: top.probability,
    reason: `Nhận diện tại máy chủ (bộ phân loại ${cfg.classifier.model}): ${CATEGORY_LABELS[top.category]} ${percent(top.probability)}; tiếp theo: ${CATEGORY_LABELS[second.category].toLowerCase()} ${percent(second.probability)}.`,
    model: `classifier:${cfg.classifier.model}`,
    ranked,
  };
}

const HOLD_LIMIT_FACTOR = 3;

/**
 * Hàng đợi suy luận: chạy lần lượt từng việc; đã có maxQueue việc chưa xong (đang chạy + đang chờ) thì từ chối ngay (busy).
 * timeoutMs tính từ lúc việc tới lượt chạy, không tính thời gian chờ trong hàng (README mục 8.2).
 * Hết giờ thì người gọi nhận lỗi timeout ngay, nhưng lượt chạy và chỗ trong hàng chỉ được trả khi việc thật sự kết thúc: JavaScript không dừng
 * được suy luận ONNX / sharp đang chạy, trả sớm thì lúc CPU quá tải các lượt bị bỏ dở chạy chồng lên nhau, không còn giới hạn bởi maxQueue.
 * Việc treo hẳn (không bao giờ xong) chỉ giữ hàng tối đa HOLD_LIMIT_FACTOR × timeoutMs rồi bị bỏ, để không khóa nhận diện tới khi khởi động lại.
 */
export function createInferenceQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    run(task, { maxQueue, timeoutMs }) {
      // Kiểm tra và giữ chỗ trong cùng một đoạn đồng bộ (không có await xen giữa) → các lượt gọi đồng thời không vượt được maxQueue
      if (pending >= maxQueue) return Promise.reject(new VisionEngineError('busy', `hàng đợi bộ phân loại đầy (${pending} ảnh)`));
      pending += 1;
      return new Promise((resolve, reject) => {
        // Việc sau chỉ bắt đầu khi hàm này kết thúc, tức là khi việc trước thật sự xong; hàm bắt mọi lỗi nên chuỗi không bao giờ bị từ chối
        tail = tail.then(async () => {
          const timeoutError = new VisionEngineError('timeout', `bộ phân loại chạy quá ${timeoutMs} ms`);
          const timer = setTimeout(() => reject(timeoutError), timeoutMs);
          let holdTimer;
          const holdLimit = new Promise((stop) => {
            holdTimer = setTimeout(() => stop({ error: timeoutError, abandoned: true }), timeoutMs * HOLD_LIMIT_FACTOR);
          });
          let outcome;
          try {
            // Promise.resolve().then: task ném lỗi đồng bộ cũng thành lỗi của lượt này
            outcome = await Promise.race([Promise.resolve().then(task).then((value) => ({ value })), holdLimit]);
          } catch (error) {
            outcome = { error };
          }
          clearTimeout(timer);
          clearTimeout(holdTimer);
          if (outcome.abandoned) {
            console.error(`[vision] Bộ phân loại chưa xong sau ${timeoutMs * HOLD_LIMIT_FACTOR} ms — bỏ lượt này để hàng đợi chạy tiếp.`);
          }
          // Trả chỗ trước khi báo người gọi: lượt nhìn thứ hai gọi ngay sau lượt đầu không bị báo bận nhầm khi maxQueue = 1.
          // Đã hết giờ thì người gọi đã nhận lỗi, resolve / reject dưới đây không còn tác dụng
          pending -= 1;
          if ('error' in outcome) reject(outcome.error);
          else resolve(outcome.value);
        });
      });
    },
  };
}

const inferenceQueue = createInferenceQueue();

/** Phân loại bằng ONNX trong tiến trình. Trả { category, confidence, reason, model, ranked } hoặc ném VisionEngineError */
export async function classifyWithClassifier(image, cfg) {
  return inferenceQueue.run(() => inferClassifier(image, cfg), cfg);
}
