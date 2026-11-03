import { Router } from 'express';
import { adminAction, adminRead } from '../middleware/admin.js';
import { adminActor } from '../services/audit.js';
import { getAdminSettings, updateSettings } from '../services/siteSettings.js';

const router = Router();

router.get('/', adminRead(() => getAdminSettings()));

router.put(
  '/',
  adminAction('site_settings.update', async (req, ctx) => {
    ctx.target = { type: 'site_settings', id: 'public' };
    const { settings, changed } = await updateSettings(adminActor(req.admin), req.body);
    ctx.meta = { changed };
    return settings;
  })
);

export default router;
