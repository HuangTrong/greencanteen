import net from 'node:net';

/**
 * Máy chủ SMTP giả chạy trên 127.0.0.1 (cổng ngẫu nhiên): nhận thư và giữ trong bộ nhớ để test đọc lại.
 * Không có STARTTLS → dùng để kiểm tra cả việc client từ chối gửi qua kênh không mã hóa.
 *   greeting: dòng chào tùy chọn (vd. '554 dịch vụ không sẵn sàng' để giả lập máy chủ từ chối)
 *   fake.rejectRecipients = true → trả 550 cho RCPT TO (giả lập gửi thư thất bại giữa chừng)
 */
export async function startFakeSmtp({ greeting = '220 fake-smtp ESMTP' } = {}) {
  const messages = [];
  const fake = { rejectRecipients: false };
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    const send = (line) => socket.write(`${line}\r\n`);
    send(greeting);
    if (!greeting.startsWith('220')) {
      socket.end();
      return;
    }
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [], raw: '' };
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ ...current, text: decodeMessage(current.raw) });
            current = { from: '', to: [], raw: '' };
            send('250 OK queued');
          } else {
            current.raw += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO') socket.write('250-fake-smtp\r\n250 8BITMIME\r\n');
        else if (command === 'HELO' || command === 'RSET' || command === 'NOOP') send('250 OK');
        else if (command === 'MAIL') {
          current.from = line;
          send('250 OK');
        } else if (command === 'RCPT') {
          if (fake.rejectRecipients) {
            send('550 Mailbox unavailable');
            continue;
          }
          current.to.push(line);
          send('250 OK');
        } else if (command === 'DATA') {
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (command === 'QUIT') {
          send('221 Bye');
          socket.end();
        } else send('502 Command not implemented');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(fake, {
    port: server.address().port,
    messages,
    close: () => new Promise((resolve) => server.close(resolve)),
  });
}

/** Giải mã quoted-printable / base64 của các phần thư để test tìm được liên kết và nội dung tiếng Việt */
function decodeMessage(raw) {
  const parts = raw.split(/\n(?=--)/);
  return parts
    .map((part) => {
      const [headers, ...bodyLines] = part.split('\n\n');
      const body = bodyLines.join('\n\n');
      if (/content-transfer-encoding:\s*base64/i.test(headers)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
        const bytes = [];
        const text = body.replace(/=\n/g, '');
        for (let i = 0; i < text.length; i += 1) {
          if (text[i] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) {
            bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(...Buffer.from(text[i], 'utf8'));
        }
        return Buffer.from(bytes).toString('utf8');
      }
      return part;
    })
    .join('\n');
}
