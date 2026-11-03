import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import authRoutes from './routes/auth.js';
import accountSecurityRoutes from './routes/accountSecurity.js';
import qrAuthRoutes from './routes/qrAuth.js';
import checkinRoutes from './routes/checkin.js';
import statsRoutes from './routes/stats.js';
import avatarRoutes from './routes/avatars.js';
import gachaRoutes from './routes/gacha.js';
import siteRoutes from './routes/site.js';
import analyticsRoutes from './routes/analytics.js';
import adminAuthRoutes from './routes/adminAuth.js';
import adminRoutes from './routes/admin.js';
import { requireClientHeader } from './middleware/auth.js';
import { adminResponseHeaders, requireAdminConfigured, requireAdminOrigin } from './middleware/admin.js';
import { floodGuard } from './middleware/floodGuard.js';
import { clientOrigin, isProduction } from './services/config.js';
import { trustProxySetting } from './services/rateLimit.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxySetting());

  // Trình duyệt không được đoán JSON thành kiểu khác; hồ sơ, lịch sử, mã nạp không được nằm lại trong cache
  app.use('/api', (_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    // Trình duyệt ghi nhớ chỉ dùng HTTPS nên kẻ đứng giữa không hạ được lần truy cập sau xuống HTTP
    if (isProduction()) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(cors({ origin: clientOrigin(), credentials: true }));
  app.use('/api', floodGuard);
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', requireClientHeader);

  app.get('/api/health', (_req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    res
      .status(dbReady ? 200 : 503)
      .json({ ok: dbReady, service: 'GreenCanteen API', db: dbReady ? 'connected' : 'disconnected' });
  });

  app.use('/api/auth/qr', qrAuthRoutes);
  app.use('/api/auth', accountSecurityRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/checkin', checkinRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/avatars', avatarRoutes);
  app.use('/api/gacha', gachaRoutes);
  app.use('/api/site', siteRoutes);
  app.use('/api/analytics', analyticsRoutes);

  // Khu quản trị: các lớp chung cho mọi đường dẫn, kể cả đường dẫn không tồn tại; adminRoutes tự kiểm tra phiên và quyền
  app.use('/api/admin', adminResponseHeaders, requireAdminOrigin, requireAdminConfigured);
  app.use('/api/admin/auth', adminAuthRoutes);
  app.use('/api/admin', adminRoutes);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Không tìm thấy API.', code: 'not_found' });
  });

  // Lỗi lọt ra ngoài route (JSON sai cú pháp, body quá lớn...) cũng trả JSON thay vì trang HTML mặc định
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Dữ liệu gửi lên không phải JSON hợp lệ.', code: 'invalid_json' });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Dữ liệu gửi lên quá lớn.', code: 'payload_too_large' });
    }
    // Bảng mã, nén, URL sai do client gửi: không phải lỗi máy chủ, không ghi log để không ai làm đầy log bằng yêu cầu rác
    const status = err?.status || err?.statusCode;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: 'Yêu cầu không hợp lệ.', code: 'bad_request' });
    }
    console.error(err);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  });

  return app;
}
