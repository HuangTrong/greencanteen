import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Danh sách nằm trong mã nguồn, không gọi dịch vụ ngoài và không gửi mật khẩu đi đâu. Nguồn, phiên bản: đầu tệp danh sách
const LIST_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/common-passwords.txt');
const lines = fs.readFileSync(LIST_FILE, 'utf8').split(/\r?\n/);
const COMMON = new Set(lines.filter((line) => line.trim() && !line.startsWith('#')).map((line) => line.trim()));
const header = (name) => lines.find((line) => line.startsWith(`# ${name}:`))?.slice(name.length + 3).trim() || '';

export const COMMON_PASSWORD_MESSAGE =
  'Mật khẩu này quá phổ biến nên dễ bị đoán. Hãy dùng một cụm từ dài gồm vài từ ít liên quan đến nhau, tránh dãy số, dãy phím, tên riêng và tên dịch vụ.';

export const PERSONAL_PASSWORD_MESSAGE = 'Mật khẩu không được chứa họ tên, mã sinh viên hoặc email của bạn vì đây là những thông tin dễ bị đoán đầu tiên.';

// Đoạn ngắn hơn mức này (tên "An", mã "A1") có thể trùng ngẫu nhiên trong một mật khẩu tốt
const MIN_PERSONAL_LENGTH = 4;

export const commonPasswordListInfo = () => ({ version: header('version'), source: header('source'), entries: COMMON.size, items: [...COMMON] });

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

// Dãy theo bảng chữ cái, chữ số, hàng phím và cột phím: mọi đoạn liên tiếp, xuôi hoặc ngược, đều không có giá trị bảo mật
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890123456789', 'qwertyuiopasdfghjklzxcvbnm', 'qazwsxedcrfvtgbyhnujmikolp', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p', '1q2w3e4r5t6y7u8i9o0p'];
const reversed = (text) => [...text].reverse().join('');

/** NFKD: chữ full-width về ASCII, dấu tiếng Việt tách thành ký tự riêng. Chỉ để so khớp — mật khẩu lưu không đổi (services/password.js) */
const canonical = (password) =>
  password
    .normalize('NFKD')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim();

/** Chỉ giữ chữ và số: bỏ khoảng trắng, dấu nối, ký hiệu và cả dấu tiếng Việt đã tách ở trên */
const compact = (text) => text.replace(/[^\p{L}\p{N}]+/gu, '');

function isTrivial(text) {
  if (!text) return true;
  for (let size = 1; size <= 4 && size <= text.length / 2; size += 1) {
    if (text === text.slice(0, size).repeat(Math.ceil(text.length / size)).slice(0, text.length)) return true;
  }
  return SEQUENCES.some((sequence) => sequence.includes(text) || reversed(sequence).includes(text));
}

/** Mật khẩu có nằm trong danh sách (kể cả biến thể hoa/thường, dấu, leet, thêm số vào đầu/cuối) hoặc là mẫu quá đơn giản không */
export function isCommonPassword(password) {
  const base = canonical(password);
  const plain = compact(base);
  if (isTrivial(base) || isTrivial(plain)) return true;

  const deLeet = [...base].map((char) => LEET[char] ?? char).join('');
  const forms = new Set([base, plain, deLeet, compact(deLeet)]);
  for (const form of [...forms]) {
    // Thói quen thêm vài số hoặc ký hiệu vào đầu/cuối một từ phổ biến không làm mật khẩu khó đoán hơn
    const core = form.replace(/^[^\p{L}]{1,6}/u, '').replace(/[^\p{L}]{1,6}$/u, '');
    forms.add(core);
  }
  return [...forms].some((form) => COMMON.has(form));
}

/** Công cụ đoán mật khẩu theo ngữ cảnh bắt đầu từ thông tin công khai của nạn nhân: so khớp sau khi bỏ dấu, hoa thường và ký hiệu */
export function containsPersonalInfo(password, { name, studentId, email } = {}) {
  const text = compact(canonical(password));
  return [name, studentId, email?.split('@')[0]].some((value) => {
    const part = compact(canonical(value || ''));
    return part.length >= MIN_PERSONAL_LENGTH && text.includes(part);
  });
}
