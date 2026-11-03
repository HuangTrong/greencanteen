import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import AdminApp from '../../src/admin/AdminApp';
import { LocationProbe, json } from '../helpers';

export const ADMIN_SESSION = {
  stage: 'active',
  csrfToken: 'csrf-thu-nghiem',
  mfaEnrolled: true,
  admin: { id: 'admin-1', name: 'Quản Trị', email: 'ad***@example.edu.vn' },
  expiresAt: '2026-10-31T10:00:00.000Z',
  idleTimeoutMs: 900000,
  reauthValidUntil: '2026-10-31T03:05:00.000Z',
};

export const LOGGED_IN = { 'GET /api/admin/auth/session': json(ADMIN_SESSION) };
export const NO_SESSION = { 'GET /api/admin/auth/session': json({ stage: 'none' }) };

export const REAUTH_REQUIRED = () => json({ error: 'Cần xác thực lại trước khi thực hiện thao tác này.', code: 'reauth_required' }, 403);
export const SESSION_LOST = () => json({ error: 'Cần đăng nhập quản trị.', code: 'admin_auth_required' }, 401);

export function renderAdmin(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AdminApp />
      <LocationProbe />
    </MemoryRouter>
  );
}

export const USER_ROW = {
  id: '0123456789abcdef01234567',
  name: 'Nguyễn An',
  studentId: 'SV***01',
  email: 'ng***@example.edu.vn',
  role: 'user',
  status: 'active',
  totalCheckIns: 3,
  ecoPoints: 30,
  createdAt: '2026-09-01T08:00:00.000Z',
};

export const USER_DETAIL = {
  ...USER_ROW,
  authMethods: { password: true, google: false, facebook: false },
  lockedAt: null,
  lockReason: '',
  pendingGachaSpins: 1,
  plasticSavedGrams: 36,
  updatedAt: '2026-09-02T08:00:00.000Z',
  counts: { validCheckIns: 3, invalidCheckIns: 1, rewards: 2, sessions: 1 },
  mfaEnrolled: false,
};

export const PRIZE = {
  prizeId: 'topup-10k',
  label: 'Mã nạp điện thoại',
  prizeType: 'phone_topup',
  carrier: 'Viettel',
  amountVnd: 10_000,
  probabilityPpm: 1_000_000,
  enabled: true,
  maxQuantity: null,
};

export const GACHA_DRAFT = {
  id: 'abcdefabcdefabcdefabcdef',
  version: 3,
  revision: 0,
  status: 'draft',
  isCurrent: false,
  prizes: [PRIZE],
  budgetVnd: null,
  effectiveFrom: null,
  effectiveTo: null,
  note: '',
  basedOnVersion: 2,
  createdByLabel: 'ad***@example.edu.vn',
  updatedByLabel: 'ad***@example.edu.vn',
  publishedByLabel: '',
  publishedAt: null,
  endedByLabel: '',
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
  issued: [],
  budgetUsedVnd: 0,
};

export const STORY = {
  id: 'fedcbafedcbafedcbafedcba',
  revision: 2,
  slug: 'rua-bien',
  status: 'published',
  origin: 'seed',
  title: 'Rùa biển và nhựa',
  species: 'Rùa biển',
  icon: '🐢',
  imageUrl: '',
  summary: 'Tóm tắt nghiên cứu.',
  caveat: 'Kết quả ở cấp quần thể.',
  message: 'Mang bình của bạn.',
  source: { title: 'Tên bài báo', authors: ['Wilcox C', 'Hardesty BD'], journal: 'Scientific Reports', year: 2018, volume: '8', issue: '', pages: '12536', doi: '10.1038/x', url: 'https://doi.org/10.1038/x' },
  publishedAt: '2026-10-01T00:00:00.000Z',
  adminEditedAt: null,
  createdByLabel: '',
  updatedByLabel: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

export const OVERVIEW = {
  range: { from: '2026-10-01', to: '2026-10-03', granularity: 'day', timezone: 'Asia/Ho_Chi_Minh', utcOffset: '+07:00' },
  generatedAt: '2026-10-03T05:00:00.000Z',
  totals: { accountsTotal: 120, accountsLocked: 2, accountsNew: 5, checkInsValid: 40, checkInsInvalid: 7, checkInsSimulated: 0, gachaSpins: 30, rewardFaceValueVnd: 450_000 },
  rewardsByAmount: [{ amountVnd: 10_000, count: 30, faceValueVnd: 300_000 }],
  series: [
    { period: '2026-10-01', accountsNew: 1, checkInsValid: 10, checkInsInvalid: 1, gachaSpins: 8, rewardFaceValueVnd: 80_000, pageViews: null, visits: null, activeUsers: null },
    { period: '2026-10-02', accountsNew: 2, checkInsValid: 25, checkInsInvalid: 2, gachaSpins: 12, rewardFaceValueVnd: 120_000, pageViews: 0, visits: 0, activeUsers: 0 },
    { period: '2026-10-03', accountsNew: 2, checkInsValid: 5, checkInsInvalid: 4, gachaSpins: 10, rewardFaceValueVnd: 250_000, pageViews: 15, visits: 6, activeUsers: 3 },
  ],
  traffic: { status: 'disabled', enabled: false, totals: null, clickThrough: [], retentionDays: 90, collectingSince: null, activeUsersAvailable: false },
  financial: { status: 'no_data_source', revenueVnd: null, costVnd: null, profitVnd: null, note: 'Mệnh giá giải Gacha không được tính là doanh thu.' },
  definitions: [{ key: 'checkInsValid', label: 'Check-in hợp lệ', unit: 'lượt', source: 'Collection checkins', definition: 'Lượt ảnh đạt ngưỡng.' }],
};
