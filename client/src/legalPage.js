import { api } from './lib/api';

// Nội dung privacy.html, data-deletion.html nằm sẵn trong HTML để trình thu thập của Meta đọc được mà không chạy JavaScript.
// Chỉ thông tin liên hệ do admin đặt mới lấy từ API; tải lỗi thì giữ câu mặc định trong HTML.
export async function showSupportContact() {
  try {
    const { supportContact } = await api.siteSettings();
    if (!supportContact) return;
    for (const element of document.querySelectorAll('[data-support-contact]')) element.textContent = supportContact;
  } catch {
    // giữ câu mặc định
  }
}

showSupportContact();
