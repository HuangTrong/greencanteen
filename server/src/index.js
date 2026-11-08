import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { cleanupUploads } from './routes/checkin.js';
import { syncStories } from './services/stories.js';
import { runMigrations } from './services/migrations.js';
import { getActiveGachaConfig } from './services/gachaConfig.js';
import { logAdminStatus } from './services/adminBootstrap.js';
import { recoverOutboxes } from './services/rewards.js';
import { flushAuditOutbox } from './services/audit.js';
import { logAuthProviderStatus } from './services/oauth.js';
import { logVisionStatus, warmUpVision } from './services/vision.js';
import { verifyEmailTransport } from './services/email.js';
import { createHttpServer } from './services/httpServer.js';
import { logMalwareScanStatus } from './services/malwareScan.js';
import { logProxyStatus } from './services/rateLimit.js';
import { logSecurityConfig } from './services/securityConfig.js';
import { env, envFlag, isProduction, listenHost } from './services/config.js';

dotenv.config();

const PORT = process.env.PORT || 3001;
const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 7000;

let memoryServer = null;
let shuttingDown = false;

async function connectDatabase() {
  const preferred = env('MONGODB_URI') || 'mongodb://127.0.0.1:27017/greencanteen';
  try {
    await mongoose.connect(preferred, { serverSelectionTimeoutMS: 4000 });
    console.log('MongoDB connected:', preferred.replace(/\/\/[^@/]*@/, '//***@'));
    return;
  } catch (err) {
    console.warn('MongoDB unavailable:', err.message);
  }
  // DB in-memory mất toàn bộ dữ liệu khi tắt server → chỉ dùng để demo, không bao giờ trong production
  // hay khi đã khai báo MONGODB_URI mà không bật MONGODB_MEMORY_FALLBACK
  const allowMemory = !isProduction() && (!env('MONGODB_URI') || envFlag('MONGODB_MEMORY_FALLBACK'));
  if (!allowMemory) {
    throw new Error('Không kết nối được MongoDB (MONGODB_URI) — dừng khởi động để không ghi dữ liệu vào DB tạm.');
  }
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('greencanteen'));
  console.warn('Using in-memory MongoDB (demo) — MỌI tài khoản và check-in sẽ mất khi server khởi động lại.');
}

/**
 * Dừng êm khi bị yêu cầu tắt (SIGTERM/SIGINT, hoặc lệnh 'shutdown' từ scripts/dev.js khi khởi động lại):
 * thôi nhận kết nối mới, trả xong request đang xử lý rồi mới đóng DB — request không bị ngắt giữa chừng.
 */
function enableGracefulShutdown(server) {
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${reason} — dừng nhận request mới, đợi các request đang xử lý hoàn tất...`);
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
    server.close(async () => {
      await mongoose.disconnect().catch(() => {});
      await memoryServer?.stop().catch(() => {});
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('message', (message) => {
    if (message?.type === 'shutdown') shutdown('Khởi động lại');
  });
}

async function runMaintenance() {
  try {
    await recoverOutboxes();
    await flushAuditOutbox();
    await cleanupUploads(15 * 60 * 1000);
  } catch (err) {
    console.error('Maintenance failed:', err.message);
  }
}

async function start() {
  await connectDatabase();
  mongoose.connection.on('disconnected', () => {
    if (!shuttingDown) console.error('MongoDB disconnected — API trả lỗi cho tới khi kết nối lại.');
  });
  mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected.'));

  // Trước khi nhận request: dọn tệp tạm sót lại, chạy migration, đồng bộ câu chuyện có nguồn (giữ nguyên nội dung admin
  // quản lý), hoàn tất thưởng bị gián đoạn
  const removedUploads = await cleanupUploads(0);
  if (removedUploads) console.log(`Removed ${removedUploads} leftover upload file(s).`);
  const migrations = await runMigrations();
  if (migrations.length) console.log(`Migrations applied: ${migrations.join(', ')}.`);
  const stories = await syncStories();
  console.log(
    `Stories synced: ${stories.upserted} sourced stories${stories.keptAdminManaged ? `, kept ${stories.keptAdminManaged} admin-managed` : ''}${stories.removedUnsourced ? `, removed ${stories.removedUnsourced} unsourced` : ''}.`
  );
  if (!(await getActiveGachaConfig())) {
    console.log('Quay thưởng tri ân đang tạm dừng: chưa có phiên bản móc khóa nào đang hiệu lực (khu quản trị → Quay thưởng tri ân).');
  }
  const recovered = await recoverOutboxes();
  if (recovered) console.log(`Recovered pending rewards for ${recovered} user outbox(es).`);
  // Dấu vết kiểm toán sót lại (server dừng giữa thao tác của quản trị viên). Chỉ chuyển dấu vết cũ hơn 1 phút: tiến trình khác chạy
  // cùng DB có thể đang làm dở thao tác; phần còn lại được chuyển ở lần bảo trì định kỳ
  const audits = await flushAuditOutbox();
  if (audits) console.log(`Recovered ${audits} pending audit log entr${audits === 1 ? 'y' : 'ies'}.`);

  const host = listenHost();
  const server = createHttpServer(createApp()).listen(PORT, host, () => {
    console.log(`GreenCanteen API http://${host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host}:${PORT}`);
    logSecurityConfig();
    logProxyStatus();
    logVisionStatus();
    warmUpVision();
    logAuthProviderStatus();
    logAdminStatus().catch((err) => console.error('Không kiểm tra được trạng thái khu quản trị:', err.message));
    verifyEmailTransport();
    logMalwareScanStatus();
  });
  server.on('error', (err) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Cổng ${PORT} đang được tiến trình khác dùng (có thể là một server GreenCanteen khác). Tắt tiến trình đó hoặc đổi PORT.`
        : `Không mở được cổng ${PORT} trên ${host}: ${err.message}`
    );
    process.exit(1);
  });
  enableGracefulShutdown(server);

  setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS).unref();
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
