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

type GeminiAdmission = { kind: "standard" } | { kind: "probe"; token: object };

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
const MONTHLY_CAP_COOLDOWN_MS = 5 * 60 * 1000;
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

function isMonthlySpendingCapExceeded(status: number | undefined, err: unknown): boolean {
  return status === 429 && errorText(err).toLowerCase().includes("exceeded its monthly spending cap");
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
}

const unavailableByQuotaIdentity = new Map<string, GeminiUnavailableEntry>();
const activeCredentialByQuotaIdentity = new Map<string, string>();

function readUnavailableEntry(quotaIdentity: string): GeminiUnavailableEntry | undefined {
  return unavailableByQuotaIdentity.get(quotaIdentity);
}

function readActiveEntry(quotaIdentity: string, apiKey: string): GeminiUnavailableEntry | undefined {
  if (activeCredentialByQuotaIdentity.get(quotaIdentity) !== apiKey) return undefined;
  return unavailableByQuotaIdentity.get(quotaIdentity);
}

/**
 * Admit one request. Credential rotation is decided only here: a credential
 * that differs from the quota's active credential discards the previous
 * credential's cached state. Settlement uses the read-only lookups above so a
 * stale in-flight response can never erase a newer identity's state.
 */
function admitGeminiRequest(apiKey: string, opts: NormalizedGeminiOptions): GeminiAdmission | GeminiUnavailableReason {
  if (activeCredentialByQuotaIdentity.get(opts.quotaIdentity) !== apiKey) {
    activeCredentialByQuotaIdentity.set(opts.quotaIdentity, apiKey);
    unavailableByQuotaIdentity.delete(opts.quotaIdentity);
  }
  const entry = readUnavailableEntry(opts.quotaIdentity);
  if (!entry) return { kind: "standard" };
  if (entry.state === "probing" || opts.now() < entry.until) return entry.reason;
  entry.state = "probing";
  entry.token = {};
  return { kind: "probe", token: entry.token };
}

function assertGeminiRequestNotRevoked(
  apiKey: string,
  opts: NormalizedGeminiOptions,
  admission: GeminiAdmission,
): void {
  if (admission.kind === "probe") return;
  const reason = readUnavailableEntry(opts.quotaIdentity)?.reason;
  if (reason) throw new GeminiUnavailableError(reason);
}

function recordMonthlyCap(apiKey: string, opts: NormalizedGeminiOptions): void {
  if (activeCredentialByQuotaIdentity.get(opts.quotaIdentity) !== apiKey) return;
  if (unavailableByQuotaIdentity.has(opts.quotaIdentity)) return;
  unavailableByQuotaIdentity.set(opts.quotaIdentity, {
    token: {},
    state: "cooling",
    reason: "monthly_cap_cached",
    until: opts.now() + MONTHLY_CAP_COOLDOWN_MS,
  });
}

function settleGeminiRequest(
  apiKey: string,
  opts: NormalizedGeminiOptions,
  admission: GeminiAdmission,
  outcome: "success" | "cap" | "failure",
): void {
  if (admission.kind === "standard") {
    if (outcome === "cap") recordMonthlyCap(apiKey, opts);
    return;
  }
  const entry = readActiveEntry(opts.quotaIdentity, apiKey);
  if (!entry || entry.token !== admission.token) return;
  if (outcome === "success") {
    unavailableByQuotaIdentity.delete(opts.quotaIdentity);
    return;
  }
  entry.state = "cooling";
  entry.token = {};
  entry.reason = outcome === "cap" ? "monthly_cap_cached" : "provider_unavailable_cached";
  entry.until = opts.now() + MONTHLY_CAP_COOLDOWN_MS;
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
      assertGeminiRequestNotRevoked(apiKey, opts, admission);
      await acquireGeminiSlot(apiKey, options, () => assertGeminiRequestNotRevoked(apiKey, opts, admission));
      assertGeminiRequestNotRevoked(apiKey, opts, admission);
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
    settleGeminiRequest(apiKey, opts, admission, outcome);
  }
}

export function resetGeminiControlsForTests(): void {
  resetRpmPacerForTests();
  validationByQuotaIdentity.clear();
  unavailableByQuotaIdentity.clear();
  activeCredentialByQuotaIdentity.clear();
}
