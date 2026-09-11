/**
 * Process-wide requests-per-minute pacer, keyed by quota identity (an API
 * key, a project, an account). Callers await a slot before each request;
 * slots are handed out `60000 / maxRpm` ms apart on a promise chain, so
 * concurrent callers queue instead of bursting. Extracted from the Gemini
 * client so every rate-limited upstream (Gemini, Aimfox) shares one
 * implementation.
 */
export interface RpmPacerOptions {
  maxRpm: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Limiter = {
  nextAt: number;
  tail: Promise<void>;
};

const limiterByQuotaIdentity = new Map<string, Limiter>();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resetRpmPacerForTests(): void {
  limiterByQuotaIdentity.clear();
}

export async function acquireRpmSlot(quotaIdentity: string, options: RpmPacerOptions): Promise<void> {
  const maxRpm = Math.max(1, Math.floor(options.maxRpm));
  const intervalMs = Math.ceil(60000 / maxRpm);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  let limiter = limiterByQuotaIdentity.get(quotaIdentity);
  if (!limiter) {
    limiter = { nextAt: 0, tail: Promise.resolve() };
    limiterByQuotaIdentity.set(quotaIdentity, limiter);
  }

  const run = limiter.tail.then(async () => {
    const waitMs = Math.max(0, limiter.nextAt - now());
    if (waitMs > 0) await sleep(waitMs);
    limiter.nextAt = now() + intervalMs;
  });
  limiter.tail = run.catch(() => {});
  await run;
}
