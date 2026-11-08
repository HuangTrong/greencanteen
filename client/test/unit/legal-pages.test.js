// Các trang thông tin, chính sách là HTML tĩnh (Meta và công cụ tìm kiếm đọc được mà không chạy JavaScript), danh sách ở src/legal/pages.js
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api } from '../../src/lib/api';
import { showSupportContact } from '../../src/legalPage';
import { FOOTER_PAGES, LEGAL_PAGES, legalFooterHtml } from '../../src/legal/pages';
import { describeRules, formatOdds, prizeRows, showGachaRules, winSummary } from '../../src/gachaRules';

const DEFAULT_CONTACT = 'quản trị viên GreenCanteen';
const PRIVACY_TITLE = 'Chính sách bảo mật và xử lý dữ liệu cá nhân';
const fileOf = (page) => page.path.slice(1);
const source = (file) => readFileSync(path.resolve(process.cwd(), file), 'utf8');
const parse = (file) => new DOMParser().parseFromString(source(file), 'text/html');
const headings = (doc, level) => [...doc.querySelectorAll(level)].map((el) => el.textContent.trim());

afterEach(() => {
  document.body.innerHTML = '';
});

describe.each(LEGAL_PAGES.map((page) => [fileOf(page), page]))('%s', (file, page) => {
  test('có tệp HTML, ghi rõ là trang gì ngay trong HTML, không phụ thuộc JavaScript', () => {
    expect(existsSync(path.resolve(process.cwd(), file))).toBe(true);
    const doc = parse(file);
    expect(doc.documentElement.lang).toBe('vi');
    expect(doc.title).toContain(page.title);
    expect(headings(doc, 'h1')).toEqual([page.title]);
    expect(doc.querySelector('main').textContent).toContain('Cập nhật lần cuối');
  });

  test('có chỗ chèn chân trang chung ngay sau thẻ main', () => {
    expect(source(file)).toMatch(/<\/main>\s*<!--legal-footer-->/);
  });

  test('chạy được dưới CSP của trang sinh viên: không có script hay style nội tuyến, không tải gì từ bên ngoài', () => {
    const doc = parse(file);
    expect(doc.querySelectorAll('style, [style]').length).toBe(0);
    for (const script of doc.querySelectorAll('script')) expect(script.getAttribute('src')).toMatch(/^\/src\//);
    for (const link of doc.querySelectorAll('link[href]')) expect(link.getAttribute('href')).toMatch(/^\//);
  });

  test('phần chưa đủ dữ kiện được đánh dấu "Chưa công bố", không để trống', () => {
    for (const pending of parse(file).querySelectorAll('[data-pending]')) {
      expect(pending.textContent).toContain('Chưa công bố');
      expect(pending.textContent).toContain('Không đủ dữ liệu để xác minh');
    }
  });
});

describe.each([
  ['privacy.html', '/data-deletion.html'],
  ['data-deletion.html', '/privacy.html'],
])('%s', (file, otherPage) => {
  test('có liên hệ mặc định khi không chạy được script, có liên kết tới trang còn lại', () => {
    const doc = parse(file);
    expect(doc.querySelector('[data-support-contact]').textContent).toBe(DEFAULT_CONTACT);
    expect(doc.querySelector(`main a[href="${otherPage}"]`)).not.toBeNull();
  });
});

test('privacy.html có đủ phần Meta yêu cầu: dữ liệu thu thập, mục đích, cách yêu cầu xóa', () => {
  const doc = parse('privacy.html');
  expect(headings(doc, 'h1')).toEqual([PRIVACY_TITLE]);
  const sections = headings(doc, 'h2').join(' | ');
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

test('không trang nào quảng bá mã thưởng như mã nạp dùng được', () => {
  for (const page of LEGAL_PAGES) expect(source(fileOf(page))).not.toMatch(/100% trúng|Nhận mã nạp điện thoại/);
});

describe('chân trang chung', () => {
  const doc = (currentPath) => new DOMParser().parseFromString(legalFooterHtml(currentPath), 'text/html');

  test('liên kết tới mọi trang ở chân trang trừ trang đang mở; trang con xóa dữ liệu không nằm ở chân trang', () => {
    const footer = doc('/terms.html');
    const links = [...footer.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(FOOTER_PAGES.map((page) => page.path).filter((p) => p !== '/terms.html'));
    expect(links).not.toContain('/data-deletion.html');
    expect(footer.querySelector('[aria-current="page"]').textContent).toBe('Điều khoản sử dụng');
  });
});

describe('showSupportContact', () => {
  const page = () => {
    document.body.innerHTML = `<p data-support-contact>${DEFAULT_CONTACT}</p><p data-support-contact>${DEFAULT_CONTACT}</p><p data-support-contact-pending>Chưa công bố</p>`;
    return [...document.querySelectorAll('[data-support-contact]')];
  };
  const pendingNote = () => document.querySelector('[data-support-contact-pending]');

  test('thay mọi vị trí bằng liên hệ do admin đặt, ẩn ghi chú "chưa công bố"', async () => {
    vi.spyOn(api, 'siteSettings').mockResolvedValue({ supportContact: 'Phòng Công tác sinh viên, ctsv@truong.edu.vn' });
    const elements = page();
    await showSupportContact();
    expect(elements.map((el) => el.textContent)).toEqual(Array(2).fill('Phòng Công tác sinh viên, ctsv@truong.edu.vn'));
    expect(pendingNote().hidden).toBe(true);
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
  ])('%s: giữ câu mặc định và ghi chú "chưa công bố"', async (_label, settings) => {
    vi.spyOn(api, 'siteSettings').mockImplementation(settings);
    const [first] = page();
    await showSupportContact();
    expect(first.textContent).toBe(DEFAULT_CONTACT);
    expect(pendingNote().hidden).toBe(false);
  });
});

describe('mẫu móc khóa ở trang thể lệ quay thưởng tri ân', () => {
  const RULES = {
    active: true,
    version: 3,
    effectiveFrom: '2026-11-01T00:00:00.000Z',
    effectiveTo: null,
    claimInstructions: 'Nhận tại quầy căn tin <b>tầng 1</b>',
    prizes: [
      { label: 'Lá vàng', description: 'Bản hiếm', imageUrl: '/api/gacha/media/a', probabilityPpm: 100, maxQuantity: 1, remaining: 0, available: false },
      { label: 'Lá xanh <img src=x onerror=alert(1)>', description: '', imageUrl: '/api/gacha/media/b', probabilityPpm: 10_000, maxQuantity: 50, remaining: 48, available: true },
    ],
  };

  test('xác suất cố định kèm "1 trên N"; mẫu đã hết ghi rõ tính là không trúng', () => {
    expect(prizeRows(RULES)).toEqual([
      { name: 'Lá vàng', description: 'Bản hiếm', imageUrl: '/api/gacha/media/a', probability: '0,01%', odds: 'Đã hết: tính là không trúng', remaining: '0/1' },
      { name: 'Lá xanh <img src=x onerror=alert(1)>', description: '', imageUrl: '/api/gacha/media/b', probability: '1%', odds: 'khoảng 1 trên 100 lượt', remaining: '48/50' },
    ]);
    expect(formatOdds(1)).toBe('khoảng 1 trên 1.000.000 lượt');
    expect(formatOdds(0)).toBe('không có cơ hội trúng');
  });

  test('tổng cơ hội trúng lúc này chỉ tính mẫu còn quà; phần còn lại là không trúng', () => {
    expect(winSummary(RULES)).toBe('Cơ hội trúng của mỗi lượt lúc này: 1% (khoảng 1 trên 100 lượt). Không trúng: 99%.');
  });

  test('mô tả phiên bản; không có cấu hình hiệu lực thì báo tạm dừng; hết quà thì báo giữ lượt', () => {
    expect(describeRules(RULES)).toMatch(/^Phiên bản 3, hiệu lực từ .+2026, chưa đặt thời điểm kết thúc\.$/);
    expect(describeRules({ active: false, prizes: [] })).toContain('quay thưởng tri ân tạm dừng');
    expect(describeRules({ ...RULES, prizes: [RULES.prizes[0]] })).toContain('Tất cả móc khóa của phiên bản này đã được trao hết');
  });

  test('hiển thị bằng textContent: tên và hướng dẫn do quản trị viên nhập không thành thẻ HTML; ảnh có chú thích', async () => {
    document.body.innerHTML = source('gacha-rules.html').match(/<main[\s\S]*<\/main>/)[0];
    vi.spyOn(api, 'gachaRules').mockResolvedValue(RULES);
    await showGachaRules(document.querySelector('[data-gacha-config]'), document.querySelector('[data-gacha-claim]'));
    const table = document.querySelector('[data-gacha-config] table');
    expect(table.hidden).toBe(false);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.querySelector('tbody').textContent).toContain('Lá xanh <img src=x onerror=alert(1)>');
    expect([...table.querySelectorAll('img')].map((img) => img.alt)).toEqual(['Móc khóa Lá vàng', 'Móc khóa Lá xanh <img src=x onerror=alert(1)>']);
    expect(document.querySelector('[data-gacha-claim]').textContent).toBe('Nhận tại quầy căn tin <b>tầng 1</b>');
    expect(document.querySelector('[data-gacha-claim] b')).toBeNull();
    expect(document.querySelector('[data-gacha-summary]').hidden).toBe(false);
  });

  test('không có cấu hình hiệu lực hoặc lỗi tải: bảng ẩn, báo rõ', async () => {
    document.body.innerHTML = source('gacha-rules.html').match(/<main[\s\S]*<\/main>/)[0];
    vi.spyOn(api, 'gachaRules').mockResolvedValueOnce({ active: false, prizes: [] }).mockRejectedValueOnce(new Error('mạng'));
    const root = document.querySelector('[data-gacha-config]');
    const claim = document.querySelector('[data-gacha-claim]');
    await showGachaRules(root, claim);
    expect(root.querySelector('table').hidden).toBe(true);
    expect(claim.textContent).toContain('chưa có hướng dẫn nhận quà');
    await showGachaRules(root, claim);
    expect(root.querySelector('[data-gacha-status]').textContent).toContain('Không tải được');
  });
});
