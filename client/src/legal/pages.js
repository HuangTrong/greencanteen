// Các trang thông tin, chính sách là HTML tĩnh ở thư mục client/ để đọc được cả khi không chạy JavaScript (trình thu thập của Meta,
// công cụ tìm kiếm). Danh sách này là nguồn duy nhất cho: đầu vào build, sitemap, chân trang của các trang tĩnh và chân trang của
// ứng dụng. Thêm trang mới thì thêm tệp HTML (có <!--legal-footer--> sau thẻ main) rồi thêm một dòng ở đây.
export const LEGAL_PAGES = [
  { path: '/about.html', title: 'Giới thiệu GreenCanteen', footer: 'Giới thiệu' },
  { path: '/contact.html', title: 'Liên hệ', footer: 'Liên hệ' },
  { path: '/terms.html', title: 'Điều khoản sử dụng', footer: 'Điều khoản sử dụng' },
  { path: '/privacy.html', title: 'Chính sách bảo mật và xử lý dữ liệu cá nhân', footer: 'Chính sách bảo mật và xử lý dữ liệu cá nhân' },
  { path: '/operating-rules.html', title: 'Quy chế hoạt động', footer: 'Quy chế hoạt động' },
  { path: '/gacha-rules.html', title: 'Thể lệ quay thưởng tri ân', footer: 'Thể lệ quay thưởng' },
  { path: '/complaints.html', title: 'Tiếp nhận và giải quyết khiếu nại, tranh chấp', footer: 'Khiếu nại, tranh chấp' },
  // Trang con của chính sách bảo mật: có trong build và sitemap, không nằm ở chân trang
  { path: '/data-deletion.html', title: 'Hướng dẫn xóa dữ liệu', footer: null },
];

export const FOOTER_PAGES = LEGAL_PAGES.filter((page) => page.footer);

/** Chân trang cho các trang tĩnh, chèn lúc build (vite.config.js). Trang đang mở không thành liên kết tới chính nó */
export function legalFooterHtml(currentPath) {
  const items = FOOTER_PAGES.map(({ path, footer }) =>
    path === currentPath
      ? `<li><span aria-current="page" class="font-bold text-stone-700">${footer}</span></li>`
      : `<li><a href="${path}" class="underline underline-offset-2">${footer}</a></li>`
  ).join('');
  return [
    '<footer class="border-t border-leaf-100/80 px-4 pb-8 pt-5 text-xs text-stone-500">',
    '<nav aria-label="Thông tin và chính sách">',
    `<ul class="flex flex-wrap gap-x-4 gap-y-2">${items}</ul>`,
    '</nav>',
    '</footer>',
  ].join('');
}
