import { api } from './lib/api';

// Nội dung các trang thông tin, chính sách nằm sẵn trong HTML để trình thu thập (Meta, công cụ tìm kiếm) đọc được mà không chạy JavaScript.
// Chỉ thông tin liên hệ do admin đặt mới lấy từ API; tải lỗi thì giữ câu mặc định trong HTML.
// Ghi chú "chưa công bố" về kênh liên hệ ([data-support-contact-pending]) chỉ ẩn đi khi admin đã đặt liên hệ.
export async function showSupportContact() {
  try {
    const { supportContact } = await api.siteSettings();
    if (!supportContact) return;
    for (const element of document.querySelectorAll('[data-support-contact]')) element.textContent = supportContact;
    for (const element of document.querySelectorAll('[data-support-contact-pending]')) element.hidden = true;
  } catch {
    // giữ câu mặc định
  }
}

showSupportContact();
