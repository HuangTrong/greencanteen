// Tiến trình đích cho kiểm thử tấn công upload: API thật trên 127.0.0.1, MongoDB in-memory, nhận diện mô phỏng, không đọc .env, không có dịch vụ ngoài.
// Chạy tách khỏi tiến trình test để server sập hoặc event loop bị chặn thì test đọc được kết quả thay vì chết theo.
// In một dòng JSON gồm địa chỉ và cookie phiên của tài khoản giả, rồi chạy tới khi bị dừng.
import { RateLimit } from '../../src/models/RateLimit.js';
import { syncStories } from '../../src/services/stories.js';
import { createClient, registerUser, setEnv, startTestServer } from '../helpers.js';

process.on('uncaughtException', (err) => {
  console.log(`UNCAUGHT ${err.name}: ${err.message}`);
  process.exit(99);
});
process.on('unhandledRejection', (err) => {
  console.log(`UNHANDLED ${err?.name}: ${err?.message}`);
  process.exit(98);
});

setEnv({ VISION_SIMULATION: 'true' });
const ctx = await startTestServer();
await syncStories();
const client = createClient(ctx.base);
const res = await registerUser(client);
if (res.status !== 201) throw new Error(`không tạo được tài khoản: ${res.status}`);
setEnv({ VISION_SIMULATION: 'true' });

// Giới hạn 20 lần/giờ của tài khoản không phải đối tượng của các phép thử này
setInterval(() => RateLimit.deleteMany({}).catch(() => {}), 100).unref();
console.log(JSON.stringify({ base: ctx.base, cookie: [...client.jar].map(([k, v]) => `${k}=${v}`).join('; ') }));
