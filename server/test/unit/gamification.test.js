// Huy hiệu / điểm: giá trị biên trước – đúng – sau từng ngưỡng và bảng quyết định hai tiêu chí
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGE_LABELS,
  CO2_GRAMS_PER_CUP,
  PLASTIC_GRAMS_PER_CUP,
  POINTS_PER_CHECKIN,
  TREES_SYMBOLIC_DIVISOR,
  computeBadges,
} from '../../src/services/gamification.js';
import { BADGE_META } from '../../../client/src/data/badges.js';

describe('computeBadges — ngưỡng theo số lượt check-in (điểm = 0)', () => {
  const cases = [
    [0, []],
    [1, ['first_sip']],
    [4, ['first_sip']],
    [5, ['first_sip', 'green_starter']],
    [19, ['first_sip', 'green_starter']],
    [20, ['first_sip', 'green_starter', 'eco_warrior']],
    [49, ['first_sip', 'green_starter', 'eco_warrior']],
    [50, ['first_sip', 'green_starter', 'eco_warrior', 'planet_guardian']],
    [51, ['first_sip', 'green_starter', 'eco_warrior', 'planet_guardian']],
  ];
  for (const [checkIns, expected] of cases) {
    test(`${checkIns} lượt → [${expected.join(', ')}]`, () => assert.deepEqual(computeBadges(checkIns, 0), expected));
  }
});

describe('computeBadges — ngưỡng 100 điểm', () => {
  test('99 điểm chưa đạt, 100 và 101 điểm đạt', () => {
    assert.ok(!computeBadges(0, 99).includes('century_points'));
    assert.ok(computeBadges(0, 100).includes('century_points'));
    assert.ok(computeBadges(0, 101).includes('century_points'));
  });

  test('bảng quyết định: lượt và điểm độc lập nhau', () => {
    assert.deepEqual(computeBadges(10, 100), ['first_sip', 'green_starter', 'century_points']);
    assert.deepEqual(computeBadges(10, 99), ['first_sip', 'green_starter']);
    assert.deepEqual(computeBadges(0, 100), ['century_points'], 'dữ liệu cũ có điểm nhưng không có lượt');
  });

  test('đầu vào không hợp lệ (âm, NaN, thiếu) không sinh huy hiệu', () => {
    for (const [n, p] of [[-1, -10], [NaN, NaN], [undefined, undefined], [null, null]]) {
      assert.deepEqual(computeBadges(n, p), [], `${n}, ${p}`);
    }
  });
});

describe('hằng số gamification và nhãn hiển thị', () => {
  test('mỗi check-in hợp lệ: +10 điểm, 12g nhựa, 8g CO₂; 50 lượt = 1 sinh vật tượng trưng', () => {
    assert.equal(POINTS_PER_CHECKIN, 10);
    assert.equal(PLASTIC_GRAMS_PER_CUP, 12);
    assert.equal(CO2_GRAMS_PER_CUP, 8);
    assert.equal(TREES_SYMBOLIC_DIVISOR, 50);
  });

  test('mọi huy hiệu server cấp đều có nhãn ở server và ở giao diện', () => {
    const all = computeBadges(1000, 10_000);
    assert.equal(all.length, 5);
    for (const id of all) {
      assert.ok(BADGE_LABELS[id], `server thiếu nhãn ${id}`);
      assert.ok(BADGE_META[id]?.label, `client thiếu nhãn ${id}`);
      assert.equal(BADGE_META[id].label, BADGE_LABELS[id], `nhãn ${id} khác nhau giữa server và client`);
    }
  });
});
