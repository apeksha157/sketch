import type { AutomationAgentTrace, AutomationAgentTraceToolCallEvent } from "@sketch/shared";

const MAX_TRACE_EVENTS = 200;
const MAX_TRACE_BYTES = 512 * 1024;
const MAX_TRACE_VALUE_BYTES = 12 * 1024;
const MAX_TRACE_DEPTH = 7;
const MAX_TRACE_COLLECTION_ITEMS = 80;
const sensitiveKeyPattern = /(?:password|passphrase|secret|token|authorization|cookie|private[_-]?key|api[_-]?key)/i;

type TraceRuntime = AutomationAgentTrace["runtime"];
type TraceUsage = NonNullable<AutomationAgentTrace["usage"]>;

function redactString(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\b(sk-[a-z0-9_-]{12,})\b/gi, "[redacted]");
}

function boundedTraceText(value: string): string {
  const redacted = redactString(value);
  return redacted.length <= MAX_TRACE_VALUE_BYTES ? redacted : redacted.slice(0, MAX_TRACE_VALUE_BYTES);
}

function projectTraceValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (depth >= MAX_TRACE_DEPTH) return "[depth limit reached]";
  if (!value || typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_TRACE_COLLECTION_ITEMS).map((item) => projectTraceValue(item, depth + 1, seen));
    if (value.length > MAX_TRACE_COLLECTION_ITEMS) {
      items.push(`[${value.length - MAX_TRACE_COLLECTION_ITEMS} more items]`);
    }
    return items;
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_TRACE_COLLECTION_ITEMS);
  for (const [key, entry] of entries) {
    result[key] = sensitiveKeyPattern.test(key) ? "[redacted]" : projectTraceValue(entry, depth + 1, seen);
  }
  const extraKeys = Object.keys(value).length - entries.length;
  if (extraKeys > 0) result.$truncated = `${extraKeys} more fields`;
  return result;
}

function capTraceValue(value: unknown): unknown {
  const projected = projectTraceValue(value);
  const serialized = JSON.stringify(projected);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_TRACE_VALUE_BYTES) return projected;
  return {
    $truncated: true,
    preview: serialized.slice(0, MAX_TRACE_VALUE_BYTES),
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class AutomationAgentTraceRecorder {
  readonly trace: AutomationAgentTrace;
  readonly #externalToolIds = new Map<string, string>();
  #nextEventId = 1;
  #eventBytes = 0;

  constructor(runtime: TraceRuntime, startedAt = Date.now()) {
    this.trace = {
      version: 1,
      runtime,
      model: null,
      startedAt,
      completedAt: null,
      stopReason: null,
      turns: null,
      usage: null,
      events: [],
      truncated: false,
    };
  }

  addReasoning(text: string, source: "provider" | "assistant", at = Date.now()): void {
    if (!text) return;
    const redactedText = redactString(text);
    const last = this.trace.events.at(-1);
    if (last?.type === "reasoning" && last.source === source) {
      const mergedText = `${last.text}${redactedText}`;
      const boundedText = boundedTraceText(mergedText);
      if (boundedText.length < mergedText.length) this.trace.truncated = true;
      const next = { ...last, text: boundedText };
      const nextBytes = serializedBytes(next);
      const previousBytes = serializedBytes(last);
      if (this.#eventBytes - previousBytes + nextBytes <= MAX_TRACE_BYTES) {
        last.text = next.text;
        this.#eventBytes = this.#eventBytes - previousBytes + nextBytes;
      } else {
        this.trace.truncated = true;
      }
      return;
    }

    const boundedText = boundedTraceText(redactedText);
    if (boundedText.length < redactedText.length) this.trace.truncated = true;

    this.#appendEvent({
      id: this.#eventId("reasoning"),
      type: "reasoning",
      text: boundedText,
      source,
      at,
    });
  }

  startTool(params: {
    toolName: string;
    input?: unknown;
    skillName?: string | null;
    startedAt?: number;
    externalId?: string | null;
  }): string | null {
    const id = this.#eventId("tool");
    const event: AutomationAgentTraceToolCallEvent = {
      id,
      type: "tool_call",
      toolName: params.toolName,
      skillName: params.skillName ?? null,
      ...(params.input === undefined ? {} : { input: capTraceValue(params.input) }),
      status: "running",
      startedAt: params.startedAt ?? Date.now(),
      endedAt: null,
      durationMs: null,
      outputCaptured: false,
    };
    if (!this.#appendEvent(event)) return null;
    if (params.externalId) this.#externalToolIds.set(params.externalId, id);
    return id;
  }

  finishTool(params: {
    eventId?: string | null;
    externalId?: string | null;
    toolName?: string;
    output?: unknown;
    outputCaptured?: boolean;
    errorMessage?: string;
    endedAt?: number;
    durationMs?: number;
  }): void {
    const event = this.#findToolEvent(params);
    if (!event) return;
    const previousBytes = serializedBytes(event);
    const endedAt = params.endedAt ?? Date.now();
    const next: AutomationAgentTraceToolCallEvent = {
      ...event,
      ...(params.outputCaptured ? { output: capTraceValue(params.output) } : {}),
      status: params.errorMessage ? "failed" : "completed",
      endedAt,
      durationMs: params.durationMs ?? Math.max(0, endedAt - event.startedAt),
      ...(params.errorMessage ? { errorMessage: boundedTraceText(params.errorMessage) } : {}),
      outputCaptured: params.outputCaptured ?? false,
    };
    let nextBytes = serializedBytes(next);
    if (this.#eventBytes - previousBytes + nextBytes > MAX_TRACE_BYTES) {
      next.output = undefined;
      next.outputCaptured = false;
      this.trace.truncated = true;
      nextBytes = serializedBytes(next);
    }
    if (this.#eventBytes - previousBytes + nextBytes > MAX_TRACE_BYTES) {
      next.input = undefined;
      if (next.errorMessage) next.errorMessage = "Tool failed";
      nextBytes = serializedBytes(next);
    }
    Object.assign(event, next);
    this.#eventBytes = this.#eventBytes - previousBytes + nextBytes;
  }

  reconcileTool(
    eventId: string,
    params: {
      skillName?: string | null;
      startedAt: number;
      endedAt: number;
      success?: boolean;
      errorMessage?: string;
    },
  ): void {
    const event = this.trace.events.find(
      (candidate): candidate is AutomationAgentTraceToolCallEvent =>
        candidate.type === "tool_call" && candidate.id === eventId,
    );
    if (!event) return;
    const previousBytes = serializedBytes(event);
    event.skillName = params.skillName ?? event.skillName;
    event.startedAt = params.startedAt;
    event.endedAt = params.endedAt;
    event.durationMs = Math.max(0, params.endedAt - params.startedAt);
    event.status = params.success === false || params.errorMessage ? "failed" : "completed";
    if (params.errorMessage) event.errorMessage = boundedTraceText(params.errorMessage);
    let nextBytes = serializedBytes(event);
    if (this.#eventBytes - previousBytes + nextBytes > MAX_TRACE_BYTES) {
      event.input = undefined;
      event.output = undefined;
      event.outputCaptured = false;
      this.trace.truncated = true;
      nextBytes = serializedBytes(event);
    }
    if (this.#eventBytes - previousBytes + nextBytes > MAX_TRACE_BYTES && event.errorMessage) {
      event.errorMessage = "Tool failed";
      nextBytes = serializedBytes(event);
    }
    this.#eventBytes = this.#eventBytes - previousBytes + nextBytes;
  }

  complete(params: {
    completedAt?: number;
    model?: string | null;
    stopReason?: string | null;
    turns?: number | null;
    usage?: TraceUsage | null;
  }): void {
    this.trace.completedAt = params.completedAt ?? Date.now();
    this.trace.model = params.model ?? this.trace.model;
    this.trace.stopReason = params.stopReason ?? this.trace.stopReason;
    this.trace.turns = params.turns ?? this.trace.turns;
    this.trace.usage = params.usage ?? this.trace.usage;
    for (const event of this.trace.events) {
      if (event.type !== "tool_call" || event.status !== "running") continue;
      this.finishTool({ eventId: event.id, endedAt: this.trace.completedAt });
    }
  }

  fail(error: unknown, stopReason = "error"): void {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = Date.now();
    for (const event of this.trace.events) {
      if (event.type !== "tool_call" || event.status !== "running") continue;
      this.finishTool({ eventId: event.id, endedAt: completedAt, errorMessage: message });
    }
    this.complete({ completedAt, stopReason });
  }

  #findToolEvent(params: {
    eventId?: string | null;
    externalId?: string | null;
    toolName?: string;
  }): AutomationAgentTraceToolCallEvent | undefined {
    const id = params.eventId ?? (params.externalId ? this.#externalToolIds.get(params.externalId) : undefined);
    if (id) {
      return this.trace.events.find(
        (event): event is AutomationAgentTraceToolCallEvent => event.type === "tool_call" && event.id === id,
      );
    }
    return [...this.trace.events]
      .reverse()
      .find(
        (event): event is AutomationAgentTraceToolCallEvent =>
          event.type === "tool_call" &&
          event.status === "running" &&
          (!params.toolName || event.toolName === params.toolName),
      );
  }

  #appendEvent(event: AutomationAgentTrace["events"][number]): boolean {
    const bytes = serializedBytes(event);
    if (this.trace.events.length >= MAX_TRACE_EVENTS || this.#eventBytes + bytes > MAX_TRACE_BYTES) {
      this.trace.truncated = true;
      return false;
    }
    this.trace.events.push(event);
    this.#eventBytes += bytes;
    return true;
  }

  #eventId(prefix: string): string {
    const id = `${prefix}-${this.#nextEventId}`;
    this.#nextEventId += 1;
    return id;
  }
}
