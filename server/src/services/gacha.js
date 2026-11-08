import crypto from 'crypto';

/**
 * Quay thưởng tri ân (mã nguồn vẫn gọi là "gacha": tên API, collection, trường dữ liệu giữ nguyên để không làm hỏng dữ liệu
 * và bản PWA cũ còn trong cache). Giải đang phát: móc khóa. Giải "phone_topup" chỉ còn trong dữ liệu cũ (mã nạp demo).
 */
export const GACHA_PRIZE_TYPE = 'keychain';
export const LEGACY_TOPUP_TYPE = 'phone_topup';

/**
 * Xác suất lưu bằng số nguyên phần triệu (ppm). Một lượt rút một số trong 1.000.000 khả năng: tổng xác suất các giải đang bật
 * tối đa bằng giá trị này, phần còn lại là "không trúng". Xác suất nhỏ nhất khác 0 là 1 trên 1.000.000.
 */
export const PROBABILITY_TOTAL_PPM = 1_000_000;

/**
 * Rút một lượt bằng bộ sinh số ngẫu nhiên mật mã: số rơi vào khoảng của giải nào thì trúng giải đó, ngoài mọi khoảng là không
 * trúng (null). Mỗi lượt độc lập: không phụ thuộc người quay, số lần đã quay hay kết quả trước.
 */
export function drawPrize(prizes, random = crypto.randomInt) {
  let cursor = random(PROBABILITY_TOTAL_PPM);
  for (const prize of prizes) {
    if (cursor < prize.probabilityPpm) return prize;
    cursor -= prize.probabilityPpm;
  }
  return null;
}

// Bỏ các ký tự dễ nhầm khi đọc cho nhau nghe: 0/O, 1/I/L
const CLAIM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Mã nhận quà ngẫu nhiên (khoảng 2^49 khả năng), chỉ dùng để tra cứu khi trao; người trao vẫn phải đối chiếu tài khoản */
export function issueClaimCode() {
  const chars = Array.from({ length: 10 }, () => CLAIM_ALPHABET[crypto.randomInt(CLAIM_ALPHABET.length)]);
  return `TA-${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** Chuẩn hóa mã nhận quà người dùng gõ: bỏ khoảng trắng, chữ thường → chữ hoa */
export function normalizeClaimCode(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, '').toUpperCase().slice(0, 20) : '';
}

/** Bộ đếm số móc khóa đã trúng theo mã giải, dùng chung mọi phiên bản: số lượng là số móc khóa thật, không cấp lại khi đổi phiên bản */
export const keychainStockKey = (prizeId) => `keychain:${prizeId}`;

/** "1 trên N lượt" (làm tròn) cho xác suất ppm; 0 → null */
export function oneInN(ppm) {
  return ppm > 0 ? Math.round(PROBABILITY_TOTAL_PPM / ppm) : null;
}
