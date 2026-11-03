import http from 'node:http';

/**
 * Ollama giả trên 127.0.0.1 (cổng ngẫu nhiên) cho integration test: trả về phân loại cấu hình được, ghi lại request.
 *   fake.reply = { category, confidence, reason } | { status, error, headers } | (body) => ({ status, json })
 *   fake.delayMs = trì hoãn phản hồi (thử thời gian chờ)
 *   fake.gate = n → giữ phản hồi tới khi có đủ n request đang chờ (tái hiện race ổn định)
 */
export async function startFakeOllama({ models = ['qwen3-vl:4b-instruct'] } = {}) {
  const requests = [];
  const waiting = [];
  const fake = { reply: { category: 'reusable_bottle', confidence: 0.95, reason: 'Bình giữ nhiệt inox' }, delayMs: 0, gate: 0, requests };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const send = (status, json, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'GET' && req.url === '/api/tags') return send(200, { models: models.map((name) => ({ name })) });
      if (req.method !== 'POST' || req.url !== '/api/chat') return send(404, { error: 'not found' });
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      if (fake.gate > 0) {
        await new Promise((release) => {
          waiting.push(release);
          if (waiting.length >= fake.gate) waiting.splice(0).forEach((r) => r());
        });
      }
      if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
      const reply = typeof fake.reply === 'function' ? fake.reply(body) : fake.reply;
      if (reply.status) return send(reply.status, reply.json ?? { error: reply.error }, reply.headers);
      send(200, { model: body.model, message: { role: 'assistant', content: JSON.stringify(reply) }, done: true });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(fake, {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  });
}
