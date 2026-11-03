// `npm run dev`: chạy server và tự khởi động lại khi mã nguồn trong src/ THỰC SỰ thay đổi.
//
// Không dùng `node --watch`: trên Windows (NTFS bật cập nhật thời điểm truy cập) nó coi việc ĐỌC một tệp
// là thay đổi — vd. lần POST đầu tiên nạp module mã hóa của iconv-lite, hay trình soạn thảo / npm test /
// công cụ khác đọc mã nguồn — và khởi động lại server giữa lúc đang xử lý: request bị ngắt (proxy Vite báo
// ECONNRESET) và DB in-memory bị xóa sạch. Ở đây chỉ khởi động lại khi mtime hoặc kích thước tệp đổi.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const SHUTDOWN_GRACE_MS = 8000;
// Tệp tạm của trình soạn thảo khi lưu (vd. index.js.tmp.123, file~, .swp) — tệp thật vẫn phát sự kiện riêng
const EDITOR_TEMP = /(\.tmp\.[\w.]+|~|\.sw[a-p])$/;

/** "mtime:kích thước" của tệp; null nếu là thư mục; 'deleted' nếu tệp không còn */
function signatureOf(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : null;
  } catch {
    return 'deleted';
  }
}

const signatures = new Map();
for (const name of fs.readdirSync(srcDir, { recursive: true })) {
  const file = path.join(srcDir, name);
  const signature = signatureOf(file);
  if (signature) signatures.set(file, signature);
}

let child = null;
let restartTimer = null;
let exiting = false;

function start() {
  const current = spawn(process.execPath, [path.join('src', 'index.js')], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  child = current;
  current.on('exit', (code, signal) => {
    if (child !== current || exiting) return;
    child = null;
    console.log(`[dev] Server đã dừng (${signal || `mã ${code}`}). Sửa một tệp trong src/ để chạy lại.`);
  });
}

/** Nhờ server tự dừng êm (trả xong request đang xử lý) rồi mới gọi onExit; quá hạn thì buộc dừng */
function stop(target, onExit) {
  if (!target || target.exitCode !== null || target.signalCode !== null) return onExit();
  target.once('exit', onExit);
  const force = setTimeout(() => target.kill(), SHUTDOWN_GRACE_MS);
  target.once('exit', () => clearTimeout(force));
  if (target.connected) target.send({ type: 'shutdown' });
  else target.kill();
}

function scheduleRestart(reason) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`[dev] ${reason} — khởi động lại server`);
    const old = child;
    child = null;
    stop(old, start);
  }, 150);
}

fs.watch(srcDir, { recursive: true }, (_event, name) => {
  if (!name || EDITOR_TEMP.test(name.toString())) return;
  const file = path.join(srcDir, name.toString());
  const signature = signatureOf(file);
  if (signature === null || signatures.get(file) === signature) return; // thư mục, hoặc chỉ bị đọc
  signatures.set(file, signature);
  scheduleRestart(`${path.relative(root, file)} thay đổi`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (exiting) return;
    exiting = true;
    clearTimeout(restartTimer);
    stop(child, () => process.exit(0));
  });
}

start();
