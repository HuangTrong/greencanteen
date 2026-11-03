// `npm run setup` (trên Windows: bấm đúp setup.cmd): tải và chuẩn bị mọi thứ hệ thống cần. Chạy lại nhiều lần an toàn: bước nào đã
// có thì bỏ qua, giá trị đã đặt trong server/.env không bị ghi đè. Mật khẩu và khóa sinh ngẫu nhiên, chỉ ghi vào tệp, không in ra màn hình.
//   --mongo-dir <thư mục>  nơi cài MongoDB trên Windows (mặc định D:\MongoDB, không có ổ D thì thư mục người dùng)
//   --mongo-port <cổng>    mặc định 27017
//   --skip-mongodb         dùng MongoDB có sẵn hoặc Atlas
//   --skip-ollama          không kiểm tra, không tải mô hình Ollama
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const CLIENT = path.join(ROOT, 'client');
const ENV_PATH = path.join(SERVER, '.env');

// Ghim phiên bản và mã băm. Driver mongodb 6.20 chỉ hỗ trợ server tới 8.2: đổi phiên bản thì chạy lại test với MONGOMS_SYSTEM_BINARY
const MONGODB = {
  version: '8.0.34',
  url: 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.34.zip',
  sha256: '6b021a0864494e4decf278b36477a29eb36072432773e4e62c2f42c302630db0',
  folder: 'mongodb-win32-x86_64-windows-8.0.34',
};
const DB_NAME = 'greencanteen';
const ROOT_USER = 'greencanteen_root';
const APP_USER = 'greencanteen_app';
const APP_ROLE = 'greencanteenApp';
// Đủ cho mọi thao tác của ứng dụng, không có dropCollection, dropDatabase, dropIndex, renameCollection
const APP_ACTIONS = ['find', 'insert', 'update', 'remove', 'createCollection', 'createIndex', 'listCollections', 'listIndexes', 'collStats', 'dbStats'];
const OLLAMA_URL = 'http://127.0.0.1:11434';
const OLLAMA_MODEL = 'qwen3-vl:4b-instruct';

const { values: options } = parseArgs({
  options: {
    'mongo-dir': { type: 'string' },
    'mongo-port': { type: 'string', default: '27017' },
    'skip-mongodb': { type: 'boolean', default: false },
    'skip-ollama': { type: 'boolean', default: false },
  },
});
const MONGO_DIR = options['mongo-dir'] ? path.resolve(options['mongo-dir']) : fs.existsSync('D:\\') ? 'D:\\MongoDB' : path.join(os.homedir(), 'MongoDB');
const MONGO_PORT = Number(options['mongo-port']);
const MONGO_CONFIG = path.join(MONGO_DIR, 'mongod.cfg');
const MONGO_ADMIN_FILE = path.join(MONGO_DIR, 'mongodb-admin.txt');
const MONGOD = path.join(MONGO_DIR, 'server', MONGODB.version, 'bin', 'mongod.exe');

/** Việc người dùng còn phải tự làm, in ở cuối */
const todo = [];

function run(command, cwd, env = {}) {
  return spawnSync(command, { cwd, stdio: 'inherit', shell: true, env: { ...process.env, ...env } }).status === 0;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envValue(name) {
  if (!fs.existsSync(ENV_PATH)) return '';
  return fs.readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
}

/** Thay dòng đã có (giữ nguyên chỗ trong tệp) hoặc thêm vào cuối kèm chú thích */
function setEnvValue(name, value, comment) {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const line = new RegExp(`^${name}=.*$`, 'm');
  if (line.test(text)) return fs.writeFileSync(ENV_PATH, text.replace(line, () => `${name}=${value}`));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const prefix = text === '' || text.endsWith('\n') ? '' : eol;
  fs.appendFileSync(ENV_PATH, `${prefix}# ${comment}${eol}${name}=${value}${eol}`);
}

function installDependencies(dir) {
  // Chỉ cài khi chưa có: npm ci xóa node_modules, làm hỏng server dev đang chạy
  if (fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json'))) return 'đã có';
  // Linux x64: onnxruntime-node mặc định tải thêm thư viện CUDA từ nuget, server chỉ dùng CPU
  if (!run('npm ci', dir, { ONNXRUNTIME_NODE_INSTALL: 'skip' })) throw new Error(`npm ci lỗi trong ${path.relative(ROOT, dir)}`);
  return 'đã cài';
}

function prepareEnvFile() {
  if (fs.existsSync(ENV_PATH)) return 'đã có, giữ nguyên';
  fs.copyFileSync(path.join(SERVER, '.env.example'), ENV_PATH);
  // .env.example khuyên 60000 khi dùng ensemble: nạp lại mô hình trên Ollama mất tới 18 giây
  setEnvValue('VISION_TIMEOUT_MS', '60000');
  return 'đã tạo từ .env.example';
}

function prepareClipModel() {
  if (run('npm run vision:verify', SERVER)) return 'đã có, khớp mã băm';
  if (!run('npm run vision:download', SERVER)) throw new Error('Tải mô hình CLIP lỗi');
  return 'đã tải, khớp mã băm';
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Ghi ra tệp tạm, chỉ đổi tên khi mã băm khớp để lần chạy sau không nhận nhầm tệp tải dở */
async function downloadVerified({ url, sha256 }, file) {
  if (fs.existsSync(file) && (await sha256File(file)) === sha256) return;
  console.log(`Đang tải ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tải MongoDB lỗi: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const temp = `${file}.tmp`;
  const output = fs.createWriteStream(temp);
  let received = 0;
  let shown = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    if (!output.write(chunk)) await once(output, 'drain');
    received += chunk.length;
    const percent = total ? Math.floor((received / total) * 10) * 10 : 0;
    if (percent > shown) console.log(`  ${(shown = percent)}%`);
  }
  output.end();
  await once(output, 'finish');
  if (hash.digest('hex') !== sha256) {
    fs.rmSync(temp, { force: true });
    throw new Error('Mã băm tệp MongoDB không khớp, đã hủy tệp vừa tải');
  }
  fs.renameSync(temp, file);
}

function startScript() {
  return [
    '@echo off',
    `rem Khoi dong MongoDB cho GreenCanteen, chay an. Cau hinh: mongod.cfg, nhat ky: log\\mongod.log`,
    `powershell -NoProfile -Command "if (Get-Process mongod -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${MONGOD}' }) { Write-Output 'MongoDB dang chay.' } else { Start-Process -FilePath '${MONGOD}' -WorkingDirectory '${MONGO_DIR}' -ArgumentList '--config','mongod.cfg' -WindowStyle Hidden; Write-Output 'Da khoi dong MongoDB.' }"`,
    '',
  ].join('\r\n');
}

async function installMongodb() {
  if (!fs.existsSync(MONGOD)) {
    const downloads = path.join(MONGO_DIR, 'downloads');
    const servers = path.join(MONGO_DIR, 'server');
    fs.mkdirSync(downloads, { recursive: true });
    fs.mkdirSync(servers, { recursive: true });
    const zip = path.join(downloads, path.basename(MONGODB.url));
    await downloadVerified(MONGODB, zip);
    console.log('Đang giải nén (bỏ tệp .pdb gỡ lỗi ~2 GB)...');
    const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
    if (spawnSync(tar, ['-xf', zip, '-C', servers, '--exclude', '*.pdb'], { stdio: 'inherit' }).status !== 0) throw new Error('Giải nén MongoDB lỗi');
    fs.renameSync(path.join(servers, MONGODB.folder), path.join(servers, MONGODB.version));
    fs.rmSync(downloads, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(MONGO_DIR, 'data'), { recursive: true });
  fs.mkdirSync(path.join(MONGO_DIR, 'log'), { recursive: true });
  fs.writeFileSync(
    MONGO_CONFIG,
    [
      '# MongoDB cho GreenCanteen tren may nay. Chi nghe 127.0.0.1, bat buoc dang nhap.',
      'storage:',
      `  dbPath: '${path.join(MONGO_DIR, 'data')}'`,
      '  wiredTiger:',
      '    engineConfig:',
      '      # Mac dinh la khoang 50% RAM; 1 GB du cho may phat trien va khong chiem bo nho cua ung dung khac',
      '      cacheSizeGB: 1',
      'systemLog:',
      '  destination: file',
      `  path: '${path.join(MONGO_DIR, 'log', 'mongod.log')}'`,
      '  logAppend: true',
      'net:',
      '  bindIp: 127.0.0.1',
      `  port: ${MONGO_PORT}`,
      'security:',
      '  authorization: enabled',
      '',
    ].join('\r\n')
  );
  fs.writeFileSync(path.join(MONGO_DIR, 'start-mongodb.cmd'), startScript());
}

async function startMongod() {
  if (await portOpen(MONGO_PORT)) return 'đang chạy';
  spawn(MONGOD, ['--config', MONGO_CONFIG], { cwd: MONGO_DIR, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let waited = 0; waited < 30; waited += 1) {
    if (await portOpen(MONGO_PORT)) return 'đã khởi động';
    await pause(1000);
  }
  // mongod cần Visual C++ Redistributable; máy thiếu thư viện này thì mongod tắt trước cả khi kịp ghi nhật ký
  throw new Error(`MongoDB không mở cổng ${MONGO_PORT}. Xem ${path.join(MONGO_DIR, 'log', 'mongod.log')}; chưa có nhật ký thì chạy vc_redist.x64.exe trong ${path.dirname(MONGOD)} rồi chạy lại`);
}

async function createAccounts() {
  if (fs.existsSync(MONGO_ADMIN_FILE)) {
    throw new Error(`Đã có ${MONGO_ADMIN_FILE} nhưng server/.env chưa có tài khoản: đặt lại MONGODB_URI bằng tay, script không tạo tài khoản mới`);
  }
  const { MongoClient } = createRequire(path.join(SERVER, 'package.json'))('mongodb');
  const host = `127.0.0.1:${MONGO_PORT}`;
  const clientOptions = { serverSelectionTimeoutMS: 30000 };
  const rootPassword = crypto.randomBytes(24).toString('hex');
  const appPassword = crypto.randomBytes(24).toString('hex');
  const rootUri = `mongodb://${ROOT_USER}:${rootPassword}@${host}/admin`;

  // Ghi trước khi tạo tài khoản: lỗi giữa chừng vẫn còn mật khẩu root để sửa
  fs.writeFileSync(
    MONGO_ADMIN_FILE,
    ['Tài khoản quản trị MongoDB cục bộ của GreenCanteen. Ứng dụng không dùng tài khoản này.', 'Chỉ dùng để quản trị (sửa quyền, xóa collection). Không đưa lên mạng, không gửi cho ai.', `Chuỗi kết nối: ${rootUri}`, ''].join('\r\n')
  );

  // Ngoại lệ localhost: khi chưa có tài khoản nào, kết nối từ chính máy này được tạo tài khoản đầu tiên
  const first = new MongoClient(`mongodb://${host}/`, clientOptions);
  await first.connect();
  await first.db('admin').command({ createUser: ROOT_USER, pwd: rootPassword, roles: [{ role: 'root', db: 'admin' }] });
  await first.close();

  const root = new MongoClient(rootUri, clientOptions);
  await root.connect();
  const db = root.db(DB_NAME);
  await db.command({ createRole: APP_ROLE, privileges: [{ resource: { db: DB_NAME, collection: '' }, actions: APP_ACTIONS }], roles: [] });
  await db.command({ createUser: APP_USER, pwd: appPassword, roles: [{ role: APP_ROLE, db: DB_NAME }] });
  await root.close();

  setEnvValue('MONGODB_URI', `mongodb://${APP_USER}:${appPassword}@${host}/${DB_NAME}`, `MongoDB trên máy này (${MONGO_DIR}). Mật khẩu sinh ngẫu nhiên, không chia sẻ tệp này.`);
  // Đã có DB thật: quên bật MongoDB thì server phải báo lỗi, không âm thầm lùi về DB in-memory
  if (envValue('MONGODB_MEMORY_FALLBACK')) setEnvValue('MONGODB_MEMORY_FALLBACK', 'false');
}

async function prepareMongodb() {
  const uri = envValue('MONGODB_URI');
  // Chuỗi mặc định của .env.example không có tài khoản: coi như chưa cấu hình
  const configured = Boolean(uri) && !/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/greencanteen$/.test(uri);
  const installed = fs.existsSync(MONGO_CONFIG);

  if (process.platform !== 'win32') {
    if (!configured) todo.push('Cài MongoDB (apt, brew) hoặc dùng Atlas rồi đặt MONGODB_URI trong server/.env');
    return 'chỉ tự cài trên Windows';
  }
  if (configured && !installed) return 'MONGODB_URI đã trỏ tới DB có sẵn';
  if (!installed) {
    if (await portOpen(MONGO_PORT)) {
      todo.push(`Cổng ${MONGO_PORT} đã có MongoDB khác: đặt MONGODB_URI trong server/.env, hoặc chạy lại với --mongo-port`);
      return 'không cài vì cổng đã bận';
    }
    await installMongodb();
  }
  const state = await startMongod();
  if (!configured) await createAccounts();
  todo.push(`Sau mỗi lần khởi động lại máy, bật MongoDB bằng ${path.join(MONGO_DIR, 'start-mongodb.cmd')}`);
  return `${MONGODB.version} tại ${MONGO_DIR}, ${state}${configured ? '' : ', đã tạo tài khoản'}`;
}

function prepareAdminKey() {
  if (envValue('ADMIN_MFA_KEY')) return 'đã có, giữ nguyên';
  const comment = 'Khóa khu quản trị và xác thực hai lớp. Đổi hoặc mất khóa thì mọi MFA hiện có mất tác dụng: giữ một bản sao an toàn, tách khỏi bản sao lưu DB.';
  setEnvValue('ADMIN_MFA_KEY', crypto.randomBytes(32).toString('base64'), comment);
  todo.push('Chép ADMIN_MFA_KEY trong server/.env vào trình quản lý mật khẩu: mất hoặc đổi khóa thì mọi MFA mất tác dụng');
  return 'đã tạo';
}

async function prepareOllama() {
  const model = envValue('VISION_OLLAMA_MODEL') || OLLAMA_MODEL;
  if (spawnSync('ollama --version', { shell: true, stdio: 'ignore' }).status !== 0) {
    todo.push(`Cài Ollama (https://ollama.com/download) rồi chạy lại để tải ${model}. Chưa có thì check-in bằng ảnh báo chưa sẵn sàng`);
    return 'chưa cài Ollama';
  }
  const [name, tag = 'latest'] = model.split(':');
  const modelsDir = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const downloaded = fs.existsSync(path.join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', name, tag));
  const running = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(3000) }).then((res) => res.ok, () => false);

  if (!running) {
    todo.push(downloaded ? 'Mở ứng dụng Ollama trước khi check-in bằng ảnh' : `Mở ứng dụng Ollama rồi chạy lại để tải ${model} (~3,3 GB)`);
    return downloaded ? `${model} đã có, Ollama chưa chạy` : 'Ollama chưa chạy';
  }
  if (downloaded) return `${model} đã có`;
  if (!run(`ollama pull ${model}`, ROOT)) throw new Error(`Tải ${model} lỗi`);
  return `đã tải ${model}`;
}

const STEPS = [
  ['Thư viện server', () => installDependencies(SERVER)],
  ['Thư viện client', () => installDependencies(CLIENT)],
  ['Cấu hình server/.env', prepareEnvFile],
  ['Mô hình CLIP', prepareClipModel],
  ['MongoDB', options['skip-mongodb'] ? () => 'bỏ qua theo --skip-mongodb' : prepareMongodb],
  ['Khóa khu quản trị', prepareAdminKey],
  ['Ollama', options['skip-ollama'] ? () => 'bỏ qua theo --skip-ollama' : prepareOllama],
];

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    console.error(`Cần Node.js 20 trở lên, máy đang có ${process.version}.`);
    return 1;
  }
  const results = [];
  let failed = false;
  for (const [title, action] of STEPS) {
    console.log(`\n=== ${title} ===`);
    try {
      results.push(`[ok]   ${title}: ${await action()}`);
    } catch (err) {
      // Các bước sau phụ thuộc bước trước nên dừng ở lỗi đầu tiên
      results.push(`[LỖI]  ${title}: ${err.message}`);
      failed = true;
      break;
    }
  }
  console.log('\n=== Kết quả ===');
  for (const line of results) console.log(line);
  if (todo.length) {
    console.log('\nBạn còn cần làm:');
    for (const item of todo) console.log(`- ${item}`);
  }
  if (!failed) console.log('\nTạo admin đầu tiên: README mục 7.3. Chạy hệ thống: npm run dev:server và npm run dev:client, mỗi lệnh một cửa sổ.');
  return failed ? 1 : 0;
}

process.exitCode = await main();
