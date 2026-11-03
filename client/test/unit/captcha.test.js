// CAPTCHA proof-of-work phía trình duyệt: phải ra đúng kết quả máy chủ tính bằng node:crypto, và tự giải đúng một lần khi máy chủ đòi
import { pbkdf2Sync, webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { json, mockApi } from '../helpers';
import { solveCaptcha, withCaptcha } from '../../src/lib/captcha';

const FUTURE = '2999-01-01T00:00:00.000Z';
const CAPTCHA = { challenge: 'thu-thach-gia-lap', iterations: 50, bits: 6, expiresAt: FUTURE };

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

function leadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte !== 0) return bits + Math.clz32(byte) - 24;
    bits += 8;
  }
  return bits;
}

describe('solveCaptcha', () => {
  test('lời giải đạt độ khó theo đúng công thức của máy chủ', async () => {
    const { challenge, nonce } = await solveCaptcha(CAPTCHA);
    expect(challenge).toBe(CAPTCHA.challenge);
    expect(nonce).toMatch(/^\d{1,10}$/);
    const derived = pbkdf2Sync(nonce, CAPTCHA.challenge, CAPTCHA.iterations, 32, 'sha256');
    expect(leadingZeroBits(derived)).toBeGreaterThanOrEqual(CAPTCHA.bits);
  });

  test('không nhận lời giải đầu tiên nếu chưa đủ số bit', async () => {
    const { nonce } = await solveCaptcha(CAPTCHA);
    for (let earlier = 0; earlier < Number(nonce); earlier += 1) {
      expect(leadingZeroBits(pbkdf2Sync(String(earlier), CAPTCHA.challenge, CAPTCHA.iterations, 32, 'sha256'))).toBeLessThan(CAPTCHA.bits);
    }
  });

  test('thử thách đã hết hạn thì dừng, không chạy vô hạn', async () => {
    await expect(solveCaptcha({ ...CAPTCHA, bits: 24, expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow('chưa hoàn tất kịp');
  });

  test('trang không chạy trên HTTPS nên trình duyệt không có Web Crypto: báo rõ lý do', async () => {
    vi.stubGlobal('crypto', {});
    await expect(solveCaptcha(CAPTCHA)).rejects.toThrow('HTTPS');
  });
});

describe('withCaptcha', () => {
  const required = Object.assign(new Error('Cần xác minh'), { code: 'captcha_required' });

  test('máy chủ không đòi: gửi đúng một lần, không xin thử thách', async () => {
    const api = mockApi({});
    const send = vi.fn().mockResolvedValue('ok');
    await expect(withCaptcha(send)).resolves.toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith();
    expect(api.calls).toHaveLength(0);
  });

  test('máy chủ đòi: xin thử thách, giải, gửi lại kèm lời giải', async () => {
    mockApi({ 'POST /api/auth/captcha': json({ ...CAPTCHA, bits: 0 }) });
    const send = vi.fn().mockRejectedValueOnce(required).mockResolvedValueOnce('ok');
    await expect(withCaptcha(send)).resolves.toBe('ok');
    expect(send).toHaveBeenLastCalledWith({ challenge: CAPTCHA.challenge, nonce: '0' });
  });

  test('lỗi khác không kích hoạt CAPTCHA', async () => {
    const api = mockApi({});
    const failure = Object.assign(new Error('Sai mật khẩu'), { code: 'invalid_credentials' });
    await expect(withCaptcha(vi.fn().mockRejectedValue(failure))).rejects.toBe(failure);
    expect(api.calls).toHaveLength(0);
  });

  test('gửi lại vẫn bị đòi: không lặp vô hạn', async () => {
    mockApi({ 'POST /api/auth/captcha': json({ ...CAPTCHA, bits: 0 }) });
    const send = vi.fn().mockRejectedValue(required);
    await expect(withCaptcha(send)).rejects.toBe(required);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
