import { Router } from 'express';
import { limitAdminApi, requireAdmin, requireAdminCsrf } from '../middleware/admin.js';
import overviewRoutes from './adminOverview.js';
import userRoutes from './adminUsers.js';
import storyRoutes from './adminStories.js';
import gachaRoutes from './adminGacha.js';
import settingsRoutes from './adminSettings.js';
import auditRoutes from './adminAudit.js';

// Bảng này cũng là nguồn cho test kiểm kê route: thêm mục ở đây thì test tự kiểm tra quyền của mọi route trong mục đó
export const ADMIN_SECTIONS = [
  ['/overview', overviewRoutes],
  ['/users', userRoutes],
  ['/stories', storyRoutes],
  ['/gacha', gachaRoutes],
  ['/site-settings', settingsRoutes],
  ['/audit-logs', auditRoutes],
];

const router = Router();

// Mọi route quản trị đi qua cùng một chuỗi kiểm tra, kể cả đường dẫn không tồn tại
router.use(requireAdmin, requireAdminCsrf, limitAdminApi);
for (const [path, section] of ADMIN_SECTIONS) router.use(path, section);

export default router;
