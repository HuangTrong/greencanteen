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
  counts: { validCheckIns: 3, invalidCheckIns: 1, spins: 5, rewards: 2, sessions: 1 },
  mfaEnrolled: false,
};

export const MEDIA = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  kind: 'keychain',
  name: 'Lá xanh',
  active: true,
  url: '/api/gacha/media/aaaaaaaaaaaaaaaaaaaaaaaa',
  width: 200,
  height: 200,
  bytes: 1234,
  animated: false,
  createdByLabel: 'ad***@example.edu.vn',
  updatedByLabel: '',
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
};

export const PRIZE = {
  prizeId: 'la-xanh',
  label: 'Lá xanh',
  prizeType: 'keychain',
  legacy: false,
  description: 'Móc khóa hình lá',
  imageId: MEDIA.id,
  imageUrl: MEDIA.url,
  probabilityPpm: 1_000,
  enabled: true,
  maxQuantity: 100,
};

export const GACHA_DRAFT = {
  id: 'abcdefabcdefabcdefabcdef',
  version: 3,
  revision: 0,
  status: 'draft',
  isCurrent: false,
  legacy: false,
  prizes: [PRIZE],
  budgetVnd: null,
  claimInstructions: 'Nhận tại quầy căn tin tầng 1.',
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
  spins: { total: 0, wins: 0, losses: 0 },
  usage: [{ prizeId: 'la-xanh', used: 4 }],
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
  totals: { accountsTotal: 120, accountsLocked: 2, accountsNew: 5, checkInsValid: 40, checkInsInvalid: 7, checkInsSimulated: 0, gachaSpins: 30, gachaWins: 3 },
  rewardsByAmount: [{ amountVnd: 10_000, count: 30, faceValueVnd: 300_000 }],
  series: [
    { period: '2026-10-01', accountsNew: 1, checkInsValid: 10, checkInsInvalid: 1, gachaSpins: 8, gachaWins: 1, pageViews: null, visits: null, activeUsers: null },
    { period: '2026-10-02', accountsNew: 2, checkInsValid: 25, checkInsInvalid: 2, gachaSpins: 12, gachaWins: 0, pageViews: 0, visits: 0, activeUsers: 0 },
    { period: '2026-10-03', accountsNew: 2, checkInsValid: 5, checkInsInvalid: 4, gachaSpins: 10, gachaWins: 2, pageViews: 15, visits: 6, activeUsers: 3 },
  ],
  traffic: { status: 'disabled', enabled: false, totals: null, clickThrough: [], retentionDays: 90, collectingSince: null, activeUsersAvailable: false },
  financial: { status: 'no_data_source', revenueVnd: null, costVnd: null, profitVnd: null, note: 'Móc khóa và mã nạp demo trước đây không được tính là doanh thu hay chi phí.' },
  definitions: [{ key: 'checkInsValid', label: 'Check-in hợp lệ', unit: 'lượt', source: 'Collection checkins', definition: 'Lượt ảnh đạt ngưỡng.' }],
};
