import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, RetryBudget, CircuitBreaker, createClient } from '../src/client.js';
import { startUpstream, seededRandom } from '../src/upstream.js';

test('full-jitter backoff stays within the capped exponential ceiling', () => {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const ceiling = Math.min(1000, 50 * 2 ** (attempt - 1));
    assert.equal(backoffDelay(attempt, { random: () => 0.999999 }) <= ceiling, true);
    assert.equal(backoffDelay(attempt, { random: () => 0 }), 0);
  }
});

test('retry budget limits retries to the configured share of traffic', () => {
  const budget = new RetryBudget({ ratio: 0.1, minTokens: 0 });
  let retries = 0;
  for (let i = 0; i < 100; i++) {
    budget.deposit();
    if (budget.tryWithdraw()) retries++;
  }
  assert.ok(retries <= 10);
});

test('circuit breaker opens on failures, rejects while open, then recovers through half-open', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ windowSize: 10, minCalls: 5, failureThreshold: 0.5, openMs: 1000, halfOpenProbes: 2, now: () => now });
  for (let i = 0; i < 5; i++) breaker.record(false);
  assert.equal(breaker.state, 'open');
  assert.equal(breaker.allow(), false);
  now = 1500;
  assert.equal(breaker.allow(), true);
  assert.equal(breaker.state, 'half-open');
  breaker.record(true);
  assert.equal(breaker.allow(), true);
  breaker.record(true);
  assert.equal(breaker.state, 'closed');
});

test('a failed probe sends the breaker straight back to open', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ minCalls: 2, windowSize: 2, openMs: 100, now: () => now });
  breaker.record(false); breaker.record(false);
  now = 200;
  assert.equal(breaker.allow(), true);
  breaker.record(false);
  assert.equal(breaker.state, 'open');
});

test('the client retries 503s until success and makes a single attempt when retries are off', async () => {
  const flaky = await startUpstream({ errorRate: 0.5, seed: 3 });
  const client = createClient({ retries: 5, timeoutMs: 500 });
  const results = await Promise.all(Array.from({ length: 20 }, () => client(flaky.url)));
  await flaky.close();
  assert.ok(results.every(r => r.ok), 'all requests should succeed after retries');
  assert.ok(results.some(r => r.attempts > 1));

  const notFound = { url: 'http://127.0.0.1:9/' }; // closed port: connection refused
  const single = await createClient({ retries: 0, timeoutMs: 200 })(notFound.url);
  assert.equal(single.ok, false);
  assert.equal(single.attempts, 1);
});

test('timeouts cut off slow responses', async () => {
  const slow = await startUpstream({ slowRate: 1, slowMs: 1000 });
  const result = await createClient({ timeoutMs: 100 })(slow.url);
  await slow.close();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.ok(result.ms < 400);
});

test('the fault generator is deterministic for a given seed', () => {
  const a = seededRandom(42), b = seededRandom(42);
  assert.deepEqual(Array.from({ length: 5 }, a), Array.from({ length: 5 }, b));
});
