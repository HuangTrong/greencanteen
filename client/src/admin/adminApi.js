import { jsonBody, request } from '../lib/api';

// Token CSRF chỉ nằm trong bộ nhớ trang; tải lại trang thì lấy lại từ /session
let csrfToken = '';
const sessionLostListeners = new Set();

export const setCsrfToken = (token) => {
  csrfToken = token || '';
};

/** Phiên quản trị hết hạn giữa chừng → giao diện chuyển về màn hình đăng nhập */
export function onSessionLost(listener) {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

async function adminRequest(path, options = {}) {
  try {
    return await request(`/api/admin${path}`, {
      ...options,
      headers: { ...options.headers, ...(csrfToken && { 'X-CSRF-Token': csrfToken }) },
    });
  } catch (err) {
    if (err.code === 'admin_auth_required') sessionLostListeners.forEach((listener) => listener());
    throw err;
  }
}

const post = (path, body = {}) => adminRequest(path, jsonBody('POST', body));
const put = (path, body) => adminRequest(path, jsonBody('PUT', body));
const patch = (path, body) => adminRequest(path, jsonBody('PATCH', body));

export function toQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const adminApi = {
  session: () => adminRequest('/auth/session'),
  login: (email, password) => post('/auth/login', { email, password }),
  mfaSetup: (enrollCode) => post('/auth/mfa/setup', { enrollCode }),
  mfaVerify: (code) => post('/auth/mfa/verify', { code }),
  passkeyOptions: () => post('/auth/passkey/options'),
  passkeyVerify: (response) => post('/auth/passkey/verify', { response }),
  reauth: (password, code) => post('/auth/reauth', { password, code }),
  logout: () => post('/auth/logout'),

  overview: (params) => adminRequest(`/overview${toQuery(params)}`),

  users: (params) => adminRequest(`/users${toQuery(params)}`),
  user: (id) => adminRequest(`/users/${id}`),
  revealUser: (id) => post(`/users/${id}/reveal`),
  setUserStatus: (id, status, reason) => patch(`/users/${id}/status`, { status, reason }),
  setStudentId: (id, studentId, reason) => patch(`/users/${id}/student-id`, { studentId, reason }),
  setRole: (id, role, reason) => patch(`/users/${id}/role`, { role, reason }),
  resetUserMfa: (id, reason) => post(`/users/${id}/mfa-reset`, { reason }),
  resetStudentMfa: (id, reason) => post(`/users/${id}/student-mfa-reset`, { reason }),
  removeUserAvatar: (id, reason) => post(`/users/${id}/avatar-remove`, { reason }),
  bulkStatus: (ids, status, reason) => post('/users/bulk-status', { ids, status, reason }),

  stories: (params) => adminRequest(`/stories${toQuery(params)}`),
  story: (id) => adminRequest(`/stories/${id}`),
  createStory: (body) => post('/stories', body),
  updateStory: (id, body) => put(`/stories/${id}`, body),
  publishStory: (id, revision) => post(`/stories/${id}/publish`, { revision }),
  unpublishStory: (id, revision) => post(`/stories/${id}/unpublish`, { revision }),

  gachaConfigs: (params) => adminRequest(`/gacha/configs${toQuery(params)}`),
  gachaConfig: (id) => adminRequest(`/gacha/configs/${id}`),
  createGachaDraft: (basedOnId) => post('/gacha/configs', { basedOnId }),
  updateGachaDraft: (id, body) => put(`/gacha/configs/${id}`, body),
  publishGachaConfig: (id, revision) => post(`/gacha/configs/${id}/publish`, { revision }),
  endGachaConfig: (id) => post(`/gacha/configs/${id}/end`),
  discardGachaDraft: (id, revision) => post(`/gacha/configs/${id}/discard`, { revision }),
  gachaMedia: (params) => adminRequest(`/gacha/media${toQuery(params)}`),
  uploadGachaMedia: ({ kind, name, file }) => {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('name', name);
    fd.append('image', file);
    return adminRequest('/gacha/media', { method: 'POST', body: fd });
  },
  updateGachaMedia: (id, body) => patch(`/gacha/media/${id}`, body),
  deleteGachaMedia: (id) => adminRequest(`/gacha/media/${id}`, { method: 'DELETE' }),
  gachaRewards: (params) => adminRequest(`/gacha/rewards${toQuery(params)}`),
  deliverGachaReward: (id, note) => post(`/gacha/rewards/${id}/deliver`, { note }),
  undeliverGachaReward: (id, reason) => post(`/gacha/rewards/${id}/undeliver`, { reason }),

  siteSettings: () => adminRequest('/site-settings'),
  updateSiteSettings: (body) => put('/site-settings', body),

  auditLogs: (params) => adminRequest(`/audit-logs${toQuery(params)}`),
};
