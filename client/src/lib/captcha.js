import { api } from './api';

const encoder = new TextEncoder();

function leadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte !== 0) return bits + Math.clz32(byte) - 24;
    bits += 8;
  }
  return bits;
}

/** Cùng công thức với server/src/services/captcha.js. Web Crypto chạy ngoài luồng giao diện nên trang không bị đứng trong lúc giải */
export async function solveCaptcha({ challenge, iterations, bits, expiresAt }) {
  const { subtle } = globalThis.crypto;
  if (!subtle) throw new Error('Trang cần chạy trên HTTPS để thực hiện bước kiểm tra chống tự động.');
  const salt = encoder.encode(challenge);
  const deadline = new Date(expiresAt).getTime();
  for (let nonce = 0; Date.now() < deadline; nonce += 1) {
    const key = await subtle.importKey('raw', encoder.encode(String(nonce)), 'PBKDF2', false, ['deriveBits']);
    const derived = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
    if (leadingZeroBits(new Uint8Array(derived)) >= bits) return { challenge, nonce: String(nonce) };
  }
  throw new Error('Thiết bị chưa hoàn tất kịp bước kiểm tra chống tự động. Vui lòng thử lại.');
}

/** Gửi yêu cầu; máy chủ đòi CAPTCHA thì trình duyệt tự giải rồi gửi lại đúng một lần, người dùng không phải làm gì */
export async function withCaptcha(send) {
  try {
    return await send();
  } catch (err) {
    if (err.code !== 'captcha_required') throw err;
  }
  return send(await solveCaptcha(await api.captcha()));
}
