import { Router } from 'express';
import { getPublicSettings } from '../services/siteSettings.js';

const router = Router();

// Nội dung công khai, không có dữ liệu cá nhân: được phép cache ngắn thay vì no-store như các API khác
router.get('/settings', async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await getPublicSettings());
  } catch (e) {
    console.error(e);
    res.set('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

export default router;
