import nodemailer from 'nodemailer';
import { env, envFlag, envNumber, isProduction } from './config.js';

/**
 * Trạng thái gửi email (dùng cho "Quên mật khẩu"):
 * - smtp: cần SMTP_HOST và EMAIL_FROM (SMTP_USER/SMTP_PASS nếu máy chủ yêu cầu đăng nhập)
 * - console: CHỈ để phát triển — in nội dung email ra log server, không gửi thật; bị chặn khi NODE_ENV=production
 */
export function emailStatus() {
  const transport = env('EMAIL_TRANSPORT').toLowerCase() || 'smtp';
  if (transport === 'console') {
    return isProduction()
      ? { enabled: false, mode: 'console', reason: 'console_blocked_in_production' }
      : { enabled: true, mode: 'console' };
  }
  if (transport !== 'smtp') return { enabled: false, mode: transport, reason: 'unknown_transport' };
  if (!env('SMTP_HOST') || !env('EMAIL_FROM')) return { enabled: false, mode: 'smtp', reason: 'not_configured' };
  return { enabled: true, mode: 'smtp' };
}

export class EmailNotConfiguredError extends Error {}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Chỉ ghi mã lỗi vào log: thông điệp lỗi của máy chủ SMTP thường chứa nguyên địa chỉ người nhận */
export const mailFailureCode = (err) => err?.responseCode || err?.code || err?.name || 'unknown';

let transporter = null;

function smtpTransporter() {
  transporter ||= nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port: envNumber('SMTP_PORT', 587, { min: 1, max: 65535 }),
    // true cho cổng 465 (TLS ngay từ đầu); cổng 587 dùng STARTTLS, bắt buộc nâng cấp TLS
    secure: envFlag('SMTP_SECURE'),
    requireTLS: !envFlag('SMTP_SECURE') && !envFlag('SMTP_ALLOW_PLAINTEXT'),
    auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

export async function sendEmail({ to, subject, text, html }) {
  const status = emailStatus();
  if (!status.enabled) throw new EmailNotConfiguredError(status.reason);

  if (status.mode === 'console') {
    console.log(`\n[EMAIL — chế độ console, KHÔNG gửi thật]\nTới: ${to}\nTiêu đề: ${subject}\n\n${text}\n`);
    return { mode: 'console' };
  }
  // Địa chỉ người nhận truyền dạng object → không đi qua bộ phân tích danh sách địa chỉ của nodemailer
  await smtpTransporter().sendMail({ from: env('EMAIL_FROM'), to: { name: '', address: to }, subject, text, html });
  return { mode: 'smtp' };
}

/** Kiểm tra kết nối SMTP lúc khởi động — chỉ ghi log, không chặn server */
export async function verifyEmailTransport() {
  const status = emailStatus();
  if (status.mode === 'console' && status.enabled) {
    console.warn('EMAIL_TRANSPORT=console — email (đặt lại mật khẩu) chỉ được in ra log, KHÔNG gửi thật. Chỉ dùng khi phát triển.');
    return;
  }
  if (!status.enabled) {
    const detail =
      status.reason === 'console_blocked_in_production'
        ? 'EMAIL_TRANSPORT=console bị chặn khi NODE_ENV=production'
        : 'thiếu SMTP_HOST / EMAIL_FROM';
    console.log(`Email chưa cấu hình (${detail}) — "Quên mật khẩu" hiển thị trạng thái chưa sẵn sàng.`);
    return;
  }
  try {
    await smtpTransporter().verify();
    console.log(`SMTP sẵn sàng: ${env('SMTP_HOST')}`);
  } catch (err) {
    console.error(`Không kết nối được SMTP ${env('SMTP_HOST')}: ${err.message} — email đặt lại mật khẩu sẽ gửi thất bại.`);
  }
}
