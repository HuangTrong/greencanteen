import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { env } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '../..');

/**
 * Mô hình đã ghim: commit trên Hugging Face Hub + kích thước + mã băm từng tệp. Mô hình chỉ vào máy qua
 * `npm run vision:download` (kiểm tra mã băm trước khi ghi); server không bao giờ tự tải mô hình lúc chạy.
 */
const { _format, ...classifierEntries } = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/classifier-models.json'), 'utf8'));
/** Danh sách mô hình đã ghim (bộ phân loại ONNX) — dùng cho npm run vision:download / vision:verify */
export const MODEL_MANIFEST = { ...classifierEntries };
export { classifierEntries as CLASSIFIER_MANIFEST };
export const DEFAULT_CLASSIFIER_MODEL = 'onnxmodelzoo/mobilenetv3_small_075_Opset17';

export const modelDir = () => path.resolve(serverRoot, env('VISION_MODEL_DIR') || 'models');
export const modelFilePath = (model, file, dir = modelDir()) => path.join(dir, ...model.split('/'), ...file.split('/'));

/** SHA-1 kiểu git blob — mã Hugging Face Hub dùng cho tệp nhỏ (không lưu qua LFS) */
export function gitBlobSha1(buffer) {
  return crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

/** null nếu tệp khớp kích thước và mã băm; ngược lại: missing | size_mismatch | hash_mismatch */
async function fileProblem(file, expected) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return 'missing';
  }
  if (stat.size !== expected.size) return 'size_mismatch';
  const hash = crypto.createHash(expected.sha256 ? 'sha256' : 'sha1');
  if (!expected.sha256) hash.update(`blob ${stat.size}\0`);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === (expected.sha256 || expected.gitSha1) ? null : 'hash_mismatch';
}

/** Kiểm tra mọi tệp của mô hình — [] nghĩa là đủ tệp và đúng mã băm */
export async function verifyModelFiles(model, dir = modelDir(), manifest = MODEL_MANIFEST) {
  const entry = manifest[model];
  if (!entry) return [{ file: null, problem: 'unknown_model' }];
  const problems = [];
  for (const [file, expected] of Object.entries(entry.files)) {
    const problem = await fileProblem(modelFilePath(model, file, dir), expected);
    if (problem) problems.push({ file, problem });
  }
  return problems;
}

/**
 * Tải mô hình theo commit đã ghim; mỗi tệp được kiểm tra kích thước + mã băm TRƯỚC khi đặt vào thư mục mô hình.
 * Mô hình huấn luyện tại chỗ (source: "local") không có trên Hugging Face: chỉ tải khi người vận hành đưa địa chỉ HTTPS của tệp (url,
 * lấy từ VISION_MODEL_URL), vẫn kiểm đúng kích thước + sha256 ghim trong manifest; không có url thì báo cách chép tệp vào.
 */
export async function downloadModel(model, { dir = modelDir(), manifest = MODEL_MANIFEST, fetchImpl = fetch, log = console.log, url = null } = {}) {
  const entry = manifest[model];
  if (!entry) throw new Error(`Mô hình "${model}" không có trong danh sách đã ghim (src/data/classifier-models.json).`);
  if (url) {
    if (entry.source !== 'local') throw new Error('VISION_MODEL_URL chỉ dùng cho mô hình huấn luyện tại chỗ; mô hình trên Hugging Face luôn tải theo commit đã ghim.');
    if (!/^https:\/\//i.test(url)) throw new Error('VISION_MODEL_URL phải là địa chỉ https://.');
    if (Object.keys(entry.files).length !== 1) throw new Error(`Mô hình "${model}" có nhiều tệp, VISION_MODEL_URL chỉ trỏ được tới một tệp.`);
  }
  for (const [file, expected] of Object.entries(entry.files)) {
    const target = modelFilePath(model, file, dir);
    if (!(await fileProblem(target, expected))) {
      log(`✔ ${file} (đã có, đúng mã băm)`);
      continue;
    }
    if (entry.source === 'local' && !url) {
      throw new Error(
        `Mô hình "${model}" được huấn luyện tại chỗ, không có nơi tải tự động. Chép ${file} (${expected.size} byte, sha256 ${expected.sha256}) vào ${target} rồi chạy "npm run vision:verify ${model}", hoặc đặt VISION_MODEL_URL là địa chỉ HTTPS của tệp rồi chạy "npm run vision:download ${model}".`
      );
    }
    log(`↓ ${file} (${(expected.size / 1048576).toFixed(1)} MB)`);
    const res = await fetchImpl(entry.source === 'local' ? url : `https://huggingface.co/${model}/resolve/${entry.revision}/${file}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    if (!res.ok || !res.body) throw new Error(`Tải ${file} thất bại: HTTP ${res.status}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.download`;
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(temp));
      if (await fileProblem(temp, expected)) {
        throw new Error(`${file}: kích thước hoặc mã băm không khớp manifest — đã bỏ tệp này.`);
      }
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
    log(`✔ ${file}`);
  }
}
