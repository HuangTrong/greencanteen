import crypto from 'crypto';

// TOTP theo RFC 6238 (HMAC-SHA1, 30 giây, 6 chữ số) — tương thích Google Authenticator, Microsoft Authenticator, Aegis...
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(text).toUpperCase().replace(/=+$/, '')) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Secret base32 không hợp lệ');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / PERIOD_SECONDS);

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Trả về bước thời gian khớp mã (cho phép lệch một bước vì đồng hồ thiết bị), không khớp → null */
export function matchTotpStep(secret, code, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, step)), given)) return step;
  }
  return null;
}

export function totpUri({ secret, account, issuer = 'GreenCanteen Admin' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/** Mã hóa secret khi lưu. `context` (id tài khoản) gắn bản mã với chủ của nó: chép sang tài khoản khác sẽ không giải mã được */
export function sealSecret(plaintext, key, context) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(context)));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function openSecret(sealed, key, context) {
  const [version, iv, tag, ciphertext] = String(sealed).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Bản mã không đúng định dạng');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
