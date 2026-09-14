export interface ToolCircuitBreakerOptions {
  consecutiveIdenticalFailures: number;
  totalErrorBudget: number;
  /** Never disabled by a trip and always kept active after budget exhaustion. Runtime namespaced names. */
  terminalToolNames: readonly string[];
}

export interface ToolOutcome {
  toolName: string;
  errorFingerprint: string | undefined;
}

interface ToolFailureStreak {
  fingerprint: string;
  count: number;
}

function errorTextFromMcpEnvelope(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const envelope = output as { isError?: unknown; content?: unknown };
  if (envelope.isError !== true || !Array.isArray(envelope.content)) return undefined;
  const text = envelope.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join(" ");
  return text || undefined;
}

function normalizeFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function fingerprintToolError(output: unknown, thrown: unknown): string | undefined {
  if (thrown !== undefined) {
    const text = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    return normalizeFingerprint(text);
  }
  const text = errorTextFromMcpEnvelope(output);
  return text ? normalizeFingerprint(text) : undefined;
}

export class ToolCircuitBreaker {
  readonly #options: ToolCircuitBreakerOptions;
  readonly #terminalTools: ReadonlySet<string>;
  readonly #streaks = new Map<string, ToolFailureStreak>();
  readonly #tripped = new Set<string>();
  #totalErrors = 0;
  #budgetExhausted = false;

  constructor(options: ToolCircuitBreakerOptions) {
    this.#options = options;
    this.#terminalTools = new Set(options.terminalToolNames);
  }

  recordStep(outcomes: readonly ToolOutcome[]): {
    newlyTripped: Array<{ toolName: string; fingerprint: string }>;
    budgetJustExhausted: boolean;
  } {
    const newlyTripped: Array<{ toolName: string; fingerprint: string }> = [];
    let budgetJustExhausted = false;

    for (const outcome of outcomes) {
      if (outcome.errorFingerprint === undefined) {
        this.#streaks.delete(outcome.toolName);
        continue;
      }

      this.#totalErrors += 1;
      if (!this.#budgetExhausted && this.#totalErrors >= this.#options.totalErrorBudget) {
        this.#budgetExhausted = true;
        budgetJustExhausted = true;
      }

      const previous = this.#streaks.get(outcome.toolName);
      const count = previous?.fingerprint === outcome.errorFingerprint ? previous.count + 1 : 1;
      this.#streaks.set(outcome.toolName, { fingerprint: outcome.errorFingerprint, count });
      if (
        count >= this.#options.consecutiveIdenticalFailures &&
        !this.#terminalTools.has(outcome.toolName) &&
        !this.#tripped.has(outcome.toolName)
      ) {
        this.#tripped.add(outcome.toolName);
        newlyTripped.push({ toolName: outcome.toolName, fingerprint: outcome.errorFingerprint });
      }
    }

    return { newlyTripped, budgetJustExhausted };
  }

  trippedTools(): readonly string[] {
    return [...this.#tripped];
  }

  budgetExhausted(): boolean {
    return this.#budgetExhausted;
  }

  totalErrors(): number {
    return this.#totalErrors;
  }

  activeTools(all: readonly string[]): readonly string[] | undefined {
    if (this.#budgetExhausted) {
      return all.filter((name) => this.#terminalTools.has(name));
    }
    return this.#tripped.size > 0 ? all.filter((name) => !this.#tripped.has(name)) : undefined;
  }

  snapshot(): { trippedTools: string[]; totalErrors: number; budgetExhausted: boolean } {
    return {
      trippedTools: [...this.#tripped],
      totalErrors: this.#totalErrors,
      budgetExhausted: this.#budgetExhausted,
    };
  }
}
