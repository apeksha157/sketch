import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { GeminiHttpError, GeminiUnavailableError } from "./gemini-control";
import { shouldRetryProviderOperation, shouldUseProviderFallback, withProviderFallback } from "./provider-fallback";

const MONTHLY_SPENDING_CAP_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.",
    status: "RESOURCE_EXHAUSTED",
  },
});

describe("provider fallback", () => {
  it("falls back for Gemini quota failures", async () => {
    const result = await withProviderFallback({
      operation: "embedTexts",
      primary: async () => {
        throw new GeminiHttpError(429, "RESOURCE_EXHAUSTED");
      },
      fallback: async () => "ok",
    });

    expect(result).toBe("ok");
  });

  it("falls back for a raw monthly spending-cap refusal", async () => {
    const result = await withProviderFallback({
      operation: "generateJSON",
      primary: async () => {
        throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
      },
      fallback: async () => "fallback",
    });

    expect(result).toBe("fallback");
  });

  it("falls back for cached Gemini unavailability", async () => {
    const result = await withProviderFallback({
      operation: "generateJSON",
      primary: async () => {
        throw new GeminiUnavailableError("monthly_cap_cached");
      },
      fallback: async () => "fallback",
    });

    expect(result).toBe("fallback");
  });

  it("falls back for the raw Google SDK monthly-cap error", async () => {
    const result = await withProviderFallback({
      operation: "generate",
      primary: async () => {
        throw new ApiError({ status: 429, message: MONTHLY_SPENDING_CAP_BODY });
      },
      fallback: async () => "fallback",
    });

    expect(result).toBe("fallback");
  });

  it("does not fall back for non-retryable failures", async () => {
    await expect(
      withProviderFallback({
        operation: "generateJSON",
        primary: async () => {
          throw new Error("failed to parse JSON response");
        },
        fallback: async () => "ok",
      }),
    ).rejects.toThrow("failed to parse JSON response");
  });
});

describe("provider retry classification", () => {
  it("classifies non-cap failures as retryable and fallback-eligible", () => {
    expect(shouldRetryProviderOperation(new Error("fetch failed"))).toBe(true);
    expect(shouldRetryProviderOperation(new Error("prepayment credits are depleted"))).toBe(true);
    expect(shouldRetryProviderOperation(new GeminiHttpError(500, "server error"))).toBe(true);
    expect(shouldRetryProviderOperation(new GeminiHttpError(400, "API_KEY_INVALID"))).toBe(true);
    expect(shouldRetryProviderOperation(new Error("invalid api key"))).toBe(true);

    expect(shouldUseProviderFallback(new Error("fetch failed"))).toBe(true);
    expect(shouldUseProviderFallback(new GeminiHttpError(500, "server error"))).toBe(true);
  });

  it("keeps ordinary 429 and generic RESOURCE_EXHAUSTED retryable", () => {
    expect(shouldRetryProviderOperation(new GeminiHttpError(429, "RESOURCE_EXHAUSTED. Quota exceeded."))).toBe(true);
    expect(shouldRetryProviderOperation(new Error("resource_exhausted"))).toBe(true);
  });

  it("does not retry the raw monthly spending cap but still allows fallback", () => {
    const cap = new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
    expect(shouldRetryProviderOperation(cap)).toBe(false);
    expect(shouldUseProviderFallback(cap)).toBe(true);
  });

  it("does not retry cached unavailability but still allows fallback", () => {
    const cached = new GeminiUnavailableError("provider_unavailable_cached");
    expect(shouldRetryProviderOperation(cached)).toBe(false);
    expect(shouldUseProviderFallback(cached)).toBe(true);
  });

  it("does not retry the raw Google SDK monthly-cap error but still allows fallback", () => {
    const cap = new ApiError({ status: 429, message: MONTHLY_SPENDING_CAP_BODY });
    expect(shouldRetryProviderOperation(cap)).toBe(false);
    expect(shouldUseProviderFallback(cap)).toBe(true);
  });
});
