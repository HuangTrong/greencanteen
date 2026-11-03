// Gửi email đặt lại mật khẩu: bảng quyết định cấu hình + nhà cung cấp SMTP giả (không có TLS)
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EmailNotConfiguredError, emailStatus, sendEmail, verifyEmailTransport } from '../../src/services/email.js';
import { setEnv } from '../helpers.js';
import { startFakeSmtp } from '../fakes/smtp.js';

function captureConsole() {
  const lines = [];
  const originals = ['log', 'warn', 'error'].map((m) => [m, console[m]]);
  for (const [m] of originals) console[m] = (...args) => lines.push(`${m}: ${args.join(' ')}`);
  return { lines, restore: () => originals.forEach(([m, fn]) => (console[m] = fn)) };
}

let smtp;
before(async () => {
  smtp = await startFakeSmtp();
});
after(() => smtp.close());
afterEach(() => setEnv());

describe('emailStatus — bảng quyết định', () => {
  const host = { SMTP_HOST: '127.0.0.1' };
  const from = { EMAIL_FROM: 'GreenCanteen <no-reply@example.edu.vn>' };
  for (const [vars, expected] of [
    [{}, { enabled: false, mode: 'smtp', reason: 'not_configured' }],
    [{ EMAIL_TRANSPORT: 'smtp', ...host }, { enabled: false, mode: 'smtp', reason: 'not_configured' }],
    [{ EMAIL_TRANSPORT: 'smtp', ...from }, { enabled: false, mode: 'smtp', reason: 'not_configured' }],
    [{ EMAIL_TRANSPORT: 'smtp', ...host, ...from }, { enabled: true, mode: 'smtp' }],
    [{ EMAIL_TRANSPORT: 'SMTP', ...host, ...from }, { enabled: true, mode: 'smtp' }],
    [{ EMAIL_TRANSPORT: 'console' }, { enabled: true, mode: 'console' }],
    [{ EMAIL_TRANSPORT: 'console', NODE_ENV: 'production' }, { enabled: false, mode: 'console', reason: 'console_blocked_in_production' }],
    [{ EMAIL_TRANSPORT: 'sendgrid', ...host, ...from }, { enabled: false, mode: 'sendgrid', reason: 'unknown_transport' }],
  ]) {
    test(JSON.stringify(vars), () => {
      setEnv(vars);
      assert.deepEqual(emailStatus(), expected);
    });
  }
});

describe('sendEmail', () => {
  test('chưa cấu hình → ném EmailNotConfiguredError, không bao giờ báo đã gửi', async () => {
    await assert.rejects(sendEmail({ to: 'a@b.vn', subject: 's', text: 't' }), EmailNotConfiguredError);
  });

  test('console (chỉ phát triển) in thư ra log, ghi rõ không gửi thật', async () => {
    setEnv({ EMAIL_TRANSPORT: 'console' });
    const capture = captureConsole();
    try {
      assert.deepEqual(await sendEmail({ to: 'a@b.vn', subject: 'Tiêu đề', text: 'Nội dung' }), { mode: 'console' });
    } finally {
      capture.restore();
    }
    assert.match(capture.lines.join('\n'), /KHÔNG gửi thật[\s\S]*Tới: a@b\.vn[\s\S]*Nội dung/);
  });

  test('SMTP không hỗ trợ STARTTLS → từ chối gửi qua kênh không mã hóa (requireTLS)', async () => {
    setEnv({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), EMAIL_FROM: 'no-reply@example.edu.vn' });
    await assert.rejects(sendEmail({ to: 'a@b.vn', subject: 's', text: 't' }), /STARTTLS/i);
    assert.equal(smtp.messages.length, 0);
  });
});

describe('verifyEmailTransport — kiểm tra lúc khởi động chỉ ghi log', () => {
  for (const [label, vars, pattern] of [
    ['console', { EMAIL_TRANSPORT: 'console' }, /^warn: EMAIL_TRANSPORT=console/],
    ['chưa cấu hình', {}, /^log: Email chưa cấu hình \(thiếu SMTP_HOST \/ EMAIL_FROM\)/],
    ['console trong production', { EMAIL_TRANSPORT: 'console', NODE_ENV: 'production' }, /^log: Email chưa cấu hình \(EMAIL_TRANSPORT=console bị chặn/],
    [
      'SMTP không nâng cấp được TLS → ghi lỗi, server vẫn chạy',
      { EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', EMAIL_FROM: 'x@example.edu.vn' },
      /^error: Không kết nối được SMTP 127\.0\.0\.1: .*STARTTLS/,
    ],
  ]) {
    test(label, async () => {
      setEnv({ ...vars, ...(vars.SMTP_HOST && { SMTP_PORT: String(smtp.port) }) });
      const capture = captureConsole();
      try {
        await verifyEmailTransport();
      } finally {
        capture.restore();
      }
      assert.ok(capture.lines.some((l) => pattern.test(l)), capture.lines.join('\n'));
    });
  }
});
