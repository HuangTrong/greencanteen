/** Các loại server phân biệt. Chỉ hai loại đầu được cộng thưởng (khi đạt ngưỡng tin cậy). */
export const CATEGORY_LABELS = {
  reusable_bottle: 'Bình nước cá nhân có thể tái sử dụng',
  reusable_cup: 'Ly/cốc cá nhân có thể tái sử dụng',
  single_use_plastic_cup: 'Ly nhựa dùng một lần',
  other_container: 'Vật chứa khác',
  no_container: 'Không có vật chứa',
  unclear: 'Ảnh không rõ',
};
export const CATEGORIES = Object.keys(CATEGORY_LABELS);
export const REWARDABLE_CATEGORIES = new Set(['reusable_bottle', 'reusable_cup']);

/**
 * Lỗi có trạng thái của một bộ nhận diện tại máy chủ:
 * not_configured | busy | timeout | invalid_image | invalid_response | provider_error
 */
export class VisionEngineError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
