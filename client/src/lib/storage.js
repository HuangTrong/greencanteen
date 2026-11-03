// Bản cũ lưu hồ sơ người dùng (dùng để "đăng nhập lại" chỉ bằng mã SV + họ tên) và lịch sử check-in
// trong localStorage — dùng chung cho mọi người trên cùng máy. Giờ phiên là cookie httpOnly và lịch sử
// lấy từ server theo phiên → chỉ còn việc xóa dữ liệu cũ.
const LEGACY_KEYS = ['greencanteen_session', 'greencanteen_local_history'];

export function clearLocalData() {
  for (const key of LEGACY_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // trình duyệt chặn localStorage → không có gì để xóa
    }
  }
}
