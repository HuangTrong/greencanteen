import net from 'node:net';

/**
 * Máy chủ clamd giả trên 127.0.0.1, nói đúng giao thức INSTREAM nhưng không phải động cơ quét thật: "mã độc" là một chuỗi đánh dấu vô hại do test tự
 * đặt. Không dùng chuỗi EICAR vì phần mềm diệt virus trên máy phát triển sẽ cách ly chính tệp test này.
 * fake.mode: 'ok' | 'silent' (không trả lời) | 'garbage' | 'size-limit'
 */
export const MALWARE_MARKER = Buffer.from('GC-TEST-MALWARE-MARKER-KHONG-PHAI-MA-DOC');

export async function startFakeClamd() {
  const fake = { mode: 'ok', scans: [], pings: 0 };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let streaming = false;
    const chunks = [];
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!streaming) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        const command = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
        if (command === 'zPING') {
          fake.pings += 1;
          socket.end('PONG\0');
          return;
        }
        if (command !== 'zINSTREAM') {
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
        streaming = true;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          const file = Buffer.concat(chunks);
          fake.scans.push({ file, chunks: chunks.length, largestChunk: Math.max(0, ...chunks.map((chunk) => chunk.length)) });
          if (fake.mode === 'silent') return;
          if (fake.mode === 'garbage') socket.end('xin chào\0');
          else if (fake.mode === 'size-limit') socket.end('INSTREAM size limit exceeded. ERROR\0');
          else socket.end(file.includes(MALWARE_MARKER) ? 'stream: Gc.Test.Marker-1 FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buffer.length < 4 + length) return;
        chunks.push(Buffer.from(buffer.subarray(4, 4 + length)));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(fake, {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  });
}
