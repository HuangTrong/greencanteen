import { Router } from 'express';
import { adminRead } from '../middleware/admin.js';
import { buildOverview } from '../services/adminStats.js';

const router = Router();

router.get('/', adminRead((req) => buildOverview(req.query)));

export default router;
