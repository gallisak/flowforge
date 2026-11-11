const http = require('http');

const PORT = Number(process.env.PORT ?? 8080);
const HOLD_FIRST_CHARGE_MS = Number(process.env.HOLD_FIRST_CHARGE_MS ?? 6000);

let state;

function reset() {
  state = { requests: [], seenKeys: new Set(), inFlight: 0, notifications: [] };
}

function answer(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function stats() {
  return { requests: state.requests, inFlight: state.inFlight, notifications: state.notifications };
}

function receiveEffect(req, res, path) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) return answer(res, 400, { error: 'Idempotency-Key is required' });
  const effectKey = `${path} ${key}`;
  const first = !state.seenKeys.has(effectKey);
  if (first) state.seenKeys.add(effectKey);
  state.requests.push({ path, key, applied: first });
  const reply = () => answer(res, 200, { applied: first, key });
  if (!(first && path === '/charge')) return reply();
  state.inFlight += 1;
  const timer = setTimeout(() => {
    state.inFlight -= 1;
    reply();
  }, HOLD_FIRST_CHARGE_MS);
  res.on('close', () => {
    if (!res.writableEnded) {
      clearTimeout(timer);
      state.inFlight -= 1;
    }
  });
}

reset();

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url, 'http://sink').pathname;
      if (req.method === 'GET' && path === '/stats') return answer(res, 200, stats());
      if (req.method === 'POST' && path === '/reset') {
        reset();
        return answer(res, 200, { reset: true });
      }
      if (req.method === 'POST' && path === '/notify') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        state.notifications.push({ webhookId: req.headers['webhook-id'], executionId: body.data?.executionId, status: body.data?.status });
        return answer(res, 200, { received: true });
      }
      if (req.method === 'POST' && ['/reserve', '/charge', '/email'].includes(path)) return receiveEffect(req, res, path);
      return answer(res, 404, { error: 'not found' });
    });
  })
  .listen(PORT, () => process.stdout.write(`sink listening on ${PORT}\n`));
