import { ApiError } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { withProviderBackoff } from "./chunk-engine-runner";
import { GeminiHttpError, GeminiUnavailableError } from "./gemini-control";

const MONTHLY_SPENDING_CAP_BODY = JSON.stringify({
  error: {
    code: 429,
    message: "Your project has exceeded its monthly spending cap.",
    status: "RESOURCE_EXHAUSTED",
  },
});

function backoffOptions() {
  return { logger: { warn: vi.fn() } as never, logContext: {}, message: "Chunk pass provider retry" };
}

describe("withProviderBackoff", () => {
  it("does not retry a raw monthly spending cap", async () => {
    let calls = 0;
    await expect(
      withProviderBackoff(async () => {
        calls++;
        throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
      }, backoffOptions()),
    ).rejects.toThrow("exceeded its monthly spending cap");
    expect(calls).toBe(1);
  });

  it("does not retry cached unavailability", async () => {
    let calls = 0;
    await expect(
      withProviderBackoff(async () => {
        calls++;
        throw new GeminiUnavailableError("provider_unavailable_cached");
      }, backoffOptions()),
    ).rejects.toThrow("Gemini unavailable");
    expect(calls).toBe(1);
  });

  it("does not retry the raw Google SDK monthly-cap error", async () => {
    let calls = 0;
    await expect(
      withProviderBackoff(async () => {
        calls++;
        throw new ApiError({ status: 429, message: MONTHLY_SPENDING_CAP_BODY });
      }, backoffOptions()),
    ).rejects.toThrow("exceeded its monthly spending cap");
    expect(calls).toBe(1);
  });

  it("still retries transient server errors", async () => {
    let calls = 0;
    const result = await withProviderBackoff(async () => {
      calls++;
      if (calls === 1) throw new GeminiHttpError(503, "upstream unavailable");
      return "ok";
    }, backoffOptions());
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("still retries an ordinary 429", async () => {
    let calls = 0;
    const result = await withProviderBackoff(async () => {
      calls++;
      if (calls === 1) throw new GeminiHttpError(429, "RESOURCE_EXHAUSTED. Quota exceeded.");
      return "ok";
    }, backoffOptions());
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});
