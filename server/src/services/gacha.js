import crypto from 'crypto';

/** Gacha chỉ có một loại giải: mã nạp điện thoại */
export const GACHA_PRIZE_TYPE = 'phone_topup';

/** Xác suất lưu bằng số nguyên phần triệu: tổng các giải đang bật phải đúng bằng giá trị này */
export const PROBABILITY_TOTAL_PPM = 1_000_000;

const AMOUNTS_VND = [10_000, 20_000, 50_000];
const CARRIERS = [
  ['viettel', 'Viettel'],
  ['vinaphone', 'Vinaphone'],
  ['mobifone', 'Mobifone'],
  ['da-mang', 'Đa mạng'],
];

function buildDefaultPrizes() {
  const combos = AMOUNTS_VND.flatMap((amountVnd) => CARRIERS.map(([slug, carrier]) => ({ amountVnd, slug, carrier })));
  const share = Math.floor(PROBABILITY_TOTAL_PPM / combos.length);
  const remainder = PROBABILITY_TOTAL_PPM - share * combos.length;
  return combos.map(({ amountVnd, slug, carrier }, index) => ({
    prizeId: `topup-${amountVnd / 1000}k-${slug}`,
    label: 'Mã nạp điện thoại',
    prizeType: GACHA_PRIZE_TYPE,
    carrier,
    amountVnd,
    probabilityPpm: share + (index < remainder ? 1 : 0),
    enabled: true,
    maxQuantity: null,
  }));
}

/** Bộ giải trước khi có cấu hình trong DB: mọi tổ hợp mệnh giá × nhà mạng đồng xác suất (lệch tối đa 1 phần triệu vì làm tròn) */
export const DEFAULT_PRIZES = buildDefaultPrizes();

/** Chọn một giải theo xác suất bằng bộ sinh số ngẫu nhiên mật mã; tổng xác suất của danh sách được chuẩn hóa khi rút lại giải còn kho */
export function pickPrize(prizes) {
  const total = prizes.reduce((sum, prize) => sum + prize.probabilityPpm, 0);
  let cursor = crypto.randomInt(total);
  for (const prize of prizes) {
    cursor -= prize.probabilityPpm;
    if (cursor < 0) return prize;
  }
  throw new Error('Không chọn được giải');
}

export function issueTopUpCode(amountVnd) {
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `GC-${amountVnd / 1000}K-${suffix}`;
}

export function rollPhoneTopUpPrize(prizes = DEFAULT_PRIZES) {
  const { prizeType, carrier, amountVnd } = pickPrize(prizes);
  return { prizeType, carrier, amountVnd, topUpCode: issueTopUpCode(amountVnd) };
}
