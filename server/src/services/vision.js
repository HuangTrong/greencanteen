import { env, envFlag, envNumber, isProduction } from './config.js';
import { CATEGORIES, CATEGORY_LABELS, REWARDABLE_CATEGORIES, VisionEngineError } from './visionShared.js';
import { CLASSIFIER_MANIFEST, DEFAULT_CLASSIFIER_MODEL, modelDir } from './visionModels.js';
import { classifyWithClassifier, loadClassifier, suppressText } from './visionClassifier.js';

export { CATEGORIES, CATEGORY_LABELS, REWARDABLE_CATEGORIES, VisionEngineError };

const ENGINES = ['classifier'];
// Bộ nhận diện cũ (CLIP, VLM trên Ollama, chế độ kết hợp hai bộ) đã bị gỡ khỏi server. Cấu hình còn sót tên cũ bị
// coi là không hợp lệ: check-in tắt, không tự chuyển sang classifier.
const REMOVED_ENGINES = ['ensemble', 'clip', 'ollama'];

/**
 * Cấu hình nhận diện, đọc lại mỗi lần gọi. Ảnh luôn được xử lý TẠI MÁY CHỦ, trên CPU, không gửi cho dịch vụ nào:
 * - local + engine classifier (mặc định): bộ phân loại ONNX chạy TRỰC TIẾP trong tiến trình (onnxruntime-node).
 *   Ngưỡng phải được hiệu chỉnh bằng vision:evaluate trên ảnh có nhãn của trường trước khi mở thưởng thật
 * - simulated: VISION_SIMULATION=true, CHỈ khi NODE_ENV khác production (kết quả được đánh dấu là mô phỏng)
 * - unavailable: VISION_ENGINE=off, giá trị lạ, tên bộ nhận diện cũ đã gỡ (ensemble/clip/ollama) hoặc mô hình ngoài
 *   manifest → check-in bị từ chối, không bao giờ tự chấp nhận ảnh, không tự chuyển sang chế độ khác
 */
export function visionConfig() {
  const simulationRequested = envFlag('VISION_SIMULATION');
  const simulationBlocked = simulationRequested && isProduction();
  const requested = (env('VISION_ENGINE') || 'classifier').toLowerCase();
  const engine = ENGINES.includes(requested) ? requested : null;
  const classifier = {
    model: env('VISION_CLASSIFIER_MODEL') || DEFAULT_CLASSIFIER_MODEL,
    dir: modelDir(),
    threads: envNumber('VISION_CLASSIFIER_THREADS', 2, { min: 1, max: 8 }),
  };

  let problem = null;
  if (!engine) problem = requested === 'off' ? 'disabled' : REMOVED_ENGINES.includes(requested) ? 'removed_engine' : 'invalid_engine';
  else if (!CLASSIFIER_MANIFEST[classifier.model]) problem = 'unknown_classifier_model';

  // Lần nhìn thứ hai (F-26) mặc định đòi ảnh làm mờ đạt cùng ngưỡng; mô hình có thể khai báo mức riêng đã đo trên tập thiết kế
  const secondLookMin = CLASSIFIER_MANIFEST[classifier.model]?.secondLook?.minConfidence;

  return {
    mode: simulationRequested && !simulationBlocked ? 'simulated' : problem ? 'unavailable' : 'local',
    engine,
    problem,
    simulationBlocked,
    secondLookMinConfidence: typeof secondLookMin === 'number' && secondLookMin >= 0 && secondLookMin <= 1 ? secondLookMin : null,
    // Bước tự kiểm khi nạp (mô hình có selfCheck): enforce = lệch thì không nạp; warn = chỉ ghi lỗi (máy đã được chấm lại)
    selfCheck: (env('VISION_SELF_CHECK') || '').trim().toLowerCase() === 'warn' ? 'warn' : 'enforce',
    threshold: envNumber('VISION_CONFIDENCE_THRESHOLD', 0.8, { min: 0.5, max: 1 }),
    timeoutMs: envNumber('VISION_TIMEOUT_MS', 20_000, { min: 3_000, max: 120_000 }),
    maxQueue: envNumber('VISION_MAX_QUEUE', 20, { min: 1, max: 500 }),
    classifier,
  };
}

export function logVisionStatus(cfg = visionConfig()) {
  if (cfg.simulationBlocked) {
    console.error('VISION_SIMULATION=true bị BỎ QUA vì NODE_ENV=production — mô phỏng không được dùng thay nhận diện thật.');
  }
  if (cfg.mode === 'simulated') {
    console.warn(
      `VISION_SIMULATION=true — check-in dùng kết quả MÔ PHỎNG (${env('VISION_SIMULATED_CATEGORY') || 'reusable_bottle'}), không phải nhận diện thật. Chỉ dùng khi phát triển.`
    );
    return;
  }
  switch (cfg.problem) {
    case 'disabled':
      console.log('VISION_ENGINE=off — check-in bằng ảnh đang tắt.');
      return;
    case 'removed_engine':
      console.error(
        `VISION_ENGINE="${env('VISION_ENGINE')}": CLIP, Ollama và chế độ kết hợp đã bị gỡ khỏi server — check-in bằng ảnh đang tắt. Đặt VISION_ENGINE=classifier (bộ phân loại ONNX chạy trên CPU).`
      );
      return;
    case 'invalid_engine':
      console.error(`VISION_ENGINE="${env('VISION_ENGINE')}" không hợp lệ (chỉ nhận classifier, off) — check-in bằng ảnh đang tắt.`);
      return;
    case 'unknown_classifier_model':
      console.error(
        `VISION_CLASSIFIER_MODEL="${cfg.classifier.model}" không có trong danh sách mô hình đã ghim (src/data/classifier-models.json) — check-in bằng ảnh đang tắt.`
      );
      return;
    default:
  }
  console.log(
    `Nhận diện ảnh tại máy chủ: bộ phân loại ONNX (${cfg.classifier.model}, ${cfg.classifier.threads} luồng CPU), ngưỡng ${cfg.threshold} — ảnh không gửi ra ngoài.`
  );
  // Mô hình đã hiệu chỉnh ngưỡng trên tập có nhãn (manifest calibratedThreshold): ngưỡng thấp hơn thì số thưởng nhầm đã đo không còn đúng
  const calibrated = CLASSIFIER_MANIFEST[cfg.classifier.model]?.calibratedThreshold;
  if (typeof calibrated === 'number' && cfg.threshold < calibrated) {
    console.warn(
      `VISION_CONFIDENCE_THRESHOLD=${cfg.threshold} thấp hơn ngưỡng đã hiệu chỉnh cho ${cfg.classifier.model} (${calibrated}): tỉ lệ thưởng nhầm đã đo chỉ đúng từ ngưỡng đó trở lên.`
    );
  }
  // Production mà mô hình chưa hiệu chỉnh trên ảnh có nhãn: check-in vẫn chạy nhưng gần như không thưởng ảnh thật.
  // Thường do quên đặt VISION_CLASSIFIER_MODEL khi triển khai (mặc định của mã vẫn là mobilenet). Chỉ báo, không chặn
  if (isProduction() && typeof calibrated !== 'number') {
    const calibratedModels = Object.keys(CLASSIFIER_MANIFEST).filter((name) => typeof CLASSIFIER_MANIFEST[name].calibratedThreshold === 'number');
    console.error(
      `VISION_CLASSIFIER_MODEL=${cfg.classifier.model} chưa được hiệu chỉnh trên ảnh có nhãn (manifest không có calibratedThreshold): tỉ lệ nhận đúng và thưởng nhầm chưa đo; mô hình mặc định ${DEFAULT_CLASSIFIER_MODEL} gần như từ chối mọi ảnh thật. ` +
        (calibratedModels.length
          ? `Mô hình đã hiệu chỉnh: ${calibratedModels.join(', ')} (README mục 8.11, Cách 3).`
          : 'Hiệu chỉnh bằng npm run vision:evaluate trước khi mở thưởng thật.')
    );
  }
}

/** Nạp sẵn mô hình khi khởi động để lần check-in đầu không chậm — chỉ ghi log, không chặn server */
export async function warmUpVision(cfg = visionConfig(), { loadOnnx = loadClassifier } = {}) {
  if (cfg.mode !== 'local') return;
  const started = Date.now();
  try {
    const loaded = await loadOnnx(cfg);
    const check = loaded?.selfCheck;
    const checkNote = check
      ? `; tự kiểm ${check.images} ảnh chuẩn: lệch lớn nhất ${check.maxDiff ?? 'không đo được'} (cho phép ${check.tolerance})${check.passed ? '' : ' — KHÔNG ĐẠT, xem lỗi [vision-self-check]'}`
      : '';
    console.log(`Bộ phân loại ONNX đã sẵn sàng (${Date.now() - started} ms)${checkNote}.`);
  } catch (err) {
    console.error(`Chưa nạp được bộ phân loại ONNX: ${err.message}`);
  }
}

const FAILURE_REASONS = {
  not_configured: 'Máy chủ chưa sẵn sàng nhận diện ảnh (chưa cài mô hình hoặc cấu hình chưa đúng). Vui lòng báo quản trị viên.',
  busy: 'Máy chủ đang bận nhận diện nhiều ảnh. Ảnh chưa được chấm — vui lòng thử lại sau ít phút.',
  timeout: 'Nhận diện ảnh mất quá nhiều thời gian. Ảnh chưa được chấm — vui lòng thử lại.',
  invalid_image: 'Máy chủ không đọc được nội dung ảnh. Hãy chụp lại hoặc chọn ảnh JPEG/PNG khác.',
  invalid_response: 'Bộ nhận diện ảnh trên máy chủ trả kết quả không hợp lệ. Ảnh chưa được chấm — vui lòng thử lại sau ít phút.',
  provider_error: 'Bộ nhận diện ảnh trên máy chủ đang gặp lỗi. Ảnh chưa được chấm — vui lòng thử lại sau ít phút.',
};

function failure(status, model, detail) {
  if (detail) console.error(`Vision ${status}: ${detail}`);
  return { status, category: null, confidence: null, reason: FAILURE_REASONS[status], model, accepted: false };
}

function engineFailure(err, model) {
  const status = err instanceof VisionEngineError && FAILURE_REASONS[err.status] ? err.status : 'provider_error';
  return failure(status, model, err?.message || String(err));
}

/** Quyết định cộng thưởng nằm ở server: đúng loại bình/ly cá nhân VÀ đạt ngưỡng tin cậy */
export function isRewardable(result, threshold) {
  return (
    ['classified', 'simulated'].includes(result.status) &&
    REWARDABLE_CATEGORIES.has(result.category) &&
    result.confidence >= threshold
  );
}

function withDecision(result, cfg) {
  return { ...result, accepted: isRewardable(result, cfg.threshold) };
}

/**
 * Lần nhìn thứ hai (F-26): ảnh sắp được thưởng phải vẫn được nhận ra là bình/ly cá nhân VÀ đạt ngưỡng như lần đầu khi chữ
 * trong ảnh đã bị làm mờ, nên kết luận không thể chỉ dựa vào chữ. Mô hình khai báo secondLook.minConfidence trong manifest thì ảnh
 * mờ chỉ cần đạt mức đó (mô hình học trên ảnh chụp mất độ tin cậy trên ảnh mờ dù vật chứa vẫn rõ); kết luận đổi sang loại không
 * được thưởng thì vẫn bị chặn. Bộ phân loại lỗi ở lần hai → không thưởng, không coi như đạt.
 */
async function confirmWithoutText(image, result, cfg, engines, blur) {
  let blurred;
  try {
    blurred = { buffer: await blur(image.buffer), mimeType: 'image/jpeg' };
  } catch (err) {
    return engineFailure(new VisionEngineError('invalid_image', err?.message), result.model);
  }
  let look;
  try {
    look = await engines.classifier(blurred, cfg);
  } catch (err) {
    return engineFailure(err, result.model);
  }
  const secondLook = [{ engine: 'classifier', category: look.category, confidence: look.confidence }];
  const needed = cfg.secondLookMinConfidence ?? cfg.threshold;
  if (REWARDABLE_CATEGORIES.has(look.category) && look.confidence >= needed) return { ...result, secondLook };
  return {
    ...result,
    category: 'unclear',
    accepted: false,
    textDependent: true,
    secondLook,
    reason: `Kết luận thay đổi khi chữ trong ảnh được làm mờ: bộ phân loại «${CATEGORY_LABELS[look.category]}».`,
  };
}

async function firstLook(image, cfg, engines) {
  try {
    return withDecision({ status: 'classified', ...(await engines.classifier(image, cfg)) }, cfg);
  } catch (err) {
    return engineFailure(err, `classifier:${cfg.classifier.model}`);
  }
}

/**
 * Phân loại ảnh vật chứa đồ uống tại máy chủ. Kết quả luôn có dạng
 * { status, category, confidence, reason, model, accepted } — status:
 * classified | simulated | not_configured | busy | timeout | invalid_image | invalid_response | provider_error
 * (ảnh qua lần nhìn thứ hai thêm `secondLook`, kết luận đổi thì có `textDependent`)
 */
export async function classifyContainerImage(image, cfg = visionConfig(), engines = { classifier: classifyWithClassifier }, blur = suppressText) {
  if (cfg.mode === 'simulated') return withDecision(simulate(), cfg);
  if (cfg.mode !== 'local') return failure('not_configured', null);
  const result = await firstLook(image, cfg, engines);
  return result.accepted ? confirmWithoutText(image, result, cfg, engines, blur) : result;
}

/** Chế độ mô phỏng: kết quả CỐ ĐỊNH theo cấu hình, không dựa trên nội dung ảnh, hash hay ngẫu nhiên */
function simulate() {
  const configured = env('VISION_SIMULATED_CATEGORY');
  const category = Object.hasOwn(CATEGORY_LABELS, configured) ? configured : 'reusable_bottle';
  return {
    status: 'simulated',
    category,
    confidence: envNumber('VISION_SIMULATED_CONFIDENCE', 0.99, { min: 0, max: 1 }),
    reason: `[MÔ PHỎNG — không phải nhận diện thật] ${CATEGORY_LABELS[category]}.`,
    model: 'simulation',
  };
}
