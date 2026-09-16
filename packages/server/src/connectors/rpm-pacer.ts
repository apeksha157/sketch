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
  /**
   * Invoked inside the serialized slot callback, before sleeping and again
   * after the wait. Throwing aborts this waiter without starting a second
   * sleep or advancing the shared schedule, so a caller that learned it can
   * no longer make a request stops consuming paced waiting time.
   */
  checkAllowed?: () => void;
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
  const checkAllowed = options.checkAllowed;
  let limiter = limiterByQuotaIdentity.get(quotaIdentity);
  if (!limiter) {
    limiter = { nextAt: 0, tail: Promise.resolve() };
    limiterByQuotaIdentity.set(quotaIdentity, limiter);
  }

  const run = limiter.tail.then(async () => {
    checkAllowed?.();
    const waitMs = Math.max(0, limiter.nextAt - now());
    if (waitMs > 0) await sleep(waitMs);
    checkAllowed?.();
    limiter.nextAt = now() + intervalMs;
  });
  limiter.tail = run.catch(() => {});
  await run;
}
