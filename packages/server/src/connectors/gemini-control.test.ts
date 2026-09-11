import { describe, expect, it, vi } from "vitest";
import {
  GeminiHttpError,
  GeminiUnavailableError,
  resetGeminiControlsForTests,
  runGeminiRequest,
} from "./gemini-control";

const MONTHLY_SPENDING_CAP_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap. Learn more at https://ai.google.dev/gemini-api/docs/billing#project-spend-caps. ",
    status: "RESOURCE_EXHAUSTED",
  },
});

describe("Gemini request controls", () => {
  it("paces requests sharing the same quota identity", async () => {
    resetGeminiControlsForTests();
    let now = 0;
    const sleeps: number[] = [];
    const options = {
      maxRpm: 60,
      maxRetries: 0,
      quotaIdentity: "project-1",
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    };

    await runGeminiRequest("key-a", async () => "generation", options);
    await runGeminiRequest("key-a", async () => "embedding", options);
    await runGeminiRequest("key-a", async () => "query", options);

    expect(sleeps).toEqual([1000, 1000]);
  });

  it("retries transient failures with bounded backoff", async () => {
    resetGeminiControlsForTests();
    let calls = 0;
    let retries = 0;

    const result = await runGeminiRequest(
      "key-a",
      async () => {
        calls++;
        if (calls === 1) throw new GeminiHttpError(429, "quota exceeded");
        return "ok";
      },
      {
        maxRpm: 1000,
        maxRetries: 2,
        sleep: async () => {},
        onRetry: () => {
          retries++;
        },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(retries).toBe(1);
  });

  it("does not retry the monthly spending cap response", async () => {
    resetGeminiControlsForTests();
    let calls = 0;
    let retries = 0;

    await expect(
      runGeminiRequest(
        "key-a",
        async () => {
          calls++;
          throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
        },
        {
          maxRpm: 1000,
          maxRetries: 4,
          sleep: async () => {},
          onRetry: () => {
            retries++;
          },
        },
      ),
    ).rejects.toThrow("exceeded its monthly spending cap");

    expect(calls).toBe(1);
    expect(retries).toBe(0);
  });

  it("retries transient RESOURCE_EXHAUSTED responses without the spending cap phrase", async () => {
    resetGeminiControlsForTests();
    let calls = 0;
    let retries = 0;

    const result = await runGeminiRequest(
      "key-a",
      async () => {
        calls++;
        if (calls === 1) {
          throw new GeminiHttpError(
            429,
            JSON.stringify({
              error: { code: 429, message: "Quota exceeded. Try again later.", status: "RESOURCE_EXHAUSTED" },
            }),
          );
        }
        return "ok";
      },
      {
        maxRpm: 1000,
        maxRetries: 2,
        sleep: async () => {},
        onRetry: () => {
          retries++;
        },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(retries).toBe(1);
  });

  it("retries transient server errors", async () => {
    resetGeminiControlsForTests();
    let calls = 0;
    let retries = 0;

    const result = await runGeminiRequest(
      "key-a",
      async () => {
        calls++;
        if (calls === 1) throw new GeminiHttpError(503, "upstream unavailable");
        return "ok";
      },
      {
        maxRpm: 1000,
        maxRetries: 1,
        sleep: async () => {},
        onRetry: () => {
          retries++;
        },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(retries).toBe(1);
  });

  it("only retries API_KEY_INVALID when the key recently validated", async () => {
    resetGeminiControlsForTests();
    let validCalls = 0;
    const validResult = await runGeminiRequest(
      "valid-key",
      async () => {
        validCalls++;
        if (validCalls === 1) throw new GeminiHttpError(400, "API_KEY_INVALID");
        return "ok";
      },
      {
        maxRpm: 1000,
        maxRetries: 1,
        sleep: async () => {},
        validateKey: async () => "valid",
      },
    );

    resetGeminiControlsForTests();
    let invalidCalls = 0;
    await expect(
      runGeminiRequest(
        "invalid-key",
        async () => {
          invalidCalls++;
          throw new GeminiHttpError(400, "API_KEY_INVALID");
        },
        {
          maxRpm: 1000,
          maxRetries: 1,
          sleep: async () => {},
          validateKey: async () => "invalid",
        },
      ),
    ).rejects.toThrow("Gemini API error (400)");

    expect(validResult).toBe("ok");
    expect(validCalls).toBe(2);
    expect(invalidCalls).toBe(1);
  });
});

describe("Gemini monthly cap cache", () => {
  const COOLDOWN_MS = 5 * 60 * 1000;

  function createClock(initial = 0) {
    let now = initial;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  function fastOptions(clock: { now: () => number }, quotaIdentity: string, overrides: Record<string, unknown> = {}) {
    return {
      maxRpm: 60_000,
      maxRetries: 0,
      quotaIdentity,
      now: clock.now,
      sleep: async () => {},
      ...overrides,
    };
  }

  function capOperation(counter: { calls: number }): () => Promise<never> {
    return async () => {
      counter.calls++;
      throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
    };
  }

  it("makes one attempt for the cap and fails fast while the cache cools", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0, retries: 0 };
    const options = fastOptions(clock, "q-cap", {
      maxRetries: 4,
      onRetry: () => {
        counter.retries++;
      },
    });

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow(
      "exceeded its monthly spending cap",
    );
    expect(counter.calls).toBe(1);
    expect(counter.retries).toBe(0);

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toMatchObject({
      name: "GeminiUnavailableError",
      reason: "monthly_cap_cached",
    });
    expect(counter.calls).toBe(1);
  });

  it("does not pace or issue requests for calls during the cooldown", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const sleeps: number[] = [];
    const counter = { calls: 0 };
    const options = fastOptions(clock, "q-sleep", {
      maxRpm: 60,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();
    expect(sleeps).toEqual([]);

    clock.advance(1_000);
    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toBeInstanceOf(
      GeminiUnavailableError,
    );
    expect(counter.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("unwinds a pacer waiter that was queued before the cap was discovered", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const sleeps: Array<{ ms: number; release: () => void }> = [];
    const counter = { calls: 0 };
    const options = fastOptions(clock, "q-waiter", {
      maxRpm: 60,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          sleeps.push({ ms, release: resolve });
        }),
    });
    let releaseCap!: () => void;
    const capGate = new Promise<void>((resolve) => {
      releaseCap = resolve;
    });

    const discovering = runGeminiRequest(
      "key-a",
      async () => {
        counter.calls++;
        await capGate;
        throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
      },
      options,
    );
    await vi.waitFor(() => expect(counter.calls).toBe(1));

    const queued = runGeminiRequest("key-a", capOperation(counter), options);
    await vi.waitFor(() => expect(sleeps).toHaveLength(1));

    releaseCap();
    await expect(discovering).rejects.toThrow("exceeded its monthly spending cap");

    clock.advance(sleeps[0].ms);
    sleeps[0].release();
    await expect(queued).rejects.toMatchObject({ reason: "monthly_cap_cached" });
    expect(counter.calls).toBe(1);
    expect(sleeps).toHaveLength(1);
  });

  it("stops queued waiters from sleeping once the cap is discovered", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const sleeps: number[] = [];
    const counter = { calls: 0 };
    let releaseFirstSleep!: () => void;
    const firstSleepGate = new Promise<void>((resolve) => {
      releaseFirstSleep = resolve;
    });
    const options = fastOptions(clock, "q-multi-waiter", {
      maxRpm: 60,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock.advance(ms);
        return sleeps.length === 1 ? firstSleepGate : Promise.resolve();
      },
    });
    let releaseCap!: () => void;
    const capGate = new Promise<void>((resolve) => {
      releaseCap = resolve;
    });

    const discovering = runGeminiRequest(
      "key-a",
      async () => {
        counter.calls++;
        await capGate;
        throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
      },
      options,
    );
    await vi.waitFor(() => expect(counter.calls).toBe(1));

    const waiters = Array.from({ length: 4 }, () => runGeminiRequest("key-a", capOperation(counter), options));
    await vi.waitFor(() => expect(sleeps).toHaveLength(1));

    releaseCap();
    await expect(discovering).rejects.toThrow("exceeded its monthly spending cap");

    releaseFirstSleep();
    const results = await Promise.allSettled(waiters);
    expect(
      results.every((result) => result.status === "rejected" && result.reason instanceof GeminiUnavailableError),
    ).toBe(true);
    expect(sleeps).toHaveLength(1);
    expect(counter.calls).toBe(1);
  });

  it("isolates cached refusals by quota and credential", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0 };

    await expect(runGeminiRequest("key-a", capOperation(counter), fastOptions(clock, "q-1"))).rejects.toThrow(
      "exceeded its monthly spending cap",
    );

    await expect(runGeminiRequest("key-a", capOperation(counter), fastOptions(clock, "q-1"))).rejects.toBeInstanceOf(
      GeminiUnavailableError,
    );
    expect(counter.calls).toBe(1);

    await expect(runGeminiRequest("key-a", async () => "other-quota", fastOptions(clock, "q-2"))).resolves.toBe(
      "other-quota",
    );

    await expect(runGeminiRequest("key-b", async () => "rotated", fastOptions(clock, "q-1"))).resolves.toBe("rotated");
    await expect(runGeminiRequest("key-a", async () => "rotated-back", fastOptions(clock, "q-1"))).resolves.toBe(
      "rotated-back",
    );
  });

  it("keeps the newer credential's cached cap when an old in-flight cap settles", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const options = fastOptions(clock, "q-rotate");
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let oldStarted = false;

    const oldCall = runGeminiRequest(
      "key-old",
      async () => {
        oldStarted = true;
        await oldGate;
        throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
      },
      options,
    );
    await vi.waitFor(() => expect(oldStarted).toBe(true));

    await expect(
      runGeminiRequest(
        "key-new",
        async () => {
          throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
        },
        options,
      ),
    ).rejects.toThrow("exceeded its monthly spending cap");

    releaseOld();
    await expect(oldCall).rejects.toThrow("exceeded its monthly spending cap");

    let networkCalls = 0;
    await expect(
      runGeminiRequest(
        "key-new",
        async () => {
          networkCalls++;
          return "never";
        },
        options,
      ),
    ).rejects.toMatchObject({ reason: "monthly_cap_cached" });
    expect(networkCalls).toBe(0);

    await expect(runGeminiRequest("key-old", async () => "old-again", options)).resolves.toBe("old-again");
  });

  it("allows exactly one recovery probe after the cooldown", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0 };
    const options = fastOptions(clock, "q-probe");

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();
    clock.advance(COOLDOWN_MS);

    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probeStarted = false;
    const probe = runGeminiRequest(
      "key-a",
      async () => {
        probeStarted = true;
        await probeGate;
        return "probe";
      },
      options,
    );
    await vi.waitFor(() => expect(probeStarted).toBe(true));

    const others = await Promise.allSettled([
      runGeminiRequest("key-a", async () => "other-1", options),
      runGeminiRequest("key-a", async () => "other-2", options),
    ]);
    expect(
      others.every((result) => result.status === "rejected" && result.reason instanceof GeminiUnavailableError),
    ).toBe(true);

    releaseProbe();
    await expect(probe).resolves.toBe("probe");
    await expect(runGeminiRequest("key-a", async () => "after", options)).resolves.toBe("after");
  });

  it("clears the cache when the probe succeeds", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0 };
    const options = fastOptions(clock, "q-recover");

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();
    clock.advance(COOLDOWN_MS);

    await expect(runGeminiRequest("key-a", async () => "recovered", options)).resolves.toBe("recovered");
    await expect(runGeminiRequest("key-a", async () => "still-working", options)).resolves.toBe("still-working");
  });

  it("keeps a newer cap when an older success settles late", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0 };
    const options = fastOptions(clock, "q-stale");
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowStarted = false;

    const slow = runGeminiRequest(
      "key-a",
      async () => {
        slowStarted = true;
        await slowGate;
        return "slow";
      },
      options,
    );
    await vi.waitFor(() => expect(slowStarted).toBe(true));

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();

    releaseSlow();
    await expect(slow).resolves.toBe("slow");
    await expect(runGeminiRequest("key-a", async () => "never", options)).rejects.toMatchObject({
      reason: "monthly_cap_cached",
    });
  });

  it("extends the cooldown when the probe hits the cap again", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0 };
    const options = fastOptions(clock, "q-probe-cap");

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();
    clock.advance(COOLDOWN_MS);

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();
    expect(counter.calls).toBe(2);

    clock.advance(COOLDOWN_MS - 1);
    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toMatchObject({
      reason: "monthly_cap_cached",
    });
    expect(counter.calls).toBe(2);

    clock.advance(1);
    await expect(runGeminiRequest("key-a", async () => "recovered", options)).resolves.toBe("recovered");
  });

  it("keeps bounded retries for a transiently failing probe and then clears", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0, retries: 0 };
    const options = fastOptions(clock, "q-probe-transient", {
      maxRetries: 1,
      onRetry: () => {
        counter.retries++;
      },
    });

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();
    clock.advance(COOLDOWN_MS);

    const result = await runGeminiRequest(
      "key-a",
      async () => {
        counter.calls++;
        if (counter.calls === 2) throw new GeminiHttpError(503, "upstream unavailable");
        return "ok";
      },
      options,
    );

    expect(result).toBe("ok");
    expect(counter.calls).toBe(3);
    expect(counter.retries).toBe(1);
    await expect(runGeminiRequest("key-a", async () => "after", options)).resolves.toBe("after");
  });

  it("retains a next-probe boundary after an exhausted transient probe failure", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0 };
    const options = fastOptions(clock, "q-probe-failure");

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();
    clock.advance(COOLDOWN_MS);

    await expect(
      runGeminiRequest(
        "key-a",
        async () => {
          counter.calls++;
          throw new GeminiHttpError(503, "upstream unavailable");
        },
        fastOptions(clock, "q-probe-failure", { maxRetries: 1 }),
      ),
    ).rejects.toThrow("Gemini API error (503)");
    expect(counter.calls).toBe(3);

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toMatchObject({
      reason: "provider_unavailable_cached",
    });
    expect(counter.calls).toBe(3);

    clock.advance(COOLDOWN_MS);
    await expect(runGeminiRequest("key-a", async () => "probe", options)).resolves.toBe("probe");
  });

  it("clears cached state for tests", async () => {
    resetGeminiControlsForTests();
    const clock = createClock();
    const counter = { calls: 0 };
    const options = fastOptions(clock, "q-reset");

    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toThrow();
    await expect(runGeminiRequest("key-a", capOperation(counter), options)).rejects.toBeInstanceOf(
      GeminiUnavailableError,
    );

    resetGeminiControlsForTests();
    await expect(runGeminiRequest("key-a", async () => "after-reset", options)).resolves.toBe("after-reset");
  });
});
