import { afterEach, describe, expect, it, vi } from "vitest";
import { assertClickUpRequestAllowed, recordClickUpRateLimit } from "./clickup-request-budget";

afterEach(() => vi.useRealTimers());

describe("ClickUp per-token request budget", () => {
  it("honors the later reset without shortening long provider cooldowns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const error = recordClickUpRateLimit(
      "long-reset",
      new Headers({
        "Retry-After": "2",
        "X-RateLimit-Reset": String(Date.now() / 1000 + 600),
      }),
    );
    expect(error.retryAfterMs).toBe(600_000);
    expect(error.message).not.toContain("long-reset");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(() => assertClickUpRequestAllowed("long-reset")).toThrow("Wait at least 300 seconds");
    expect(() => assertClickUpRequestAllowed("other-token")).not.toThrow();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(() => assertClickUpRequestAllowed("long-reset")).not.toThrow();
  });

  it("keeps an existing longer cooldown when a concurrent response suggests a shorter one", () => {
    vi.useFakeTimers();
    recordClickUpRateLimit("concurrent-limit", new Headers({ "Retry-After": "600" }));
    recordClickUpRateLimit("concurrent-limit", new Headers({ "Retry-After": "2" }));
    expect(() => assertClickUpRequestAllowed("concurrent-limit")).toThrow(/Wait at least 600 seconds/);
  });
});
