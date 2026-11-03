import crypto from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(crypto.scrypt);

// Tham số scrypt theo khuyến nghị OWASP (N=2^15, r=8, p=3) — lưu kèm trong chuỗi băm để nâng cấp sau này
const PARAMS = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LENGTH = 64;
const MAXMEM = 64 * 1024 * 1024;

// Chuẩn hóa Unicode: chữ có dấu tiếng Việt có thể đến ở dạng dựng sẵn hoặc tổ hợp tùy bộ gõ
const normalize = (password) => String(password).normalize('NFC');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(normalize(password), salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, saltB64, keyB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(normalize(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return crypto.timingSafeEqual(key, expected);
}

let dummyHash;

/** Khi email không tồn tại vẫn băm một lần để thời gian phản hồi không lộ email nào đã đăng ký */
export async function verifyPasswordOrDummy(password, stored) {
  if (stored) return verifyPassword(password, stored);
  dummyHash ||= hashPassword('greencanteen-dummy-password');
  await verifyPassword(password, await dummyHash);
  return false;
}
