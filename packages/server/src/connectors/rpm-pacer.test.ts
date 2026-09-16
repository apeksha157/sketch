import { describe, expect, it } from "vitest";
import { acquireRpmSlot, resetRpmPacerForTests } from "./rpm-pacer";

describe("rpm pacer", () => {
  it("paces callers that do not provide a guard", async () => {
    resetRpmPacerForTests();
    let now = 0;
    const sleeps: number[] = [];
    const options = {
      maxRpm: 60,
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    };

    await acquireRpmSlot("q-plain", options);
    await acquireRpmSlot("q-plain", options);
    await acquireRpmSlot("q-plain", options);

    expect(sleeps).toEqual([1000, 1000]);
  });

  it("aborts a guarded waiter before sleeping without advancing the schedule", async () => {
    resetRpmPacerForTests();
    let now = 0;
    const sleeps: number[] = [];
    let revoked = false;
    const options = {
      maxRpm: 60,
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      checkAllowed: () => {
        if (revoked) throw new Error("revoked");
      },
    };

    await acquireRpmSlot("q-guard", options);
    revoked = true;
    await expect(acquireRpmSlot("q-guard", options)).rejects.toThrow("revoked");
    expect(sleeps).toEqual([]);

    revoked = false;
    await acquireRpmSlot("q-guard", options);
    expect(sleeps).toEqual([1000]);
  });

  it("aborts a guarded waiter that was revoked during its sleep", async () => {
    resetRpmPacerForTests();
    let now = 0;
    const sleeps: number[] = [];
    let revoked = false;
    const options = {
      maxRpm: 60,
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
        revoked = true;
      },
      checkAllowed: () => {
        if (revoked) throw new Error("revoked");
      },
    };

    await acquireRpmSlot("q-sleep-guard", options);
    await expect(acquireRpmSlot("q-sleep-guard", options)).rejects.toThrow("revoked");
    expect(sleeps).toEqual([1000]);

    revoked = false;
    await acquireRpmSlot("q-sleep-guard", options);
    expect(sleeps).toEqual([1000]);
  });

  it("keeps the pacer usable after a revoked waiter rejects", async () => {
    resetRpmPacerForTests();
    let now = 0;
    const released: string[] = [];
    const options = {
      maxRpm: 60,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      checkAllowed: () => {
        throw new Error("revoked");
      },
    };

    await expect(acquireRpmSlot("q-chain", options)).rejects.toThrow("revoked");
    released.push("after-rejection");
    expect(released).toEqual(["after-rejection"]);
  });
});
