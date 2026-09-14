import type { RawRunUsage } from "./runner";

export function buildRunOutcomeMessage(
  text: string | null,
  result: { rawUsage?: Pick<RawRunUsage, "stopReason" | "toolCircuitBreaker"> },
  emptyFallback: string | null,
): string | null {
  const reachedStepLimit = result.rawUsage?.stopReason === "max_turns";
  const exhaustedErrorBudget = result.rawUsage?.toolCircuitBreaker?.budgetExhausted === true;
  if (text) {
    if (reachedStepLimit) return `${text}\n\n_I hit my step limit before finishing, so this may be incomplete._`;
    if (exhaustedErrorBudget) return `${text}\n\n_Several tool calls failed, so this may be incomplete._`;
    return text;
  }
  if (reachedStepLimit) return "_I couldn't finish this one: I hit my step limit. Try a narrower ask._";
  if (exhaustedErrorBudget) return "_I couldn't finish this one: too many tool calls failed. Try a narrower ask._";
  return emptyFallback;
}
