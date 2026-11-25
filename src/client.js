// A resilient HTTP client: per-attempt timeouts, retries with capped exponential backoff and
// full jitter, a retry budget, and a circuit breaker. Each feature can be switched on or off,
// so the benchmark can measure what each one contributes.

/** Delay before retry `attempt` (1-based): "full jitter" from the AWS Architecture Blog. */
export function backoffDelay(attempt, { baseMs = 50, capMs = 1000, random = Math.random } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return random() * ceiling;
}

/**
 * Token-bucket retry budget: every request deposits `ratio` tokens and every retry spends one,
 * so retries can never exceed `ratio` of normal traffic, however bad the upstream gets.
 */
export class RetryBudget {
  constructor({ ratio = 0.2, minTokens = 10, maxTokens = 100 } = {}) {
    Object.assign(this, { ratio, maxTokens, tokens: minTokens });
  }
  deposit() { this.tokens = Math.min(this.maxTokens, this.tokens + this.ratio); }
  tryWithdraw() {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Circuit breaker with closed, open and half-open states. It opens when the failure rate over
 * the last `windowSize` calls reaches `failureThreshold`, rejects calls instantly for
 * `openMs`, then lets `halfOpenProbes` trial calls through to test recovery.
 */
export class CircuitBreaker {
  constructor({ windowSize = 20, failureThreshold = 0.5, minCalls = 10, openMs = 2000, halfOpenProbes = 3, now = Date.now } = {}) {
    Object.assign(this, { windowSize, failureThreshold, minCalls, openMs, halfOpenProbes, now });
    this.state = 'closed';
    this.results = [];
    this.openedAt = 0;
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
    this.transitions = [];
  }

  allow() {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.openMs) return false;
      this.move('half-open');
    }
    if (this.state === 'half-open') {
      if (this.probesInFlight >= this.halfOpenProbes) return false;
      this.probesInFlight++;
    }
    return true;
  }

  record(success) {
    if (this.state === 'half-open') {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      if (!success) return this.trip();
      if (++this.probeSuccesses >= this.halfOpenProbes) this.move('closed');
      return;
    }
    this.results.push(success);
    if (this.results.length > this.windowSize) this.results.shift();
    const failures = this.results.filter(ok => !ok).length;
    if (this.results.length >= this.minCalls && failures / this.results.length >= this.failureThreshold) this.trip();
  }

  trip() {
    this.openedAt = this.now();
    this.move('open');
  }

  move(state) {
    this.state = state;
    this.transitions.push({ state, at: this.now() });
    if (state === 'closed') this.results = [];
    if (state !== 'half-open') {
      this.probesInFlight = 0;
      this.probeSuccesses = 0;
    }
  }
}

export class CircuitOpenError extends Error {
  constructor() {
    super('circuit open');
    this.name = 'CircuitOpenError';
  }
}

/**
 * Build a request function with the given resilience settings.
 * Returns { ok, status, attempts, ms, error? } and never throws, so callers can always measure.
 */
export function createClient({
  timeoutMs = null,
  retries = 0,
  backoff = null,      // { baseMs, capMs } enables jittered backoff between retries
  budget = null,       // RetryBudget instance
  breaker = null,      // CircuitBreaker instance
  random = Math.random,
} = {}) {
  const retryable = status => status === 429 || status >= 500;

  async function attemptOnce(url) {
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, { signal: controller?.signal });
      await response.arrayBuffer();
      return { status: response.status };
    } catch (error) {
      return { status: 0, error: error.name === 'AbortError' ? 'timeout' : error.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return async function request(url) {
    const started = performance.now();
    budget?.deposit();
    let attempts = 0;
    let last = { status: 0, error: 'not attempted' };
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        if (budget && !budget.tryWithdraw()) break;
        if (backoff) await new Promise(r => setTimeout(r, backoffDelay(attempt, { ...backoff, random })));
      }
      if (breaker && !breaker.allow()) {
        last = { status: 0, error: new CircuitOpenError().message };
        break;
      }
      attempts++;
      last = await attemptOnce(url);
      const ok = last.status >= 200 && last.status < 300;
      breaker?.record(ok);
      if (ok || (last.status && !retryable(last.status))) break;
    }
    return { ok: last.status >= 200 && last.status < 300, status: last.status, attempts, ms: performance.now() - started, error: last.error };
  };
}
