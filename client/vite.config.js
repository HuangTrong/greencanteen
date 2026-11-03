import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const fromRoot = (path) => fileURLToPath(new URL(path, import.meta.url));

/** Đường dẫn con của khu quản trị (vd. /admin/users) đều trả về trang HTML riêng của khu quản trị */
function adminSpaFallback() {
  const rewrite = (req, _res, next) => {
    const path = (req.url || '').split('?')[0];
    if (/^\/admin(\/|$)/.test(path) && !path.slice(1).includes('.')) req.url = '/admin/index.html';
    next();
  };
  return {
    name: 'admin-spa-fallback',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

/**
 * Lớp phòng thủ trong bản build, không áp dụng khi chạy dev vì Vite cần script nội tuyến. Trang quản trị: CSP chỉ cho nạp mã cùng nguồn,
 * không tải tài nguyên bên thứ ba, không đăng ký service worker, không khai báo PWA. Trang sinh viên: CSP cho thêm đúng những gì giao diện
 * cần: font Google, ảnh câu chuyện (https), ảnh xem trước chọn từ máy (blob), service worker.
 */
function pageHardening(apiUrl) {
  const connect = apiUrl ? `'self' ${new URL(apiUrl).origin}` : "'self'";
  const base = ["default-src 'none'", "script-src 'self'", `connect-src ${connect}`, "base-uri 'none'", "form-action 'self'"];
  const adminCsp = [...base, "style-src 'self'", "img-src 'self' https: data:"].join('; ');
  const publicCsp = [
    ...base,
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' https: data: blob:",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join('; ');
  const withCsp = (html, csp) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  return {
    name: 'page-hardening',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, { path }) {
        if (!path.startsWith('/admin/')) return withCsp(html, publicCsp);
        return withCsp(html.replace(/\s*<link rel="manifest"[^>]*>/, '').replace(/\s*<script id="vite-plugin-pwa:register-sw"[^>]*><\/script>/, ''), adminCsp);
      },
    },
  };
}

/** robots.txt và sitemap.xml cho trang công khai. Sitemap cần địa chỉ tuyệt đối nên chỉ có khi đặt VITE_SITE_URL */
function seoFiles(siteUrl) {
  const pages = ['/', '/leaderboard', '/privacy.html', '/data-deletion.html'];
  return {
    name: 'seo-files',
    generateBundle() {
      const origin = siteUrl?.replace(/\/$/, '');
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        // Không chặn /admin ở đây: trình thu thập phải đọc được thẻ noindex của trang thì mới không lập chỉ mục nó
        source: ['User-agent: *', 'Allow: /', 'Disallow: /api/', ...(origin ? [`Sitemap: ${origin}/sitemap.xml`] : []), ''].join('\n'),
      });
      if (!origin) return;
      const urls = pages.map((page) => `  <url><loc>${origin}${page}</loc></url>`).join('\n');
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg'],
        workbox: {
          // Đăng nhập Google/Facebook là điều hướng cả trang tới /api/auth/... — service worker
          // không được trả index.html thay cho các URL này. Khu quản trị cũng đi thẳng ra mạng.
          navigateFallbackDenylist: [/^\/api\//, /^\/admin(\/|$)/],
          // Mã quản trị không nằm trong precache: máy sinh viên không tải về, không có gì của khu quản trị dùng offline được
          globIgnores: ['admin/**', 'assets/admin-*'],
        },
        manifest: {
          name: 'GreenCanteen',
          short_name: 'GreenCanteen',
          description: 'Check-in bình nước cá nhân tại căn tin trường học',
          theme_color: '#16a34a',
          background_color: '#f0fdf4',
          display: 'standalone',
          start_url: '/',
          icons: [
            {
              src: '/favicon.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any maskable',
            },
          ],
        },
      }),
      adminSpaFallback(),
      pageHardening(env.VITE_API_URL),
      seoFiles(env.VITE_SITE_URL),
    ],
    build: {
      rollupOptions: {
        input: {
          index: fromRoot('./index.html'),
          admin: fromRoot('./admin/index.html'),
          // HTML tĩnh, không qua React: trình thu thập của Meta đọc được nội dung mà không cần chạy JavaScript
          privacy: fromRoot('./privacy.html'),
          dataDeletion: fromRoot('./data-deletion.html'),
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          // Kiểm thử hệ thống (Playwright) trỏ sang API thử nghiệm riêng; mặc định là server dev
          target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
