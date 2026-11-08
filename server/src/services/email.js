import nodemailer from 'nodemailer';
import { env, envFlag, envNumber, isProduction } from './config.js';

const API_TIMEOUT_MS = 15_000;

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Gửi qua API HTTPS của nhà cung cấp, cho nơi chặn cổng SMTP: Railway gói Free/Trial/Hobby chỉ cho gửi thư qua API HTTPS.
 * Brevo: POST /v3/smtp/email, header api-key, sender là object { email, name }, bắt buộc htmlContent.
 * Resend: POST /emails, header Authorization: Bearer, from là chuỗi "Tên <email>".
 */
const API_TRANSPORTS = {
  brevo: {
    label: 'Brevo',
    keyEnv: 'BREVO_API_KEY',
    url: 'https://api.brevo.com/v3/smtp/email',
    request: (key, sender, { to, subject, text, html }) => ({
      headers: { 'api-key': key },
      body: { sender, to: [{ email: to }], subject, htmlContent: html || textAsHtml(text), textContent: text },
    }),
  },
  resend: {
    label: 'Resend',
    keyEnv: 'RESEND_API_KEY',
    url: 'https://api.resend.com/emails',
    request: (key, sender, { to, subject, text, html }) => ({
      headers: { Authorization: `Bearer ${key}` },
      body: { from: sender.name ? `${sender.name} <${sender.email}>` : sender.email, to: [to], subject, text, ...(html && { html }) },
    }),
  },
};

const textAsHtml = (text) => `<p>${escapeHtml(text || '').replace(/\n/g, '<br>')}</p>`;

/** EMAIL_FROM dạng "Tên <email>" hoặc chỉ email → { email, name? } (tên tối đa 70 ký tự theo Brevo); sai dạng → null */
export function parseSender(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:"?([^"<>]*?)"?\s*)?<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>$/) || text.match(/^()([^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+)$/);
  if (!match) return null;
  const name = (match[1] || '').trim().slice(0, 70);
  return name ? { email: match[2], name } : { email: match[2] };
}

/**
 * Trạng thái gửi email (xác minh đăng ký, "Quên mật khẩu", thư báo bảo mật):
 * - smtp: cần SMTP_HOST và EMAIL_FROM (SMTP_USER/SMTP_PASS nếu máy chủ yêu cầu đăng nhập)
 * - brevo / resend: gửi qua API HTTPS, cần BREVO_API_KEY / RESEND_API_KEY và EMAIL_FROM đúng dạng
 * - console: CHỈ để phát triển — in nội dung email ra log server, không gửi thật; bị chặn khi NODE_ENV=production
 */
export function emailStatus() {
  const transport = env('EMAIL_TRANSPORT').toLowerCase() || 'smtp';
  if (transport === 'console') {
    return isProduction()
      ? { enabled: false, mode: 'console', reason: 'console_blocked_in_production' }
      : { enabled: true, mode: 'console' };
  }
  const api = API_TRANSPORTS[transport];
  if (api) {
    return env(api.keyEnv) && parseSender(env('EMAIL_FROM'))
      ? { enabled: true, mode: transport }
      : { enabled: false, mode: transport, reason: 'not_configured' };
  }
  if (transport !== 'smtp') return { enabled: false, mode: transport, reason: 'unknown_transport' };
  if (!env('SMTP_HOST') || !env('EMAIL_FROM')) return { enabled: false, mode: 'smtp', reason: 'not_configured' };
  return { enabled: true, mode: 'smtp' };
}

export class EmailNotConfiguredError extends Error {}

/** Chỉ ghi mã lỗi vào log: thông điệp lỗi của máy chủ SMTP hay API gửi thư thường chứa nguyên địa chỉ người nhận */
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

const mailApiError = (code) => Object.assign(new Error(code), { code });

/** Mã lỗi ngắn của nhà cung cấp (Brevo: code, Resend: name). Bỏ message vì có thể chứa địa chỉ người nhận; mã chứa @ hay dấu chấm bị bỏ qua */
async function providerErrorCode(res) {
  try {
    const data = await res.json();
    const code = [data?.code, data?.name].find((v) => typeof v === 'string' && /^[A-Za-z][A-Za-z _-]{0,39}$/.test(v));
    return code ? `_${code.toLowerCase().replace(/[ -]/g, '_')}` : '';
  } catch {
    return '';
  }
}

async function sendViaApi(api, mail) {
  const { headers, body } = api.request(env(api.keyEnv), parseSender(env('EMAIL_FROM')), mail);
  let res;
  try {
    res = await fetch(api.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      // API gửi thư không chuyển hướng; không đi theo chuyển hướng để khóa API không bị gửi tới máy khác
      redirect: 'error',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw mailApiError(err?.name === 'TimeoutError' ? 'EMAIL_API_TIMEOUT' : 'EMAIL_API_UNREACHABLE');
  }
  if (!res.ok) throw mailApiError(`EMAIL_API_${res.status}${await providerErrorCode(res)}`);
}

export async function sendEmail({ to, subject, text, html }) {
  const status = emailStatus();
  if (!status.enabled) throw new EmailNotConfiguredError(status.reason);

  if (status.mode === 'console') {
    console.log(`\n[EMAIL — chế độ console, KHÔNG gửi thật]\nTới: ${to}\nTiêu đề: ${subject}\n\n${text}\n`);
    return { mode: 'console' };
  }
  const api = API_TRANSPORTS[status.mode];
  if (api) {
    await sendViaApi(api, { to, subject, text, html });
    return { mode: status.mode };
  }
  // Địa chỉ người nhận truyền dạng object → không đi qua bộ phân tích danh sách địa chỉ của nodemailer
  await smtpTransporter().sendMail({ from: env('EMAIL_FROM'), to: { name: '', address: to }, subject, text, html });
  return { mode: 'smtp' };
}

function notConfiguredDetail(status) {
  if (status.reason === 'console_blocked_in_production') return 'EMAIL_TRANSPORT=console bị chặn khi NODE_ENV=production';
  if (status.reason === 'unknown_transport') return `EMAIL_TRANSPORT=${status.mode} không hợp lệ, chỉ nhận smtp, brevo, resend, console`;
  const api = API_TRANSPORTS[status.mode];
  return api ? `thiếu ${api.keyEnv}, hoặc EMAIL_FROM không đúng dạng "Tên <email>"` : 'thiếu SMTP_HOST / EMAIL_FROM';
}

/** Kiểm tra cấu hình gửi thư lúc khởi động — chỉ ghi log, không chặn server */
export async function verifyEmailTransport() {
  const status = emailStatus();
  if (status.mode === 'console' && status.enabled) {
    console.warn('EMAIL_TRANSPORT=console — email (đặt lại mật khẩu) chỉ được in ra log, KHÔNG gửi thật. Chỉ dùng khi phát triển.');
    return;
  }
  if (!status.enabled) {
    console.log(`Email chưa cấu hình (${notConfiguredDetail(status)}) — "Quên mật khẩu" hiển thị trạng thái chưa sẵn sàng.`);
    return;
  }
  const api = API_TRANSPORTS[status.mode];
  if (api) {
    // Không gọi API lúc khởi động (khóa chỉ gửi thư có thể không có quyền đọc gì khác): khóa sai chỉ lộ ra khi gửi thư đầu tiên, log ghi mã lỗi
    console.log(`Gửi email qua API HTTPS của ${api.label}, người gửi ${parseSender(env('EMAIL_FROM')).email}. Khóa API được kiểm ở lần gửi thư đầu tiên.`);
    return;
  }
  try {
    await smtpTransporter().verify();
    console.log(`SMTP sẵn sàng: ${env('SMTP_HOST')}`);
  } catch (err) {
    console.error(
      `Không kết nối được SMTP ${env('SMTP_HOST')}: ${err.message} — email đặt lại mật khẩu sẽ gửi thất bại. Nơi chặn cổng SMTP (vd. Railway gói Free/Trial/Hobby) thì dùng EMAIL_TRANSPORT=brevo hoặc resend.`
    );
  }
}
