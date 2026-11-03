// F-08: chính sách mật khẩu cục bộ — danh sách có phiên bản, biến thể hoa/thường, khoảng trắng, Unicode, dãy và lặp
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePassword } from '../../src/services/accounts.js';
import { COMMON_PASSWORD_MESSAGE, commonPasswordListInfo, isCommonPassword } from '../../src/services/passwordPolicy.js';

const LENGTH_MESSAGES = /ít nhất 8|tối đa 128/;

describe('danh sách mật khẩu cục bộ', () => {
  test('có phiên bản và nguồn ghi trong tệp; đủ các mật khẩu bài toán yêu cầu', () => {
    const info = commonPasswordListInfo();
    assert.match(info.version, /^\d{4}\.\d{2}\.\d+$/);
    assert.match(info.source, /biên soạn thủ công/);
    assert.ok(info.entries >= 500, `${info.entries} mục`);
    for (const password of ['12345678', 'password', '11111111', 'qwertyui']) assert.equal(isCommonPassword(password), true, password);
  });

  test('mọi mục đã ở dạng chuẩn hóa để so khớp được', () => {
    for (const entry of commonPasswordListInfo().items) assert.equal(isCommonPassword(entry), true, entry);
  });
});

describe('so khớp theo dạng chuẩn hóa', () => {
  for (const [label, password] of [
    ['viết hoa toàn bộ', 'PASSWORD'],
    ['viết hoa chữ đầu', 'Password'],
    ['hoa thường lẫn lộn', 'pAsSwOrD'],
    ['khoảng trắng hai đầu', '  password  '],
    ['tab và xuống dòng', '\tpassword\n'],
    ['khoảng trắng giữa các chữ', 'pass word'],
    ['dấu nối giữa các chữ', 'pass-word'],
    ['full-width Unicode', 'ｐａｓｓｗｏｒｄ'],
    ['leet', 'P@ssw0rd'],
    ['leet ký tự đô la', 'pa$$w0rd'],
    ['thêm hậu tố số', 'password2026'],
    ['thêm hậu tố ký hiệu', 'password!!'],
    ['thêm hậu tố số và ký hiệu', 'Password123!'],
    ['thêm tiền tố số', '123password'],
    ['tiếng Việt có dấu', 'mật khẩu'],
    ['tiếng Việt dạng tổ hợp NFD', 'mật khẩu'.normalize('NFD')],
    ['tiếng Việt không dấu', 'matkhau123'],
    ['tên dịch vụ', 'GreenCanteen2026'],
    ['chữ đ', 'đăng nhập'],
  ]) {
    test(`từ chối: ${label}`, () => assert.equal(isCommonPassword(password), true));
  }
});

describe('mẫu quá đơn giản không cần có trong danh sách', () => {
  for (const [label, password] of [
    ['một ký tự lặp', 'zzzzzzzzzzzz'],
    ['ký hiệu lặp', '!!!!!!!!'],
    ['toàn khoảng trắng', '        '],
    ['cặp ký tự lặp', 'xyxyxyxyxyxy'],
    ['nhóm 4 ký tự lặp', 'wxyzwxyzwxyz'],
    ['dãy chữ cái ngược', 'zyxwvutsrqpon'],
    ['dãy số dài xuôi', '123456789012'],
    ['dãy số ngược', '9876543210'],
    ['hàng phím dài', 'qwertyuiopas'],
    ['hàng phím ngược', 'lkjhgfdsa'],
    ['cột phím', 'qazwsxedcrfv'],
  ]) {
    test(`từ chối: ${label}`, () => assert.equal(isCommonPassword(password), true));
  }
});

describe('mật khẩu hợp lệ không bị từ chối nhầm', () => {
  for (const [label, password] of [
    ['cụm từ không dấu dài', 'mat-khau-an-toan-1'],
    ['cụm từ tiếng Việt có dấu', 'Mật khẩu tiếng Việt của tôi'],
    ['từ phổ biến kèm dãy số dài ngẫu nhiên', 'sunshine8472915'],
    ['hai từ phổ biến ghép', 'dragon-sunshine'],
    ['8 ký tự ngẫu nhiên', 'xK9#mPq2'],
    ['128 ký tự ngẫu nhiên', 'bT7!qZ2@'.repeat(15) + 'kL4$pW9%'],
    ['ba từ thường', 'ngua vang chay nhanh'],
    ['có từ cấm bên trong câu dài', 'my password is not simple 2026'],
  ]) {
    test(label, () => {
      assert.equal(isCommonPassword(password), false);
      assert.equal(validatePassword(password), null);
    });
  }
});

describe('validatePassword', () => {
  test('biên độ dài giữ nguyên và được xét trước danh sách', () => {
    assert.match(validatePassword('1234567'), /ít nhất 8/);
    assert.equal(validatePassword('xK9#mPq2'), null);
    assert.equal(validatePassword('xK9#mPq2'.repeat(16)), null, '128 ký tự không lặp theo chu kỳ ngắn');
    assert.match(validatePassword(`${'xK9#mPq2'.repeat(16)}a`), /tối đa 128/);
    assert.equal(validatePassword(undefined), 'Mật khẩu cần ít nhất 8 ký tự.');
    assert.equal(validatePassword({ $ne: null }), 'Mật khẩu cần ít nhất 8 ký tự.');
  });

  test('thông báo chỉ dẫn cách chọn mật khẩu, không nhắc lại mật khẩu và không tiết lộ danh sách', () => {
    for (const password of ['12345678', 'Password123!', 'mật khẩu']) {
      const message = validatePassword(password);
      assert.equal(message, COMMON_PASSWORD_MESSAGE);
      assert.ok(!message.includes(password));
      assert.doesNotMatch(message, LENGTH_MESSAGES);
    }
    assert.match(COMMON_PASSWORD_MESSAGE, /cụm từ/);
    for (const entry of commonPasswordListInfo().items) assert.ok(!COMMON_PASSWORD_MESSAGE.toLowerCase().includes(` ${entry} `), entry);
  });
});
