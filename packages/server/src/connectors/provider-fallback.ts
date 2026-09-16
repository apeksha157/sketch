import type { Logger } from "pino";
import { GeminiHttpError, GeminiUnavailableError, isMonthlySpendingCapError } from "./gemini-control";

/**
 * Raw provider/transport classification. Deliberately says nothing about
 * whether the caller may retry the same operation — a terminal account refusal
 * and cached unavailability are also "provider failures" for fallback purposes
 * while being ineligible for another same-provider attempt.
 */
function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof GeminiHttpError) {
    const text = err.body.toLowerCase();
    if (text.includes("api_key_invalid") || text.includes("invalid api key")) return true;
    return err.status === 429 || err.status >= 500;
  }

  if (err instanceof Error) {
    const text = err.message.toLowerCase();
    return (
      err.name === "AbortError" ||
      text.includes("resource_exhausted") ||
      text.includes("prepayment credits") ||
      text.includes("quota") ||
      text.includes("rate limit") ||
      text.includes("timeout") ||
      text.includes("fetch failed") ||
      text.includes("api_key_invalid") ||
      text.includes("invalid api key")
    );
  }

  return false;
}

function isTerminalMonthlyCap(err: unknown): boolean {
  return isMonthlySpendingCapError(err);
}

/**
 * Same-provider operation retry eligibility. A monthly spending cap is an
 * account-level refusal and cached unavailability is a refusal already observed,
 * so neither may drive another attempt against the same provider.
 */
export function shouldRetryProviderOperation(err: unknown): boolean {
  if (err instanceof GeminiUnavailableError) return false;
  if (isTerminalMonthlyCap(err)) return false;
  return isRetryableProviderError(err);
}

/**
 * Fallback eligibility is intentionally broader than retry eligibility: raw and
 * cached monthly-cap refusals may still use an alternate provider the caller has
 * configured and authorized, without granting a same-provider outer retry.
 */
export function shouldUseProviderFallback(err: unknown): boolean {
  if (err instanceof GeminiUnavailableError) return true;
  if (isTerminalMonthlyCap(err)) return true;
  return isRetryableProviderError(err);
}

export async function withProviderFallback<T>(params: {
  operation: string;
  primary: () => Promise<T>;
  fallback: (() => Promise<T>) | null | undefined;
  shouldFallback?: (err: unknown) => boolean;
  logger?: Logger;
}): Promise<T> {
  try {
    return await params.primary();
  } catch (err) {
    const shouldFallback = params.shouldFallback ?? shouldUseProviderFallback;
    if (!params.fallback || !shouldFallback(err)) throw err;

    params.logger?.warn({ err, operation: params.operation }, "Primary enrichment provider failed, using fallback");
    return params.fallback();
  }
}
