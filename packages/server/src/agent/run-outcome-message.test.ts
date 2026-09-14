import { describe, expect, it } from "vitest";
import { buildRunOutcomeMessage } from "./run-outcome-message";
import type { RunAgentResult } from "./runner";

function outcome(stopReason: string | null, budgetExhausted = false): Pick<RunAgentResult, "rawUsage"> {
  return {
    rawUsage: {
      stopReason,
      toolCircuitBreaker: budgetExhausted ? { trippedTools: [], totalErrors: 15, budgetExhausted: true } : undefined,
    } as RunAgentResult["rawUsage"],
  };
}

describe("buildRunOutcomeMessage", () => {
  it("appends the applicable incomplete warning to partial text", () => {
    expect(buildRunOutcomeMessage("Partial", outcome("max_turns"), null)).toBe(
      "Partial\n\n_I hit my step limit before finishing, so this may be incomplete._",
    );
    expect(buildRunOutcomeMessage("Partial", outcome("end_turn", true), null)).toBe(
      "Partial\n\n_Several tool calls failed, so this may be incomplete._",
    );
  });

  it("returns honest empty fallbacks and preserves the surface fallback otherwise", () => {
    expect(buildRunOutcomeMessage(null, outcome("max_turns"), null)).toContain("I hit my step limit");
    expect(buildRunOutcomeMessage(null, outcome("end_turn", true), null)).toContain("too many tool calls failed");
    expect(buildRunOutcomeMessage(null, outcome("end_turn"), "_No response_")).toBe("_No response_");
    expect(buildRunOutcomeMessage(null, outcome("end_turn"), null)).toBeNull();
  });
});
