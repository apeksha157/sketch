import { describe, expect, it } from "vitest";
import { ToolCircuitBreaker, type ToolOutcome, fingerprintToolError } from "./tool-circuit-breaker";

function breaker(overrides: Partial<ConstructorParameters<typeof ToolCircuitBreaker>[0]> = {}) {
  return new ToolCircuitBreaker({
    consecutiveIdenticalFailures: 3,
    totalErrorBudget: 15,
    terminalToolNames: ["Question"],
    ...overrides,
  });
}

function failure(toolName: string, errorFingerprint = "failed"): ToolOutcome {
  return { toolName, errorFingerprint };
}

describe("ToolCircuitBreaker", () => {
  it("trips after consecutive identical failures and stays tripped", () => {
    const subject = breaker();

    expect(subject.recordStep([failure("Read")]).newlyTripped).toEqual([]);
    expect(subject.recordStep([failure("Read")]).newlyTripped).toEqual([]);
    expect(subject.recordStep([failure("Read")]).newlyTripped).toEqual([{ toolName: "Read", fingerprint: "failed" }]);
    expect(subject.recordStep([failure("Read")]).newlyTripped).toEqual([]);
    expect(subject.trippedTools()).toEqual(["Read"]);
  });

  it("resets a tool streak on success or a different fingerprint", () => {
    const subject = breaker();

    subject.recordStep([failure("Read", "a"), failure("Read", "a"), failure("Read", "b")]);
    subject.recordStep([{ toolName: "Read", errorFingerprint: undefined }]);
    const result = subject.recordStep([failure("Read", "a"), failure("Read", "a")]);

    expect(result.newlyTripped).toEqual([]);
    expect(subject.totalErrors()).toBe(5);
  });

  it("counts terminal tool errors without tripping terminal tools", () => {
    const subject = breaker({ totalErrorBudget: 3 });

    const result = subject.recordStep([failure("Question"), failure("Question"), failure("Question")]);

    expect(result).toEqual({ newlyTripped: [], budgetJustExhausted: true });
    expect(subject.snapshot()).toEqual({ trippedTools: [], totalErrors: 3, budgetExhausted: true });
    expect(subject.activeTools(["Read", "Question"])).toEqual(["Question"]);
  });

  it("returns undefined active tools until constrained and removes only tripped tools", () => {
    const subject = breaker();

    expect(subject.activeTools(["Read", "Search", "Question"])).toBeUndefined();
    subject.recordStep([failure("Read"), failure("Read"), failure("Read")]);
    expect(subject.activeTools(["Read", "Search", "Question"])).toEqual(["Search", "Question"]);
  });
});

describe("fingerprintToolError", () => {
  it("uses thrown error names and messages with bounded normalization", () => {
    const fingerprint = fingerprintToolError(
      undefined,
      new TypeError(
        "  Request 401 failed for 550e8400-e29b-41d4-a716-446655440000 token abcdef0123456789abcdef0123456789  ",
      ),
    );

    expect(fingerprint).toBe("typeerror: request 401 failed for <id> token <id>");
  });

  it("joins MCP error text without conflating meaningful short numbers", () => {
    const output = {
      isError: true,
      content: [
        { type: "text", text: "HTTP 500" },
        { type: "image", data: "ignored" },
        { type: "text", text: " Retry 2" },
      ],
    };

    expect(fingerprintToolError(output, undefined)).toBe("http 500 retry 2");
    expect(fingerprintToolError({ isError: false, content: output.content }, undefined)).toBeUndefined();
  });
});
