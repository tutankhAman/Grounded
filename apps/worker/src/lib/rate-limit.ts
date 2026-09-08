const DEFAULT_RPM = 60;
const RETRY_AFTER_REGEX = /retry in ([0-9.]+)s/i;

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private tokens: number;
  private lastRefill: number;
  private readonly refillRatePerMs: number;
  private pausedUntil = 0;
  private consecutive429s = 0;

  constructor(rpm: number = Number(process.env.LLM_RPM_BUDGET) || DEFAULT_RPM) {
    this.capacity = rpm;
    this.tokens = rpm;
    this.refillRatePerMs = rpm / 60_000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsed * this.refillRatePerMs
      );
      this.lastRefill = now;
    }
  }

  /**
   * Pause the bucket globally for a specified duration in milliseconds.
   */
  pause(durationMs: number): void {
    const target = Date.now() + durationMs;
    if (target > this.pausedUntil) {
      this.pausedUntil = target;
    }
  }

  /**
   * Handles a 429 response by pausing the bucket globally with exponential backoff and jitter.
   */
  handle429(retryAfterHeader?: string | null, errorBody?: string): number {
    this.consecutive429s++;

    let backoffSeconds = 2 ** Math.min(this.consecutive429s, 6);
    if (retryAfterHeader) {
      const parsedSeconds = Number.parseFloat(retryAfterHeader);
      if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
        backoffSeconds = parsedSeconds;
      }
    } else if (errorBody) {
      const match = errorBody.match(RETRY_AFTER_REGEX);
      if (match) {
        const parsed = Number.parseFloat(match[1]);
        if (Number.isFinite(parsed)) {
          backoffSeconds = parsed;
        }
      }
    }

    // Add jitter: 0-1000ms
    const jitterMs = Math.floor(Math.random() * 1000);
    const pauseDurationMs = Math.min(backoffSeconds * 1000 + jitterMs, 60_000);

    this.pause(pauseDurationMs);
    return pauseDurationMs;
  }

  /**
   * Resets the 429 counter on a successful call.
   */
  recordSuccess(): void {
    if (this.consecutive429s > 0) {
      this.consecutive429s = Math.max(0, this.consecutive429s - 1);
    }
  }

  /**
   * Acquires tokens, waiting asynchronously if the bucket is empty or paused.
   */
  async acquire(cost = 1): Promise<void> {
    let acquired = false;
    while (!acquired) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        const waitMs = this.pausedUntil - now;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        acquired = true;
        break;
      }

      const needed = cost - this.tokens;
      const waitMs = Math.max(25, Math.ceil(needed / this.refillRatePerMs));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }
}

/**
 * Process-global singleton rate limiter instance.
 */
export const rateLimiter = new TokenBucketRateLimiter();

/**
 * Shared keep-alive fetch client wrapping the process-global rate limiter.
 */
export const rateLimitedFetch: typeof globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  await rateLimiter.acquire(1);

  const response = await fetch(input, init);

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    rateLimiter.handle429(retryAfter);
  } else if (response.ok) {
    rateLimiter.recordSuccess();
  }

  return response;
}) as typeof globalThis.fetch;
