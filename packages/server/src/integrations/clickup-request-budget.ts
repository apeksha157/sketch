import { createHash } from "node:crypto";

const MIN_RETRY_AFTER_MS = 1_000;
const DEFAULT_RETRY_AFTER_MS = 10_000;
const cooldowns = new Map<string, number>();

export class ClickUpApiRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    const delay = Number.isFinite(retryAfterMs)
      ? Math.max(MIN_RETRY_AFTER_MS, Math.ceil(retryAfterMs))
      : DEFAULT_RETRY_AFTER_MS;
    const seconds = Math.ceil(delay / 1_000);
    super(
      `ClickUp API request failed with HTTP 429. Rate limit reached. Wait at least ${seconds} second${seconds === 1 ? "" : "s"} before retrying.`,
    );
    this.name = "ClickUpApiRateLimitError";
    this.retryAfterMs = delay;
  }
}

function key(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function assertClickUpRequestAllowed(token: string): void {
  const now = Date.now();
  for (const [key, until] of cooldowns) {
    if (until <= now) cooldowns.delete(key);
  }
  const until = cooldowns.get(key(token));
  if (until && until > now) throw new ClickUpApiRateLimitError(until - now);
}

/** Share known per-token cooldowns between capability probes and agent API requests. */
export function recordClickUpRateLimit(token: string, headers: Headers): ClickUpApiRateLimitError {
  const delays: number[] = [];
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay)) delays.push(delay);
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && Number.isFinite(Number(reset))) delays.push(Number(reset) * 1_000 - Date.now());
  const error = new ClickUpApiRateLimitError(delays.length ? Math.max(...delays) : DEFAULT_RETRY_AFTER_MS);
  const tokenKey = key(token);
  if (cooldowns.size >= 256 && !cooldowns.has(tokenKey)) {
    const oldest = cooldowns.keys().next().value;
    if (oldest) cooldowns.delete(oldest);
  }
  cooldowns.set(tokenKey, Math.max(cooldowns.get(tokenKey) ?? 0, Date.now() + error.retryAfterMs));
  return error;
}
