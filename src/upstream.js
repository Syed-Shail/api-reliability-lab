// A fault-injecting HTTP server that stands in for an unreliable upstream API.
//
// Faults are driven by a seeded random generator so every benchmark run is repeatable:
//   errorRate      share of requests answered with HTTP 503
//   slowRate       share of requests delayed by slowMs (a latency spike)
//   outage         { startMs, endMs } window, relative to server start, where every request fails
//   baseLatencyMs  normal service time (+ up to jitterMs)
//
// The server counts every request it receives, so the benchmark can report how much extra
// load each client strategy puts on the upstream (retry amplification).
import http from 'node:http';

export function seededRandom(seed) {
  // mulberry32: small, fast, deterministic
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function startUpstream({
  errorRate = 0, slowRate = 0, slowMs = 1000, baseLatencyMs = 5, jitterMs = 5, outage = null, seed = 1,
} = {}) {
  const random = seededRandom(seed);
  const stats = { received: 0, failed: 0, slow: 0 };
  const started = Date.now();
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    stats.received++;
    const now = Date.now() - started;
    const inOutage = outage && now >= outage.startMs && now < outage.endMs;
    const fail = inOutage || random() < errorRate;
    const slow = !fail && random() < slowRate;
    const delay = baseLatencyMs + random() * jitterMs + (slow ? slowMs : 0);
    if (slow) stats.slow++;
    setTimeout(() => {
      if (res.destroyed) return;
      if (fail) {
        stats.failed++;
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }
    }, delay);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    stats,
    close: () => new Promise(resolve => {
      sockets.forEach(socket => socket.destroy());
      server.close(resolve);
    }),
  };
}
