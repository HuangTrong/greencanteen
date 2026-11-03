// Cấu hình môi trường, kiểm tra ảnh theo nội dung tệp và giải thưởng Gacha
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clientOrigin, env, envFlag, envNumber, isProduction } from '../../src/services/config.js';
import { ACCEPTED_IMAGE_TYPES, detectImageType, inspectImage, sha256 } from '../../src/services/image.js';
import { GACHA_PRIZE_TYPE, rollPhoneTopUpPrize } from '../../src/services/gacha.js';
import { setEnv, uniquePng } from '../helpers.js';

afterEach(() => {
  delete process.env.GC_TEST_VALUE;
  setEnv();
});

describe('đọc biến môi trường', () => {
  test('env cắt khoảng trắng, thiếu → chuỗi rỗng', () => {
    process.env.GC_TEST_VALUE = '  abc  ';
    assert.equal(env('GC_TEST_VALUE'), 'abc');
    assert.equal(env('GC_KHONG_TON_TAI'), '');
  });

  test('envFlag: phân vùng giá trị bật / tắt', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on', 'On']) {
      process.env.GC_TEST_VALUE = value;
      assert.equal(envFlag('GC_TEST_VALUE'), true, value);
    }
    for (const value of ['0', 'false', '', 'no', 'off', 'enabled', 'y']) {
      process.env.GC_TEST_VALUE = value;
      assert.equal(envFlag('GC_TEST_VALUE'), false, value);
    }
  });

  test('envNumber: thiếu / sai định dạng → mặc định; kẹp biên', () => {
    const read = (value) => {
      if (value === undefined) delete process.env.GC_TEST_VALUE;
      else process.env.GC_TEST_VALUE = value;
      return envNumber('GC_TEST_VALUE', 8, { min: 1, max: 20 });
    };
    assert.equal(read(undefined), 8);
    assert.equal(read('abc'), 8);
    assert.equal(read('Infinity'), 8);
    assert.equal(read(' 7 '), 7);
    assert.equal(read('0'), 1);
    assert.equal(read('1'), 1);
    assert.equal(read('20'), 20);
    assert.equal(read('21'), 20);
    assert.equal(read('1e1'), 10);
  });

  test('isProduction chỉ khi NODE_ENV đúng "production"; CLIENT_ORIGIN có mặc định', () => {
    setEnv({ NODE_ENV: 'production' });
    assert.equal(isProduction(), true);
    setEnv({ NODE_ENV: 'Production' });
    assert.equal(isProduction(), false, 'phân biệt hoa/thường như Express');
    setEnv();
    assert.equal(clientOrigin(), 'http://localhost:5173');
    setEnv({ CLIENT_ORIGIN: 'https://gc.example.edu.vn' });
    assert.equal(clientOrigin(), 'https://gc.example.edu.vn');
  });
});

describe('nhận diện loại ảnh theo nội dung (magic bytes)', () => {
  const ftyp = (brand, size = 40) => Buffer.concat([Buffer.from(`\x00\x00\x00\x18ftyp${brand}`, 'latin1'), Buffer.alloc(size - 12)]);
  const webp = (declaredSize, actualLength) => {
    const buf = Buffer.alloc(actualLength);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(declaredSize, 4);
    buf.write('WEBPVP8 ', 8, 'latin1');
    return buf;
  };

  test('HEIF (mif1, msf1), HEIC; video MP4 (isom) không phải ảnh', () => {
    assert.equal(detectImageType(ftyp('mif1')), 'image/heif');
    assert.equal(detectImageType(ftyp('msf1')), 'image/heif');
    assert.equal(detectImageType(ftyp('heix')), 'image/heic');
    assert.equal(detectImageType(ftyp('isom')), null);
  });

  test('tệp ngắn hơn chữ ký → không nhận', () => {
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8])), null);
    assert.equal(detectImageType(uniquePng().subarray(0, 7)), null);
    assert.equal(detectImageType(Buffer.from('RIFF\x00\x00\x00\x00WEB', 'latin1')), null);
  });

  test('WebP: kích thước RIFF khai báo khớp tệp → hợp lệ; bị cắt → hỏng', () => {
    assert.equal(inspectImage(webp(32, 40)).ok, true);
    assert.equal(inspectImage(webp(33, 40)).ok, true, 'cho phép 1 byte đệm cuối khối RIFF');
    assert.equal(inspectImage(webp(100, 40)).code, 'image_unreadable');
  });

  test('HEIC/HEIF: nhận ra loại nhưng từ chối 415 vì bộ giải mã tại máy chủ không đọc được — có hướng dẫn', () => {
    assert.deepEqual(ACCEPTED_IMAGE_TYPES, ['image/jpeg', 'image/png', 'image/webp']);
    for (const brand of ['heic', 'heix', 'mif1']) {
      const result = inspectImage(ftyp(brand, 64));
      assert.equal(result.status, 415, brand);
      assert.equal(result.code, 'image_type_unsupported');
      assert.match(result.error, /HEIC\/HEIF/);
      assert.match(result.error, /Mở camera/);
    }
  });

  test('JPEG thiếu marker kết thúc, PNG thiếu IEND → hỏng; null/rỗng → ảnh rỗng', () => {
    assert.equal(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])).code, 'image_unreadable');
    const png = uniquePng();
    assert.equal(inspectImage(png.subarray(0, png.indexOf('IEND'))).code, 'image_unreadable');
    assert.equal(inspectImage(null).code, 'image_empty');
    assert.equal(inspectImage(Buffer.alloc(0)).status, 400);
  });

  test('SVG, GIF, PDF, script bị từ chối với 415 dù đặt tên .png', () => {
    for (const content of ['<svg onload="alert(1)"/>', 'GIF89a......', '%PDF-1.7', '#!/bin/sh\nrm -rf /']) {
      const result = inspectImage(Buffer.from(content));
      assert.equal(result.status, 415, content);
      assert.equal(result.code, 'image_type_unsupported');
    }
  });

  test('sha256 theo vector chuẩn', () => {
    assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Gacha — mã nạp điện thoại', () => {
  test('mệnh giá, nhà mạng trong tập cho phép; mã khớp mệnh giá; không trùng', () => {
    const prizes = Array.from({ length: 400 }, rollPhoneTopUpPrize);
    const amounts = new Set(prizes.map((p) => p.amountVnd));
    const carriers = new Set(prizes.map((p) => p.carrier));
    assert.deepEqual([...amounts].sort((a, b) => a - b), [10_000, 20_000, 50_000]);
    assert.deepEqual([...carriers].sort(), ['Mobifone', 'Viettel', 'Vinaphone', 'Đa mạng'].sort());
    for (const p of prizes) {
      assert.equal(p.prizeType, GACHA_PRIZE_TYPE);
      assert.match(p.topUpCode, /^GC-(10|20|50)K-[0-9A-F]{8}$/);
      assert.equal(p.topUpCode.split('-')[1], `${p.amountVnd / 1000}K`);
    }
    assert.equal(new Set(prizes.map((p) => p.topUpCode)).size, prizes.length);
  });
});
