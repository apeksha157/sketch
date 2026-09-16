import { acquireRpmSlot, resetRpmPacerForTests } from "./rpm-pacer";

export type GeminiSleep = (ms: number) => Promise<void>;
export type GeminiNow = () => number;

export interface GeminiClientOptions {
  maxRpm?: number;
  maxRetries?: number;
  quotaIdentity?: string;
  sleep?: GeminiSleep;
  now?: GeminiNow;
  validateKey?: (apiKey: string) => Promise<"valid" | "invalid" | "unknown">;
  onRetry?: (event: { attempt: number; maxRetries: number; delayMs: number; reason: string }) => void;
}

export class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Gemini API error (${status}): ${body}`);
    this.name = "GeminiHttpError";
  }
}

export type GeminiUnavailableReason = "monthly_cap_cached" | "provider_unavailable_cached";

type GeminiAdmission = { kind: "standard"; epoch: number } | { kind: "probe"; token: object; epoch: number };

type ValidationCacheEntry = {
  apiKey: string;
  status: "valid" | "invalid" | "unknown";
  expiresAt: number;
};

type NormalizedGeminiOptions = {
  maxRpm: number;
  maxRetries: number;
  quotaIdentity: string;
  sleep: GeminiSleep;
  now: GeminiNow;
  validateKey: (apiKey: string) => Promise<"valid" | "invalid" | "unknown">;
  onRetry: GeminiClientOptions["onRetry"];
};

const DEFAULT_MAX_RPM = 60;
const DEFAULT_MAX_RETRIES = 4;
const VALIDATION_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Recovery-probe policy, not a claim about when Google's monthly cap resets. */
const MONTHLY_CAP_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * Upper bound on one probe's ownership of the scope. A probe that has not
 * settled by then is treated as abandoned and the next caller may claim a
 * fenced replacement, so a hung operation cannot close the scope forever.
 * Chosen to exceed the bounded generation transport (60s) times the bounded
 * attempt count plus backoff, so a healthy probe normally settles first.
 */
const PROBE_LEASE_MS = 10 * 60 * 1000;
const validationByQuotaIdentity = new Map<string, ValidationCacheEntry>();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptions(apiKey: string, options?: GeminiClientOptions): NormalizedGeminiOptions {
  const maxRpm = Math.max(1, Math.floor(options?.maxRpm ?? DEFAULT_MAX_RPM));
  const maxRetries = Math.max(0, Math.floor(options?.maxRetries ?? DEFAULT_MAX_RETRIES));
  const quotaIdentity = options?.quotaIdentity ?? apiKey;
  return {
    maxRpm,
    maxRetries,
    quotaIdentity,
    sleep: options?.sleep ?? defaultSleep,
    now: options?.now ?? Date.now,
    validateKey: options?.validateKey ?? validateGeminiKey,
    onRetry: options?.onRetry,
  };
}

async function acquireGeminiSlot(
  apiKey: string,
  options: GeminiClientOptions | undefined,
  checkAllowed: () => void,
): Promise<void> {
  const opts = normalizeOptions(apiKey, options);
  await acquireRpmSlot(`gemini:${opts.quotaIdentity}`, {
    maxRpm: opts.maxRpm,
    sleep: opts.sleep,
    now: opts.now,
    checkAllowed,
  });
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 4000);
  const jitter = Math.floor(Math.random() * Math.min(250, base / 2));
  return base + jitter;
}

function errorText(err: unknown): string {
  if (err instanceof GeminiHttpError) return err.body;
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorStatus(err: unknown): number | undefined {
  if (err instanceof GeminiHttpError) return err.status;
  if (err && typeof err === "object") {
    const raw = err as Record<string, unknown>;
    const status = raw.status ?? raw.statusCode ?? raw.code;
    if (typeof status === "number") return status;
    if (typeof status === "string" && /^\d+$/.test(status)) return Number(status);
  }
  return undefined;
}

function isApiKeyInvalid(err: unknown): boolean {
  return errorText(err).includes("API_KEY_INVALID");
}

/**
 * Terminal account-level refusal. Matches only the exact spending-cap phrase on
 * a 429 so ordinary rate limits, generic `RESOURCE_EXHAUSTED`, and unrelated
 * quota wording keep their existing retry behavior.
 */
export function isMonthlySpendingCapExceeded(status: number | undefined, err: unknown): boolean {
  if (status !== 429) return false;
  const normalized = errorText(err).toLowerCase().replace(/\s+/g, " ");
  return normalized.includes("exceeded its monthly spending cap");
}

/**
 * Error-shape-agnostic monthly-cap check shared with the retry/fallback
 * helpers so the raw REST `GeminiHttpError`, the Google SDK's `ApiError`
 * (status plus JSON message), and any object carrying a numeric status all
 * classify identically.
 */
export function isMonthlySpendingCapError(err: unknown): boolean {
  return isMonthlySpendingCapExceeded(errorStatus(err), err);
}

/**
 * Raised when Gemini was recently refused for an exhausted monthly spending
 * cap, or while another caller probes for recovery. Non-retryable by design so
 * callers fall back to keyword-only search without burning paced attempts.
 */
export class GeminiUnavailableError extends Error {
  constructor(readonly reason: GeminiUnavailableReason) {
    super(`Gemini unavailable (${reason})`);
    this.name = "GeminiUnavailableError";
  }
}

interface GeminiUnavailableEntry {
  token: object;
  state: "cooling" | "probing";
  reason: GeminiUnavailableReason;
  until: number;
  epoch: number;
}

const unavailableByQuotaIdentity = new Map<string, GeminiUnavailableEntry>();
const activeCredentialByQuotaIdentity = new Map<string, string>();
const versionByQuotaIdentity = new Map<string, number>();

function currentVersion(quotaIdentity: string): number {
  return versionByQuotaIdentity.get(quotaIdentity) ?? 0;
}

/**
 * Monotonic per-quota state version. Every transition — credential rotation,
 * cap recorded, probe claimed, recovery, or probe failure — advances it, so a
 * settlement admitted under an older version can never mutate newer state,
 * even when the credential string looks current again (A→B→A).
 */
function advanceVersion(quotaIdentity: string): number {
  const next = currentVersion(quotaIdentity) + 1;
  versionByQuotaIdentity.set(quotaIdentity, next);
  return next;
}

function readUnavailableEntry(quotaIdentity: string): GeminiUnavailableEntry | undefined {
  return unavailableByQuotaIdentity.get(quotaIdentity);
}

/**
 * Admit one request. Credential rotation is decided only here: a credential
 * that differs from the quota's active credential discards the previous
 * credential's cached state and advances the version. A cooling entry becomes a
 * probe at cooldown expiry; a probing entry past its lease is treated as
 * abandoned and replaced by a fenced probe, so one hung operation cannot own the
 * scope forever.
 */
function admitGeminiRequest(apiKey: string, opts: NormalizedGeminiOptions): GeminiAdmission | GeminiUnavailableReason {
  if (activeCredentialByQuotaIdentity.get(opts.quotaIdentity) !== apiKey) {
    activeCredentialByQuotaIdentity.set(opts.quotaIdentity, apiKey);
    unavailableByQuotaIdentity.delete(opts.quotaIdentity);
    advanceVersion(opts.quotaIdentity);
  }
  const entry = readUnavailableEntry(opts.quotaIdentity);
  if (!entry) return { kind: "standard", epoch: currentVersion(opts.quotaIdentity) };
  if (opts.now() < entry.until) return entry.reason;
  const epoch = advanceVersion(opts.quotaIdentity);
  entry.state = "probing";
  entry.token = {};
  entry.until = opts.now() + PROBE_LEASE_MS;
  entry.epoch = epoch;
  return { kind: "probe", token: entry.token, epoch };
}

/**
 * Rechecked inside the pacer before it sleeps and again immediately before the
 * HTTP call. A caller that joined the pacer before the cap was discovered is
 * revoked here instead of consuming another paced interval.
 */
function assertGeminiRequestNotRevoked(opts: NormalizedGeminiOptions, admission: GeminiAdmission): void {
  if (admission.kind === "probe") return;
  const reason = readUnavailableEntry(opts.quotaIdentity)?.reason;
  if (reason) throw new GeminiUnavailableError(reason);
}

/**
 * Version- and token-fenced settlement. A settlement whose admission epoch is
 * no longer current is discarded, so a late cap from a request that predates a
 * recovery (or a rotated/re-rotated credential) cannot re-open a refusal, and a
 * late probe settlement cannot clear or overwrite its successor's state.
 */
function settleGeminiRequest(
  opts: NormalizedGeminiOptions,
  admission: GeminiAdmission,
  outcome: "success" | "cap" | "failure",
): void {
  if (currentVersion(opts.quotaIdentity) !== admission.epoch) return;
  if (admission.kind === "standard") {
    if (outcome !== "cap") return;
    const epoch = advanceVersion(opts.quotaIdentity);
    unavailableByQuotaIdentity.set(opts.quotaIdentity, {
      token: {},
      state: "cooling",
      reason: "monthly_cap_cached",
      until: opts.now() + MONTHLY_CAP_COOLDOWN_MS,
      epoch,
    });
    return;
  }
  const entry = readUnavailableEntry(opts.quotaIdentity);
  if (!entry || entry.token !== admission.token) return;
  const epoch = advanceVersion(opts.quotaIdentity);
  if (outcome === "success") {
    unavailableByQuotaIdentity.delete(opts.quotaIdentity);
    return;
  }
  entry.state = "cooling";
  entry.token = {};
  entry.reason = outcome === "cap" ? "monthly_cap_cached" : "provider_unavailable_cached";
  entry.until = opts.now() + MONTHLY_CAP_COOLDOWN_MS;
  entry.epoch = epoch;
}

async function validateGeminiKey(apiKey: string): Promise<"valid" | "invalid" | "unknown"> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (res.ok) return "valid";
    if (res.status === 400 || res.status === 403) {
      const body = await res.text();
      if (body.includes("API_KEY_INVALID")) return "invalid";
    }
    if (res.status === 429 || res.status >= 500) return "unknown";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function validationStatus(
  apiKey: string,
  options?: GeminiClientOptions,
): Promise<"valid" | "invalid" | "unknown"> {
  const opts = normalizeOptions(apiKey, options);
  const cached = validationByQuotaIdentity.get(opts.quotaIdentity);
  if (cached && cached.apiKey === apiKey && cached.expiresAt > opts.now()) return cached.status;

  const status = await opts.validateKey(apiKey);
  validationByQuotaIdentity.set(opts.quotaIdentity, {
    apiKey,
    status,
    expiresAt: opts.now() + VALIDATION_TTL_MS,
  });
  return status;
}

async function retryReason(err: unknown, apiKey: string, options?: GeminiClientOptions): Promise<string | null> {
  const status = errorStatus(err);
  if (isMonthlySpendingCapExceeded(status, err)) return null;
  if (status === 429) return "rate_limit";
  if (status !== undefined && status >= 500) return "server_error";
  if (isApiKeyInvalid(err)) {
    return (await validationStatus(apiKey, options)) === "valid" ? "api_key_invalid_throttle" : null;
  }
  return null;
}

export async function runGeminiRequest<T>(
  apiKey: string,
  operation: () => Promise<T>,
  options?: GeminiClientOptions,
): Promise<T> {
  const opts = normalizeOptions(apiKey, options);
  const admission = admitGeminiRequest(apiKey, opts);
  if (typeof admission === "string") throw new GeminiUnavailableError(admission);
  let outcome: "success" | "cap" | "failure" = "failure";
  try {
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      assertGeminiRequestNotRevoked(opts, admission);
      await acquireGeminiSlot(apiKey, options, () => assertGeminiRequestNotRevoked(opts, admission));
      assertGeminiRequestNotRevoked(opts, admission);
      try {
        const result = await operation();
        outcome = "success";
        return result;
      } catch (err) {
        if (isMonthlySpendingCapExceeded(errorStatus(err), err)) {
          outcome = "cap";
          throw err;
        }
        const reason = await retryReason(err, apiKey, options);
        if (!reason || attempt >= opts.maxRetries) throw err;
        const delayMs = retryDelayMs(attempt);
        opts.onRetry?.({ attempt: attempt + 1, maxRetries: opts.maxRetries, delayMs, reason });
        await opts.sleep(delayMs);
      }
    }
    throw new Error("Gemini: retries exhausted");
  } finally {
    settleGeminiRequest(opts, admission, outcome);
  }
}

export function resetGeminiControlsForTests(): void {
  resetRpmPacerForTests();
  validationByQuotaIdentity.clear();
  unavailableByQuotaIdentity.clear();
  activeCredentialByQuotaIdentity.clear();
  versionByQuotaIdentity.clear();
}
