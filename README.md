# API Reliability Lab

How much do timeouts, retries, jittered backoff, retry budgets and circuit breakers actually help when an API misbehaves, and what do they cost? This project measures it. A fault-injecting HTTP server reproduces three common failures, and an open-loop load generator replays the same traffic through five client strategies.

Pure Node.js (20+), no dependencies.

## Results

640 requests per run (80 requests/s for 8 s, open-loop), identical seeded faults for every strategy. Raw output: [`bench/results.json`](bench/results.json).

**1. Transient errors: 20% of requests fail with 503**

| Strategy | Success | p50 | p99 | Upstream calls per request |
|---|---|---|---|---|
| No protection | 79.7% | 8.6 ms | 11.5 ms | 1.00 |
| Retries (3) | **100%** | 8.9 ms | 28.1 ms | 1.26 |
| Retries + jittered backoff | **100%** | 8.6 ms | 150.1 ms | 1.26 |
| Full (backoff + 20% retry budget + circuit breaker) | 90.3% | 8.4 ms | 134.9 ms | 1.15 |

Retries turn a 1-in-5 failure rate into zero failures for 26% extra upstream traffic. The full strategy trades some of that success for a hard cap on retry traffic. With a 20% budget and a 20% error rate, the budget is exactly at its limit.

**2. Latency spikes: 5% of requests take 2 extra seconds**

| Strategy | Success | p50 | p99 | Max |
|---|---|---|---|---|
| No protection | 100% | 8.3 ms | **2,009 ms** | 2,011 ms |
| 250 ms timeout | 96.4% | 8.4 ms | 251 ms | 254 ms |
| Timeout + retries | **100%** | 8.3 ms | **260 ms** | 511 ms |

A timeout alone cuts p99 latency by 87% but fails the slow requests. Adding retries recovers all of them, because a retried request usually lands on a fast response.

**3. Outage: the upstream is fully down for the middle 40% of the run**

| Strategy | Success | p50 | p99 | Upstream calls per request |
|---|---|---|---|---|
| No protection | 59.2% | 8.3 ms | 10.7 ms | 1.00 |
| Retries (3) | 60.2% | 10.4 ms | 37.2 ms | **2.21** |
| Retries + jittered backoff | 62.2% | 10.2 ms | 330.2 ms | 2.20 |
| Full (budget + circuit breaker) | 48.4% | **0.2 ms** | 44.1 ms | **0.51** |

During an outage retries barely raise success but **more than double the load** on a service that is already failing. That is the retry storm that keeps real outages going. The circuit breaker cuts upstream traffic by 77% and answers in 0.2 ms instead of making users wait. The cost is a lower success rate just after recovery, while the circuit is still open. That is the trade-off to tune `openMs` and the half-open probes against.

### Takeaways

- Retries are the biggest single win for transient errors, and timeouts for latency spikes. Use both.
- Retries without a budget or breaker are dangerous in outages: 2.2× load at the worst moment.
- Jitter widens the latency tail of a single client (backoff adds waiting) but spreads retries out, so many clients do not hit a recovering server in sync.
- A breaker's success rate looks worse in a short benchmark. What it buys is protection for the upstream and instant failures users can act on.

## How it works

- [`src/upstream.js`](src/upstream.js): an HTTP server with seeded fault injection (error rate, latency spikes, outage windows) that counts every request it receives.
- [`src/client.js`](src/client.js): `createClient()` with per-attempt timeouts (`AbortController`), retries on 429/5xx and transport errors, capped exponential backoff with full jitter, a token-bucket `RetryBudget`, and a `CircuitBreaker` with closed, open and half-open states and a sliding failure window. Each feature can be switched on separately.
- [`bench/run.js`](bench/run.js): open-loop load. Requests start on schedule whether or not earlier ones have finished, as real traffic does; closed-loop testing hides tail latency. Every scenario and strategy pair runs against a fresh upstream with the same seed.

## Run it

```bash
npm test                                  # 7 tests: backoff bounds, budget cap, breaker state machine, retries, timeouts
npm run bench                             # full benchmark, writes bench/results.json
node bench/run.js --seconds 4 --rps 40    # quicker run
```

## Limitations

- The simulated upstream does not slow down under extra load, so the benefit of shedding retry traffic shows up as "calls per request", not as faster recovery.
- Results come from one machine over loopback; absolute latencies are lower than over a real network, but the comparisons between strategies hold.
