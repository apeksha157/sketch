import { describe, expect, it } from "vitest";
import { AgentRuntimeProviderError, ModelRequestTimeoutError, isRuntimeAbortError } from "./errors";

describe("runtime abort errors", () => {
  it("does not classify a model request timeout as a runtime abort", () => {
    const timeout = new ModelRequestTimeoutError();
    const signal = AbortSignal.abort(timeout);

    expect(isRuntimeAbortError(timeout, signal)).toBe(false);
  });

  it("does not classify a nested model request timeout as a runtime abort", () => {
    const timeout = new ModelRequestTimeoutError();
    const wrapped = new AgentRuntimeProviderError({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      message: "provider failed",
      cause: timeout,
    });

    expect(isRuntimeAbortError(wrapped, AbortSignal.abort())).toBe(false);
  });

  it("still classifies a genuine user abort as a runtime abort", () => {
    const userAbort = new DOMException("user stopped", "AbortError");

    expect(isRuntimeAbortError(userAbort, AbortSignal.abort(userAbort))).toBe(true);
  });

  it("does not classify an aborted message without an aborted signal", () => {
    expect(isRuntimeAbortError(new Error("stream aborted by upstream"))).toBe(false);
    expect(isRuntimeAbortError(new Error("Claude Code process aborted by user"))).toBe(false);
  });

  it("classifies a plain Claude SDK abort message when the caller signal is aborted", () => {
    expect(isRuntimeAbortError(new Error("Claude Code process aborted by user"), AbortSignal.abort())).toBe(true);
  });

  it("classifies direct and wrapped AbortError instances", () => {
    const abort = new DOMException("cancelled", "AbortError");
    const wrapped = new Error("provider wrapper", { cause: abort });

    expect(isRuntimeAbortError(abort)).toBe(true);
    expect(isRuntimeAbortError(wrapped)).toBe(true);
  });

  it("keeps timeout precedence when it wraps an AbortError", () => {
    const timeout = new ModelRequestTimeoutError(new DOMException("cancelled", "AbortError"));

    expect(isRuntimeAbortError(timeout, AbortSignal.abort())).toBe(false);
  });
});
