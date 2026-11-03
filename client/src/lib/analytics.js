import { api } from './api';

// Đo truy cập ở mức tối thiểu: chỉ gửi tên trang / tên mục cố định kèm mã lượt truy cập ngẫu nhiên.
// Không gửi URL (có thể chứa mã đặt lại mật khẩu, mã QR), không dùng cookie, tôn trọng Do Not Track / Global Privacy Control.
const VISIT_KEY = 'gc_visit';
const VISIT_IDLE_MS = 30 * 60 * 1000;

let enabled = false;
let memoryVisit = null;

export function setAnalyticsEnabled(value) {
  enabled = value === true;
}

function trackingAllowed() {
  return enabled && navigator.doNotTrack !== '1' && navigator.globalPrivacyControl !== true;
}

function readVisit() {
  try {
    return JSON.parse(sessionStorage.getItem(VISIT_KEY)) || memoryVisit;
  } catch {
    return memoryVisit;
  }
}

/** crypto.randomUUID chỉ có trên HTTPS / localhost; getRandomValues dùng được cả khi mở qua IP LAN lúc phát triển */
function randomVisitId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Một lượt truy cập: sống trong tab này, kết thúc sau 30 phút không hoạt động */
function currentVisitId() {
  const now = Date.now();
  const saved = readVisit();
  const id = saved && now - saved.at < VISIT_IDLE_MS ? saved.id : randomVisitId();
  memoryVisit = { id, at: now };
  try {
    sessionStorage.setItem(VISIT_KEY, JSON.stringify(memoryVisit));
  } catch {
    // trình duyệt chặn sessionStorage → dùng bản trong bộ nhớ
  }
  return id;
}

function send(event) {
  if (!trackingAllowed()) return;
  // Thống kê không bao giờ được làm ảnh hưởng tới người dùng: mọi lỗi đều bị bỏ qua. Hàm này chạy trong useEffect và
  // ứng dụng không có Error Boundary, nên lỗi lọt ra ngoài sẽ làm trắng cả trang
  try {
    api.sendAnalyticsEvent({ ...event, visitId: currentVisitId() }).catch(() => {});
  } catch {
    // môi trường không tạo được mã ngẫu nhiên: bỏ qua sự kiện này
  }
}

export const trackPageView = (page) => send({ type: 'page_view', page });
export const trackImpression = (target) => send({ type: 'impression', target });
export const trackClick = (target) => send({ type: 'click', target });
