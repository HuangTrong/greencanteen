import { env, envFlag, envNumber, isProduction } from './config.js';
import { CATEGORIES, CATEGORY_LABELS, REWARDABLE_CATEGORIES, VisionEngineError } from './visionShared.js';
import { DEFAULT_CLIP_MODEL, MODEL_MANIFEST, modelDir } from './visionModels.js';
import { classifyWithOllama, isAllowedOllamaUrl, isOllamaCloudModel } from './visionOllama.js';
import { classifyWithClip, loadClassifier, suppressText } from './visionClip.js';

export { CATEGORIES, CATEGORY_LABELS, REWARDABLE_CATEGORIES, VisionEngineError };
export { parseClassification } from './visionOllama.js';

const ENGINES = ['clip', 'ollama', 'ensemble'];
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen3-vl:4b-instruct';
const usesClip = (engine) => engine === 'clip' || engine === 'ensemble';
const usesOllama = (engine) => engine === 'ollama' || engine === 'ensemble';

/**
 * Cấu hình nhận diện, đọc lại mỗi lần gọi. Ảnh luôn được xử lý TẠI MÁY CHỦ, không gửi cho dịch vụ cloud:
 * - local + engine ensemble (mặc định): CLIP + VLM — chỉ thưởng khi cả hai cùng nhận ra bình/ly cá nhân
 * - local + engine ollama: VLM chạy trên Ollama trong mạng nội bộ (host phải là loopback / mạng riêng). Bị tắt khi production:
 *   đo trên tập ảnh đối kháng, VLM một mình vẫn thưởng nhầm dù đã nhìn lại trên ảnh làm mờ, nên production phải dùng ensemble
 * - local + engine clip: CLIP một mình, CHỈ khi VISION_ALLOW_CLIP_ONLY=true và NODE_ENV khác production: CLIP bị chữ trong ảnh
 *   đánh lừa (F-26) nên không đủ để cấp thưởng. Cấu hình khác → unavailable (503), không tự chuyển sang chế độ khác
 * - simulated: VISION_SIMULATION=true, CHỈ khi NODE_ENV khác production (kết quả được đánh dấu là mô phỏng)
 * - unavailable: VISION_ENGINE=off hoặc cấu hình sai → check-in bị từ chối, không bao giờ tự chấp nhận ảnh
 * evaluating: chỉ để script vision:evaluate đo CLIP một mình; không cấp thưởng gì.
 */
export function visionConfig({ evaluating = false } = {}) {
  const simulationRequested = envFlag('VISION_SIMULATION');
  const simulationBlocked = simulationRequested && isProduction();
  const clipOnlyRequested = envFlag('VISION_ALLOW_CLIP_ONLY');
  const clipOnlyBlocked = clipOnlyRequested && isProduction();
  const requested = (env('VISION_ENGINE') || 'ensemble').toLowerCase();
  const engine = ENGINES.includes(requested) ? requested : null;
  const clip = { model: env('VISION_CLIP_MODEL') || DEFAULT_CLIP_MODEL, dir: modelDir() };
  const ollama = {
    url: (env('VISION_OLLAMA_URL') || DEFAULT_OLLAMA_URL).replace(/\/+$/, ''),
    model: env('VISION_OLLAMA_MODEL') || DEFAULT_OLLAMA_MODEL,
  };

  let problem = null;
  if (!engine) problem = requested === 'off' ? 'disabled' : 'invalid_engine';
  else if (engine === 'clip' && !evaluating && (!clipOnlyRequested || clipOnlyBlocked)) problem = 'clip_only_not_allowed';
  else if (engine === 'ollama' && !evaluating && isProduction()) problem = 'vlm_only_not_allowed';
  else if (usesClip(engine) && !MODEL_MANIFEST[clip.model]) problem = 'unknown_model';
  else if (usesOllama(engine) && !isAllowedOllamaUrl(ollama.url, { trusted: envFlag('VISION_OLLAMA_TRUSTED_HOST') }).ok) {
    problem = 'ollama_host_not_private';
  } else if (usesOllama(engine) && isOllamaCloudModel(ollama.model)) problem = 'ollama_cloud_model';

  return {
    mode: simulationRequested && !simulationBlocked ? 'simulated' : problem ? 'unavailable' : 'local',
    engine,
    problem,
    simulationBlocked,
    clipOnlyBlocked,
    threshold: envNumber('VISION_CONFIDENCE_THRESHOLD', 0.8, { min: 0.5, max: 1 }),
    timeoutMs: envNumber('VISION_TIMEOUT_MS', 20_000, { min: 3_000, max: 120_000 }),
    maxQueue: envNumber('VISION_MAX_QUEUE', 20, { min: 1, max: 500 }),
    clip,
    ollama,
  };
}

export function logVisionStatus(cfg = visionConfig()) {
  if (cfg.simulationBlocked) {
    console.error('VISION_SIMULATION=true bị BỎ QUA vì NODE_ENV=production — mô phỏng không được dùng thay nhận diện thật.');
  }
  if (cfg.clipOnlyBlocked) {
    console.error('VISION_ALLOW_CLIP_ONLY=true bị BỎ QUA vì NODE_ENV=production — CLIP một mình không được dùng để cấp thưởng.');
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
    case 'invalid_engine':
      console.error(`VISION_ENGINE="${env('VISION_ENGINE')}" không hợp lệ (chỉ nhận clip, ollama, ensemble, off) — check-in bằng ảnh đang tắt.`);
      return;
    case 'clip_only_not_allowed':
      console.error(
        'VISION_ENGINE=clip: CLIP một mình bị chữ trong ảnh đánh lừa (F-26) nên check-in bằng ảnh đang tắt. Dùng VISION_ENGINE=ensemble với Ollama trong mạng nội bộ.'
      );
      return;
    case 'vlm_only_not_allowed':
      console.error('VISION_ENGINE=ollama: VLM một mình cũng bị chữ trong ảnh đánh lừa (F-26) nên check-in bằng ảnh đang tắt khi NODE_ENV=production. Dùng VISION_ENGINE=ensemble.');
      return;
    case 'unknown_model':
      console.error(
        `VISION_CLIP_MODEL="${cfg.clip.model}" không có trong danh sách mô hình đã ghim (src/data/vision-models.json) — check-in bằng ảnh đang tắt.`
      );
      return;
    case 'ollama_host_not_private':
      console.error(
        `VISION_OLLAMA_URL=${cfg.ollama.url} không phải máy trong mạng nội bộ — check-in bị tắt để ảnh không rời máy chủ. Đặt VISION_OLLAMA_TRUSTED_HOST=true nếu máy đó thuộc quyền quản lý của trường.`
      );
      return;
    case 'ollama_cloud_model':
      console.error(
        `VISION_OLLAMA_MODEL="${cfg.ollama.model}" là mô hình cloud của Ollama — ảnh sẽ bị chuyển lên ollama.com nên check-in bằng ảnh đang tắt. Dùng mô hình chạy tại máy (vd. qwen3-vl:4b-instruct) và đặt OLLAMA_NO_CLOUD=1 trên máy Ollama.`
      );
      return;
    default:
  }
  if (cfg.engine === 'clip') console.warn('VISION_ALLOW_CLIP_ONLY=true — CLIP một mình cấp thưởng và có thể bị chữ trong ảnh đánh lừa. Chỉ dùng khi phát triển.');
  const parts = [];
  if (usesClip(cfg.engine)) parts.push(`CLIP (${cfg.clip.model})`);
  if (usesOllama(cfg.engine)) parts.push(`Ollama ${cfg.ollama.model} tại ${cfg.ollama.url}`);
  console.log(
    `Nhận diện ảnh tại máy chủ: ${parts.join(' + ')}, ngưỡng ${cfg.threshold} — ảnh không gửi ra ngoài.${cfg.engine === 'ensemble' ? ' Chỉ thưởng khi cả hai bộ cùng nhận ra bình/ly cá nhân.' : ''}`
  );
}

/** Nạp sẵn mô hình / kiểm tra Ollama khi khởi động để lần check-in đầu không chậm — chỉ ghi log, không chặn server */
export async function warmUpVision(cfg = visionConfig(), { load = loadClassifier, fetchImpl = fetch } = {}) {
  if (cfg.mode !== 'local') return;
  if (usesClip(cfg.engine)) {
    const started = Date.now();
    try {
      await load(cfg);
      console.log(`Mô hình CLIP đã sẵn sàng (${Date.now() - started} ms).`);
    } catch (err) {
      console.error(`Chưa nạp được mô hình CLIP: ${err.message}`);
    }
  }
  if (usesOllama(cfg.engine)) {
    try {
      const res = await fetchImpl(`${cfg.ollama.url}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const { models = [] } = await res.json();
      if (models.some((m) => m.name === cfg.ollama.model || m.model === cfg.ollama.model)) {
        console.log(`Ollama sẵn sàng: ${cfg.ollama.model}.`);
      } else {
        console.error(`Ollama chưa có mô hình ${cfg.ollama.model} — chạy "ollama pull ${cfg.ollama.model}" trên máy chủ Ollama.`);
      }
    } catch (err) {
      console.error(`Không kết nối được Ollama tại ${cfg.ollama.url}: ${err.message}`);
    }
  }
}

const FAILURE_REASONS = {
  not_configured: 'Máy chủ chưa sẵn sàng nhận diện ảnh (chưa cài mô hình hoặc cấu hình chưa đúng). Vui lòng báo quản trị viên.',
  busy: 'Máy chủ đang bận nhận diện nhiều ảnh. Ảnh chưa được chấm — vui lòng thử lại sau ít phút.',
  timeout: 'Nhận diện ảnh mất quá nhiều thời gian. Ảnh chưa được chấm — vui lòng thử lại.',
  invalid_image: 'Máy chủ không đọc được nội dung ảnh. Hãy chụp lại hoặc chọn ảnh JPEG/PNG khác.',
  invalid_response: 'Bộ nhận diện trả về kết quả không hợp lệ nên ảnh chưa được chấm. Vui lòng thử lại.',
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

const percent = (value) => `${Math.round(value * 100)}%`;

/**
 * Kết hợp CLIP + VLM: cả hai cùng là bình/ly cá nhân → loại theo VLM, độ tin cậy lấy giá trị THẤP hơn; cùng một loại
 * khác → giữ loại đó; khác loại → "unclear" (không thưởng). Một bộ lỗi → không thưởng, không tự hạ xuống một bộ.
 */
async function classifyEnsemble(image, cfg, engines) {
  const [clip, vlm] = await Promise.allSettled([engines.clip(image, cfg), engines.ollama(image, cfg)]);
  const fallbackModel = `ensemble:clip:${cfg.clip.model}+ollama:${cfg.ollama.model}`;
  for (const settled of [clip, vlm]) {
    if (settled.status === 'rejected') return engineFailure(settled.reason, fallbackModel);
  }
  const a = clip.value;
  const b = vlm.value;
  const base = {
    status: 'classified',
    confidence: Math.min(a.confidence, b.confidence),
    model: `ensemble:${a.model}+${b.model}`,
    engines: [
      { engine: 'clip', category: a.category, confidence: a.confidence, model: a.model },
      { engine: 'ollama', category: b.category, confidence: b.confidence, model: b.model },
    ],
  };
  if (REWARDABLE_CATEGORIES.has(a.category) && REWARDABLE_CATEGORIES.has(b.category)) {
    const reason = `${b.reason} (CLIP: ${CATEGORY_LABELS[a.category].toLowerCase()} ${percent(a.confidence)})`;
    return withDecision({ ...base, category: b.category, reason }, cfg);
  }
  if (a.category === b.category) return withDecision({ ...base, category: b.category, reason: b.reason }, cfg);
  return withDecision(
    {
      ...base,
      category: 'unclear',
      disagreement: true,
      reason: `Hai bộ nhận diện tại máy chủ chưa thống nhất: CLIP «${CATEGORY_LABELS[a.category]}» ${percent(a.confidence)}, VLM «${CATEGORY_LABELS[b.category]}» ${percent(b.confidence)}.`,
    },
    cfg
  );
}

/**
 * Lần nhìn thứ hai (F-26): ảnh sắp được thưởng phải vẫn được nhận ra là bình/ly cá nhân khi chữ trong ảnh đã bị làm mờ, nên kết luận
 * không thể chỉ dựa vào chữ. CLIP chỉ cần giữ loại đứng đầu vì ảnh mờ luôn làm điểm CLIP tụt (đo được 0,33–0,68 trên bình thật có nhãn);
 * VLM phải đạt ngưỡng như lần đầu. Một bộ lỗi → không thưởng, không coi như đạt.
 */
async function confirmWithoutText(image, result, cfg, engines, blur) {
  let blurred;
  try {
    blurred = { buffer: await blur(image.buffer), mimeType: 'image/jpeg' };
  } catch (err) {
    return engineFailure(new VisionEngineError('invalid_image', err?.message), result.model);
  }
  const names = cfg.engine === 'ensemble' ? ['clip', 'ollama'] : ['ollama'];
  const looks = await Promise.allSettled(names.map((name) => engines[name](blurred, cfg)));
  const failed = looks.find((look) => look.status === 'rejected');
  if (failed) return engineFailure(failed.reason, result.model);

  const secondLook = names.map((engine, i) => ({ engine, category: looks[i].value.category, confidence: looks[i].value.confidence }));
  const stable = secondLook.every(({ engine, category, confidence }) => REWARDABLE_CATEGORIES.has(category) && (engine === 'clip' || confidence >= cfg.threshold));
  if (stable) return { ...result, secondLook };
  return {
    ...result,
    category: 'unclear',
    accepted: false,
    textDependent: true,
    secondLook,
    reason: `Kết luận thay đổi khi chữ trong ảnh được làm mờ: ${secondLook.map(({ engine, category }) => `${engine === 'clip' ? 'CLIP' : 'VLM'} «${CATEGORY_LABELS[category]}»`).join(', ')}.`,
  };
}

async function firstLook(image, cfg, engines) {
  if (cfg.engine === 'ensemble') return classifyEnsemble(image, cfg, engines);
  try {
    return withDecision({ status: 'classified', ...(await engines[cfg.engine](image, cfg)) }, cfg);
  } catch (err) {
    return engineFailure(err, cfg.engine === 'clip' ? `clip:${cfg.clip.model}` : `ollama:${cfg.ollama.model}`);
  }
}

/**
 * Phân loại ảnh vật chứa đồ uống tại máy chủ. Kết quả luôn có dạng
 * { status, category, confidence, reason, model, accepted } — status:
 * classified | simulated | not_configured | busy | timeout | invalid_image | invalid_response | provider_error
 * (chế độ ensemble thêm `engines` và `disagreement`; ảnh qua lần nhìn thứ hai thêm `secondLook`, kết luận đổi thì có `textDependent`)
 */
export async function classifyContainerImage(image, cfg = visionConfig(), engines = { clip: classifyWithClip, ollama: classifyWithOllama }, blur = suppressText) {
  if (cfg.mode === 'simulated') return withDecision(simulate(), cfg);
  if (cfg.mode !== 'local') return failure('not_configured', null);
  const result = await firstLook(image, cfg, engines);
  // CLIP một mình chỉ có ở chế độ phát triển, không cấp thưởng thật nên không cần nhìn lại
  return result.accepted && usesOllama(cfg.engine) ? confirmWithoutText(image, result, cfg, engines, blur) : result;
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
