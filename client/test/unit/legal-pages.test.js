// privacy.html, data-deletion.html: Meta yêu cầu trang đọc được bằng trình thu thập nên nội dung nằm sẵn trong HTML, không qua React
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api } from '../../src/lib/api';
import { showSupportContact } from '../../src/legalPage';

const DEFAULT_CONTACT = 'quản trị viên GreenCanteen của trường';
const parse = (file) => new DOMParser().parseFromString(readFileSync(path.resolve(process.cwd(), file), 'utf8'), 'text/html');
const headings = (doc, level) => [...doc.querySelectorAll(level)].map((el) => el.textContent.trim());

afterEach(() => {
  document.body.innerHTML = '';
});

describe.each([
  ['privacy.html', 'Chính sách quyền riêng tư', '/data-deletion.html'],
  ['data-deletion.html', 'Hướng dẫn xóa dữ liệu', '/privacy.html'],
])('%s', (file, heading, otherPage) => {
  const doc = parse(file);

  test('ghi rõ là trang gì ngay trong HTML, không phụ thuộc JavaScript', () => {
    expect(doc.documentElement.lang).toBe('vi');
    expect(doc.title).toContain(heading);
    expect(headings(doc, 'h1')).toEqual([heading]);
    expect(doc.querySelector('main').textContent).toContain('Cập nhật lần cuối');
  });

  test('có liên hệ mặc định khi không chạy được script, có liên kết tới trang còn lại', () => {
    expect(doc.querySelector('[data-support-contact]').textContent).toBe(DEFAULT_CONTACT);
    expect(doc.querySelector(`main a[href="${otherPage}"]`)).not.toBeNull();
  });

  test('chạy được dưới CSP của trang sinh viên: không có script hay style nội tuyến, không tải gì từ bên ngoài', () => {
    expect(doc.querySelectorAll('style, [style]').length).toBe(0);
    for (const script of doc.querySelectorAll('script')) expect(script.getAttribute('src')).toMatch(/^\/src\//);
    for (const link of doc.querySelectorAll('link[href]')) expect(link.getAttribute('href')).toMatch(/^\//);
  });
});

test('privacy.html có đủ phần Meta yêu cầu: dữ liệu thu thập, mục đích, cách yêu cầu xóa', () => {
  const sections = headings(parse('privacy.html'), 'h2').join(' | ');
  expect(sections).toContain('Dữ liệu được thu thập');
  expect(sections).toContain('Mục đích sử dụng');
  expect(sections).toContain('Quyền của bạn');
  expect(sections).toContain('Liên hệ');
});

test('data-deletion.html nói rõ dữ liệu nào bị xóa, dữ liệu nào được giữ lại', () => {
  const doc = parse('data-deletion.html');
  expect(headings(doc, 'h2')).toContain('Xóa toàn bộ tài khoản');
  expect(headings(doc, 'h3')).toEqual(['Dữ liệu bị xóa', 'Dữ liệu được giữ lại']);
});

describe('showSupportContact', () => {
  const page = () => {
    document.body.innerHTML = `<p data-support-contact>${DEFAULT_CONTACT}</p><p data-support-contact>${DEFAULT_CONTACT}</p>`;
    return [...document.querySelectorAll('[data-support-contact]')];
  };

  test('thay mọi vị trí bằng liên hệ do admin đặt', async () => {
    vi.spyOn(api, 'siteSettings').mockResolvedValue({ supportContact: 'Phòng Công tác sinh viên, ctsv@truong.edu.vn' });
    const elements = page();
    await showSupportContact();
    expect(elements.map((el) => el.textContent)).toEqual(Array(2).fill('Phòng Công tác sinh viên, ctsv@truong.edu.vn'));
  });

  test('nội dung admin nhập chỉ là chữ, không thành thẻ HTML', async () => {
    vi.spyOn(api, 'siteSettings').mockResolvedValue({ supportContact: '<img src=x onerror=alert(1)>' });
    const [first] = page();
    await showSupportContact();
    expect(first.querySelector('img')).toBeNull();
    expect(first.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  test.each([
    ['admin chưa đặt liên hệ', () => Promise.resolve({ supportContact: '' })],
    ['API lỗi', () => Promise.reject(new Error('mất mạng'))],
  ])('%s: giữ câu mặc định', async (_label, settings) => {
    vi.spyOn(api, 'siteSettings').mockImplementation(settings);
    const [first] = page();
    await showSupportContact();
    expect(first.textContent).toBe(DEFAULT_CONTACT);
  });
});
