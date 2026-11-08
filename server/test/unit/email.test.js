// Gửi email đặt lại mật khẩu: bảng quyết định cấu hình + nhà cung cấp SMTP giả (không có TLS)
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EmailNotConfiguredError, emailStatus, mailFailureCode, sendEmail, verifyEmailTransport } from '../../src/services/email.js';
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
    // Gửi qua API HTTPS (Railway gói Free/Trial/Hobby chặn SMTP): cần khóa của đúng nhà cung cấp và EMAIL_FROM đúng dạng
    [{ EMAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'k', ...from }, { enabled: true, mode: 'brevo' }],
    [{ EMAIL_TRANSPORT: 'Resend', RESEND_API_KEY: 'k', ...from }, { enabled: true, mode: 'resend' }],
    [{ EMAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'k', ...from, NODE_ENV: 'production' }, { enabled: true, mode: 'brevo' }],
    [{ EMAIL_TRANSPORT: 'brevo', ...from }, { enabled: false, mode: 'brevo', reason: 'not_configured' }],
    [{ EMAIL_TRANSPORT: 'brevo', RESEND_API_KEY: 'k', ...from }, { enabled: false, mode: 'brevo', reason: 'not_configured' }],
    [{ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' }, { enabled: false, mode: 'resend', reason: 'not_configured' }],
    [{ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'GreenCanteen' }, { enabled: false, mode: 'resend', reason: 'not_configured' }],
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

describe('gửi qua API HTTPS (brevo, resend)', () => {
  const FROM = 'GreenCanteen <no-reply@example.edu.vn>';
  const MAIL = { to: 'sv01@example.edu.vn', subject: 'Đặt lại mật khẩu', text: 'Mã: 123456', html: '<p>Mã: <b>123456</b></p>' };
  let calls;
  let reply;
  // fetch giả cho nhà cung cấp; module gọi fetch lúc gửi nên thay globalThis.fetch là đủ (như test OAuth)
  const originalFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return reply();
    };
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });
  const respond = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const reset = (response) => {
    calls = [];
    reply = response;
  };

  test('Brevo: đúng endpoint, header api-key, sender là object, to là mảng object, có cả HTML và văn bản', async () => {
    reset(respond(201, { messageId: '<1@relay>' }));
    setEnv({ EMAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'xkeysib-thu', EMAIL_FROM: FROM });
    assert.deepEqual(await sendEmail(MAIL), { mode: 'brevo' });
    assert.equal(calls.length, 1);
    const [{ url, init, body }] = calls;
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['api-key'], 'xkeysib-thu');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.redirect, 'error', 'không đi theo chuyển hướng: khóa API không bị gửi sang máy khác');
    assert.deepEqual(body, {
      sender: { email: 'no-reply@example.edu.vn', name: 'GreenCanteen' },
      to: [{ email: MAIL.to }],
      subject: MAIL.subject,
      htmlContent: MAIL.html,
      textContent: MAIL.text,
    });
  });

  test('Brevo bắt buộc htmlContent: thư chỉ có văn bản được chuyển sang HTML đã thoát ký tự', async () => {
    reset(respond(201, {}));
    setEnv({ EMAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'k', EMAIL_FROM: FROM });
    await sendEmail({ to: MAIL.to, subject: 's', text: 'Dòng 1 <b>\nDòng 2' });
    assert.equal(calls[0].body.htmlContent, '<p>Dòng 1 &lt;b&gt;<br>Dòng 2</p>');
  });

  test('Resend: đúng endpoint, Authorization Bearer, from là chuỗi "Tên <email>", to là mảng chuỗi', async () => {
    reset(respond(200, { id: 'abc' }));
    setEnv({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_thu', EMAIL_FROM: FROM });
    assert.deepEqual(await sendEmail(MAIL), { mode: 'resend' });
    const [{ url, init, body }] = calls;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.headers.Authorization, 'Bearer re_thu');
    assert.equal(init.headers['api-key'], undefined);
    assert.deepEqual(body, { from: FROM, to: [MAIL.to], subject: MAIL.subject, text: MAIL.text, html: MAIL.html });
  });

  test('lỗi của nhà cung cấp: chỉ giữ mã ngắn, bỏ message (có thể chứa địa chỉ người nhận) và mã có dạng địa chỉ', async () => {
    setEnv({ EMAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'xkeysib-bi-mat', EMAIL_FROM: FROM });
    for (const [response, expected] of [
      [respond(401, { code: 'unauthorized', message: `Key not found for ${MAIL.to}` }), 'EMAIL_API_401_unauthorized'],
      [respond(402, { code: 'Insufficient credits', message: 'x' }), 'EMAIL_API_402_insufficient_credits'],
      [respond(400, { code: MAIL.to, message: MAIL.to }), 'EMAIL_API_400'],
      [() => new Response('<html>Bad gateway</html>', { status: 502 }), 'EMAIL_API_502'],
    ]) {
      reset(response);
      const err = await sendEmail(MAIL).then(
        () => assert.fail('phải báo lỗi'),
        (e) => e
      );
      assert.equal(mailFailureCode(err), expected);
      assert.ok(!`${err.message} ${err.code}`.includes(MAIL.to) && !`${err.message} ${err.code}`.includes('xkeysib'), err.message);
    }
    setEnv({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: FROM });
    reset(respond(403, { statusCode: 403, name: 'validation_error', message: `You can only send testing emails to your own email address (${MAIL.to})` }));
    assert.equal(mailFailureCode(await sendEmail(MAIL).catch((e) => e)), 'EMAIL_API_403_validation_error');
  });

  test('không kết nối được hoặc quá giờ → mã riêng, không treo', async () => {
    setEnv({ EMAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'k', EMAIL_FROM: FROM });
    reset(() => {
      throw new TypeError('fetch failed');
    });
    assert.equal(mailFailureCode(await sendEmail(MAIL).catch((e) => e)), 'EMAIL_API_UNREACHABLE');
    reset(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    assert.equal(mailFailureCode(await sendEmail(MAIL).catch((e) => e)), 'EMAIL_API_TIMEOUT');
    assert.ok(calls.every(({ init }) => init.signal instanceof AbortSignal), 'mỗi lần gửi có giới hạn thời gian');
  });

  test('khởi động: chỉ ghi log, không gọi API, không in khóa', async () => {
    reset(() => assert.fail('không được gọi API lúc khởi động'));
    for (const [vars, pattern] of [
      [{ EMAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'xkeysib-bi-mat', EMAIL_FROM: FROM }, /^log: Gửi email qua API HTTPS của Brevo, người gửi no-reply@example\.edu\.vn\./],
      [{ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_bi_mat', EMAIL_FROM: FROM }, /^log: Gửi email qua API HTTPS của Resend/],
      [{ EMAIL_TRANSPORT: 'brevo', EMAIL_FROM: FROM }, /^log: Email chưa cấu hình \(thiếu BREVO_API_KEY, hoặc EMAIL_FROM không đúng dạng/],
      [{ EMAIL_TRANSPORT: 'mailgun' }, /^log: Email chưa cấu hình \(EMAIL_TRANSPORT=mailgun không hợp lệ, chỉ nhận smtp, brevo, resend, console\)/],
    ]) {
      setEnv(vars);
      const capture = captureConsole();
      try {
        await verifyEmailTransport();
      } finally {
        capture.restore();
      }
      assert.ok(capture.lines.some((l) => pattern.test(l)), capture.lines.join('\n'));
      assert.ok(capture.lines.every((l) => !l.includes('bi-mat') && !l.includes('bi_mat')), capture.lines.join('\n'));
    }
    assert.equal(calls.length, 0);
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
