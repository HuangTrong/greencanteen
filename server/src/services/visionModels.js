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
export const MODEL_MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/vision-models.json'), 'utf8'));
export const DEFAULT_CLIP_MODEL = 'Xenova/clip-vit-base-patch16';

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

/** Tải mô hình theo commit đã ghim; mỗi tệp được kiểm tra kích thước + mã băm TRƯỚC khi đặt vào thư mục mô hình */
export async function downloadModel(model, { dir = modelDir(), manifest = MODEL_MANIFEST, fetchImpl = fetch, log = console.log } = {}) {
  const entry = manifest[model];
  if (!entry) throw new Error(`Mô hình "${model}" không có trong danh sách đã ghim (src/data/vision-models.json).`);
  for (const [file, expected] of Object.entries(entry.files)) {
    const target = modelFilePath(model, file, dir);
    if (!(await fileProblem(target, expected))) {
      log(`✔ ${file} (đã có, đúng mã băm)`);
      continue;
    }
    log(`↓ ${file} (${(expected.size / 1048576).toFixed(1)} MB)`);
    const res = await fetchImpl(`https://huggingface.co/${model}/resolve/${entry.revision}/${file}`, {
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
