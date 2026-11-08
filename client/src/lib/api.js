const API_BASE = import.meta.env.VITE_API_URL || '';

const unauthorizedListeners = new Set();

/** Báo cho UserContext khi server trả 401 auth_required (phiên hết hạn / đã bị thu hồi) */
export function onUnauthorized(listener) {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function fallbackMessage(status, isJson) {
  // API luôn trả lỗi dạng JSON; lỗi 5xx không có JSON nghĩa là proxy (vd. Vite khi chạy dev) không tới được API
  if (status >= 500 && !isJson) {
    return 'Không kết nối được máy chủ API (máy chủ có thể đang khởi động lại). Vui lòng thử lại sau vài giây.';
  }
  if (status === 413) return 'Dữ liệu gửi lên quá lớn.';
  if (status === 429) return 'Bạn thao tác quá nhiều lần. Vui lòng thử lại sau.';
  if (status >= 500) return 'Máy chủ đang gặp sự cố. Vui lòng thử lại sau.';
  return 'Yêu cầu thất bại.';
}

export async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      // Phiên đăng nhập nằm trong cookie httpOnly do server đặt — frontend không giữ mật khẩu hay token
      credentials: 'include',
      // Header tùy chỉnh để server chống CSRF (trang web khác không gửi được header này)
      headers: { 'X-Requested-With': 'GreenCanteen', ...options.headers },
    });
  } catch {
    const err = new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
    err.code = 'network_error';
    throw err;
  }
  let data = {};
  let isJson = false;
  try {
    data = (await res.json()) || {};
    isJson = true;
  } catch {
    // thân phản hồi rỗng hoặc không phải JSON
  }
  if (!res.ok) {
    if (res.status === 401 && data.code === 'auth_required') {
      unauthorizedListeners.forEach((listener) => listener());
    }
    const err = new Error(data.error || data.reason || fallbackMessage(res.status, isJson));
    err.status = res.status;
    err.code = data.code;
    err.payload = data;
    throw err;
  }
  // API luôn trả JSON — 2xx không phải JSON (vd. trang HTML do proxy/hosting trả thay) không phải là thành công
  if (!isJson) {
    const err = new Error('Phản hồi từ máy chủ không hợp lệ. Vui lòng thử lại sau.');
    err.status = res.status;
    err.code = 'invalid_response';
    throw err;
  }
  return data;
}

export const jsonBody = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Đường dẫn tương đối server trả về (vd. ảnh đại diện) → URL dùng được khi API nằm ở nguồn khác */
export const assetUrl = (path) => `${API_BASE}${path}`;

// Các API cá nhân không gửi mã sinh viên: server xác định tài khoản từ phiên đăng nhập
export const api = {
  siteSettings: () => request('/api/site/settings'),
  sendAnalyticsEvent: (event) => request('/api/analytics/events', { ...jsonBody('POST', event), keepalive: true }),
  schoolStats: () => request('/api/stats/school'),
  leaderboard: (period = 'week') => request(`/api/stats/leaderboard?period=${period}`),

  authProviders: () => request('/api/auth/providers'),
  me: () => request('/api/auth/me'),
  captcha: () => request('/api/auth/captcha', { method: 'POST' }),
  register: (body, captcha) => request('/api/auth/register', jsonBody('POST', { ...body, captcha })),
  verifyEmail: (body) => request('/api/auth/email/verify', jsonBody('POST', body)),
  resendVerification: (email, captcha) => request('/api/auth/email/resend', jsonBody('POST', { email, captcha })),
  login: (body, captcha) => request('/api/auth/login', jsonBody('POST', { ...body, captcha })),
  mfaVerify: (code) => request('/api/auth/mfa/verify', jsonBody('POST', { code })),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  revokeOtherSessions: () => request('/api/auth/sessions/revoke-others', { method: 'POST' }),
  reauth: (password, code) => request('/api/auth/reauth', jsonBody('POST', { password, code })),
  unlinkProvider: (provider) => request(`/api/auth/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' }),
  forgotPassword: (email, captcha) => request('/api/auth/password/forgot', jsonBody('POST', { email, captcha })),
  resetPassword: (token, password) => request('/api/auth/password/reset', jsonBody('POST', { token, password })),
  resetPasswordWithCode: (email, code, password) =>
    request('/api/auth/password/reset-code', jsonBody('POST', { email, code, password })),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/password/change', jsonBody('POST', { currentPassword, newPassword })),
  /** Google/Facebook: điều hướng cả trang tới server, server chuyển tiếp sang nhà cung cấp */
  oauthStartUrl: (provider, mode = 'login') => `${API_BASE}/api/auth/${provider}/start?mode=${mode}`,
  pendingSignup: () => request('/api/auth/signup/pending'),
  completeSignup: (body) => request('/api/auth/signup/complete', jsonBody('POST', body)),
  cancelSignup: () => request('/api/auth/signup/pending', { method: 'DELETE' }),
  accountSecurity: () => request('/api/auth/security'),
  mfaSetup: () => request('/api/auth/mfa/setup', { method: 'POST' }),
  mfaEnable: (code) => request('/api/auth/mfa/enable', jsonBody('POST', { code })),
  mfaDisable: (proof) => request('/api/auth/mfa/disable', jsonBody('POST', proof)),
  mfaRecoveryCodes: (proof) => request('/api/auth/mfa/recovery-codes', jsonBody('POST', proof)),
  passkeyRegisterOptions: () => request('/api/auth/passkeys/register/options', { method: 'POST' }),
  passkeyRegisterVerify: (response, name) => request('/api/auth/passkeys/register/verify', jsonBody('POST', { response, name })),
  passkeyRemove: (id) => request(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  passkeyLoginOptions: () => request('/api/auth/passkeys/login/options', { method: 'POST' }),
  passkeyLoginVerify: (response) => request('/api/auth/passkeys/login/verify', jsonBody('POST', { response })),
  qrStart: () => request('/api/auth/qr/start', { method: 'POST' }),
  qrPoll: (pollToken) => request('/api/auth/qr/poll', jsonBody('POST', { pollToken })),
  qrChallenge: (challengeId) => request(`/api/auth/qr/challenge/${encodeURIComponent(challengeId)}`),
  qrApprove: (challengeId, matchCode) =>
    request(`/api/auth/qr/challenge/${encodeURIComponent(challengeId)}/approve`, jsonBody('POST', { matchCode })),
  qrReject: (challengeId) =>
    request(`/api/auth/qr/challenge/${encodeURIComponent(challengeId)}/reject`, { method: 'POST' }),
  uploadAvatar: (imageFile) => {
    const fd = new FormData();
    fd.append('image', imageFile);
    return request('/api/avatars/me', { method: 'PUT', body: fd });
  },
  removeAvatar: () => request('/api/avatars/me', { method: 'DELETE' }),

  checkInStatus: () => request('/api/checkin/status'),
  checkIn: (imageFile) => {
    const fd = new FormData();
    fd.append('image', imageFile);
    return request('/api/checkin', { method: 'POST', body: fd });
  },
  history: () => request('/api/checkin/history'),
  // Quay thưởng tri ân (đường dẫn API giữ tên "gacha" từ trước)
  gachaDraw: () => request('/api/gacha/draw', { method: 'POST' }),
  gachaResults: () => request('/api/gacha/results'),
  /** Thể lệ công khai: cấu hình quay thưởng đang hiệu lực, không cần đăng nhập */
  gachaRules: () => request('/api/gacha/rules'),
};
