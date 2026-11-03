// Định dạng và chuyển đổi của khu quản trị: giá trị biên, không dính sai số số thực, múi giờ
import { describe, expect, test } from 'vitest';
import { niceMax } from '../../src/admin/components/BarChart';
import { toQuery } from '../../src/admin/adminApi';
import { formatDateTime, formatNumber, formatPeriod, formatVnd, isoToLocalInput, localInputToIso, percentToPpm, ppmToPercent, slugify, vietnamDate } from '../../src/admin/format';

describe('xác suất', () => {
  test('phần trăm → phần triệu không qua số thực', () => {
    expect(percentToPpm('8.3334')).toBe(83_334);
    expect(percentToPpm('8,3334')).toBe(83_334);
    expect(percentToPpm('100')).toBe(1_000_000);
    expect(percentToPpm('0.0001')).toBe(1);
    expect(percentToPpm('0')).toBe(0);
    expect(percentToPpm(' 33.3 ')).toBe(333_000);
    // 0.07 * 10000 trong số thực ra 700.0000000000001; phép tính trên chuỗi thì đúng
    expect(percentToPpm('0.07')).toBe(700);
    expect(percentToPpm('1.1')).toBe(11_000);
  });

  test('sai định dạng → null, không đoán', () => {
    for (const text of ['', 'abc', '1.23456', '-1', '1e3', '1000', '.5', '1.']) expect(percentToPpm(text)).toBeNull();
  });

  test('phần triệu → phần trăm giữ đủ chữ số, bỏ số 0 thừa; đi và về không đổi', () => {
    expect(ppmToPercent(83_334)).toBe('8.3334');
    expect(ppmToPercent(1_000_000)).toBe('100');
    expect(ppmToPercent(500_000)).toBe('50');
    expect(ppmToPercent(1)).toBe('0.0001');
    expect(ppmToPercent(0)).toBe('0');
    for (const ppm of [1, 7, 99, 700, 83_333, 83_334, 999_999, 1_000_000]) expect(percentToPpm(ppmToPercent(ppm))).toBe(ppm);
  });
});

describe('thời gian theo giờ Việt Nam', () => {
  test('ô nhập ↔ ISO không phụ thuộc múi giờ máy', () => {
    expect(localInputToIso('2026-11-01T08:30')).toBe('2026-11-01T01:30:00.000Z');
    expect(isoToLocalInput('2026-11-01T01:30:00.000Z')).toBe('2026-11-01T08:30');
    expect(isoToLocalInput('2026-10-31T17:00:00.000Z')).toBe('2026-11-01T00:00');
    expect(localInputToIso('')).toBeNull();
    expect(isoToLocalInput(null)).toBe('');
  });

  test('ngày theo lịch Việt Nam, kể cả khi UTC còn ở hôm trước', () => {
    const now = Date.parse('2026-10-31T17:30:00Z');
    expect(vietnamDate(0, now)).toBe('2026-11-01');
    expect(vietnamDate(-1, now)).toBe('2026-10-31');
  });

  test('hiển thị', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('khong-phai-ngay')).toBe('—');
    expect(formatDateTime('2026-10-31T17:30:00Z')).toContain('00:30');
    expect(formatPeriod('2026-10-05')).toBe('05/10');
    expect(formatPeriod('2026-10')).toBe('10/2026');
  });
});

describe('số và tiền', () => {
  test('định dạng tiếng Việt; null là "—", 0 vẫn là 0', () => {
    expect(formatNumber(1234567)).toBe('1.234.567');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatVnd(450_000)).toBe('450.000 ₫');
    expect(formatVnd(null)).toBe('—');
  });
});

describe('slug', () => {
  test('bỏ dấu tiếng Việt, đ, ký tự đặc biệt', () => {
    expect(slugify('Đại dương & Rùa biển')).toBe('dai-duong-rua-bien');
    expect(slugify('  --Chim cánh cụt!!  ')).toBe('chim-canh-cut');
    expect(slugify('')).toBe('');
    expect(slugify('ă'.repeat(100))).toHaveLength(80);
    expect(slugify(`${'a'.repeat(79)} b`)).toBe('a'.repeat(79));
  });
});

describe('trục biểu đồ', () => {
  test('làm tròn lên số dễ đọc', () => {
    for (const [value, expected] of [[0, 1], [1, 1], [3, 5], [7, 10], [27, 50], [100, 100], [101, 200], [450_000, 500_000]]) {
      expect(niceMax(value)).toBe(expected);
    }
  });
});

describe('tham số truy vấn', () => {
  test('bỏ giá trị rỗng, mã hóa ký tự đặc biệt', () => {
    expect(toQuery({ q: '', status: null, role: undefined })).toBe('');
    expect(toQuery({ q: 'a b&c', page: 2 })).toBe('?q=a+b%26c&page=2');
  });
});
