interface Counter { count: number; resetAt: number; }

export class RateLimiter {
  readonly #entries = new Map<string, Counter>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  allow(key: string): boolean {
    const now = this.now();
    const current = this.#entries.get(key);
    if (!current || current.resetAt <= now) {
      this.#entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  clear(): void { this.#entries.clear(); }
}

interface LoginFailure extends Counter { lockedUntil: number; }

/** 以 IP+邮箱摘要为键的短期失败锁定，避免单一 IP 轮换账户绕过限制。 */
export class LoginGuard {
  readonly #entries = new Map<string, LoginFailure>();

  constructor(private readonly maxAttempts = 5, private readonly windowMs = 15 * 60_000, private readonly lockMs = 5 * 60_000, private readonly now: () => number = Date.now) {}

  allow(key: string): boolean {
    const now = this.now();
    const current = this.#entries.get(key);
    if (!current || current.resetAt <= now) {
      this.#entries.set(key, { count: 0, resetAt: now + this.windowMs, lockedUntil: 0 });
      return true;
    }
    return current.lockedUntil <= now;
  }

  failure(key: string): void {
    const now = this.now();
    const current = this.#entries.get(key) ?? { count: 0, resetAt: now + this.windowMs, lockedUntil: 0 };
    current.count += 1;
    if (current.count >= this.maxAttempts) current.lockedUntil = now + this.lockMs;
    this.#entries.set(key, current);
  }

  success(key: string): void { this.#entries.delete(key); }
  clear(): void { this.#entries.clear(); }
}
