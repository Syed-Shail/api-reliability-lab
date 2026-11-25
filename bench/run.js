// Benchmark client resilience strategies against injected upstream faults.
//
//   node bench/run.js [--seconds 8] [--rps 80] [--out bench/results.json]
//
// Load is open-loop: requests start at a fixed rate whether or not earlier ones finished,
// like real user traffic. Every scenario/strategy pair gets a fresh upstream with the same
// seed, so the injected faults are identical across strategies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUpstream, seededRandom } from '../src/upstream.js';
import { createClient, RetryBudget, CircuitBreaker } from '../src/client.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(opt('seconds', 8));
const RPS = Number(opt('rps', 80));
const OUT = opt('out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'results.json'));

const SCENARIOS = {
  transient_errors: { description: '20% of requests fail with 503', errorRate: 0.2 },
  latency_spikes: { description: '5% of requests take 2 extra seconds', slowRate: 0.05, slowMs: 2000 },
  outage: {
    description: 'upstream fully down for the middle 40% of the run, 2% errors otherwise',
    errorRate: 0.02, outage: { startMs: SECONDS * 300, endMs: SECONDS * 700 },
  },
};

const STRATEGIES = {
  no_protection: () => createClient(),
  timeout_only: () => createClient({ timeoutMs: 250 }),
  naive_retries: () => createClient({ timeoutMs: 250, retries: 3 }),
  backoff_jitter: () => createClient({ timeoutMs: 250, retries: 3, backoff: { baseMs: 50, capMs: 800 }, random: seededRandom(7) }),
  full_resilience: () => createClient({
    timeoutMs: 250, retries: 3, backoff: { baseMs: 50, capMs: 800 }, random: seededRandom(7),
    budget: new RetryBudget({ ratio: 0.2 }),
    breaker: new CircuitBreaker({ windowSize: 20, failureThreshold: 0.5, minCalls: 10, openMs: 1000, halfOpenProbes: 3 }),
  }),
};

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
};

async function run(scenario, makeClient) {
  const upstream = await startUpstream({ ...scenario, seed: 42 });
  const request = makeClient();
  const pending = [];
  const total = SECONDS * RPS;
  const started = performance.now();
  for (let i = 0; i < total; i++) {
    const due = started + (i * 1000) / RPS;
    const wait = due - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    pending.push(request(upstream.url));
  }
  const results = await Promise.all(pending);
  await upstream.close();
  const latencies = results.map(r => r.ms);
  const ok = results.filter(r => r.ok).length;
  return {
    requests: results.length,
    success_rate: +(ok / results.length).toFixed(4),
    p50_ms: +percentile(latencies, 50).toFixed(1),
    p99_ms: +percentile(latencies, 99).toFixed(1),
    max_ms: +Math.max(...latencies).toFixed(1),
    upstream_calls_per_request: +(upstream.stats.received / results.length).toFixed(2),
    fast_failures_from_open_circuit: results.filter(r => r.error === 'circuit open').length,
  };
}

const report = { node: process.version, seconds_per_run: SECONDS, requests_per_second: RPS, scenarios: {} };
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  report.scenarios[name] = { description: scenario.description, strategies: {} };
  for (const [strategy, make] of Object.entries(STRATEGIES)) {
    const result = await run(scenario, make);
    report.scenarios[name].strategies[strategy] = result;
    console.log(name.padEnd(17), strategy.padEnd(16), JSON.stringify(result));
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`Saved ${path.relative(process.cwd(), OUT)}`);
