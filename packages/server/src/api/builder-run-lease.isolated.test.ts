import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BuilderConversationAccessResult } from "../automation/task-conversations";
import { maintainBuilderRunLease } from "./builder-run-lease";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
});

afterEach(() => vi.useRealTimers());

function active(): BuilderConversationAccessResult {
  return {
    kind: "active",
    created: false,
    association: {} as never,
    lock: {
      state: "held",
      owner: "self",
      conversationId: "builder-fixture",
      generation: 1,
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    },
  };
}

function start(renew: () => Promise<BuilderConversationAccessResult>) {
  const controller = new AbortController();
  const onError = vi.fn();
  const lease = maintainBuilderRunLease({
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    generation: 1,
    signal: controller.signal,
    renew,
    onLost: (reason) => controller.abort(reason),
    onError,
  });
  return { controller, onError, ...lease };
}

it("retries a transient renewal failure and remains valid beyond the original expiry", async () => {
  const renew = vi.fn(async () => active()).mockRejectedValueOnce(new Error("temporary database failure"));
  const lease = start(renew);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(lease.onError).toHaveBeenCalledOnce();
  expect(lease.controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(80_000);
  expect(renew.mock.calls.length).toBeGreaterThan(1);
  expect(lease.controller.signal.aborted).toBe(false);
  lease.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds repeated renewal errors by the last confirmed expiry", async () => {
  const renew = vi.fn().mockRejectedValue(new Error("database unavailable"));
  const lease = start(renew);
  await vi.advanceTimersByTimeAsync(89_999);
  expect(lease.controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(lease.controller.signal.reason).toBe("lease_expired");
  expect(vi.getTimerCount()).toBe(0);
});

it("expires a hung renewal without concurrent retries and ignores its late success", async () => {
  let finish!: (value: BuilderConversationAccessResult) => void;
  const renew = vi.fn(
    () =>
      new Promise<BuilderConversationAccessResult>((resolve) => {
        finish = resolve;
      }),
  );
  const lease = start(renew);
  await vi.advanceTimersByTimeAsync(20_000);
  const refresh = lease.refresh();
  await vi.advanceTimersByTimeAsync(70_000);
  expect(renew).toHaveBeenCalledOnce();
  expect(lease.controller.signal.reason).toBe("lease_expired");
  finish(active());
  await refresh;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["stale", "archived", "locked"] as const)("stops on confirmed %s access", async (kind) => {
  const current = active();
  if (current.kind !== "active") throw new Error("Expected active fixture");
  const lease = start(async () => ({ kind, lock: current.lock }));
  await lease.refresh();
  expect(lease.controller.signal.reason).toBe("lease_lost");
  expect(vi.getTimerCount()).toBe(0);
});

it("does not renew an expired lease or a stopped run", async () => {
  const renew = vi.fn(async () => active());
  const lease = start(renew);
  lease.controller.abort("user_stop");
  await vi.advanceTimersByTimeAsync(100_000);
  await lease.refresh();
  expect(renew).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
