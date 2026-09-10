import { describe, expect, it } from "vitest";

import { LoginGuard, RateLimiter } from "./rate-limit.js";

describe("auth rate limits", () => {
  it("locks one IP/email key after repeated failures and clears on success", () => {
    let now = 0;
    const guard = new LoginGuard(2, 1_000, 500, () => now);
    expect(guard.allow("ip:email")).toBe(true);
    guard.failure("ip:email");
    expect(guard.allow("ip:email")).toBe(true);
    guard.failure("ip:email");
    expect(guard.allow("ip:email")).toBe(false);
    guard.success("ip:email");
    expect(guard.allow("ip:email")).toBe(true);
    now = 1_000;
    expect(guard.allow("other")).toBe(true);
  });

  it("keeps the existing fixed-window limiter behavior", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 100, () => now);
    expect(limiter.allow("key")).toBe(true);
    expect(limiter.allow("key")).toBe(false);
    now = 100;
    expect(limiter.allow("key")).toBe(true);
  });
});
