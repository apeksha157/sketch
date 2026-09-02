import { automationAgentTraceSchema } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { AutomationAgentTraceRecorder } from "./agent-trace";

describe("AutomationAgentTraceRecorder", () => {
  it("keeps traces schema-valid while bounding payloads and redacting credentials", () => {
    const recorder = new AutomationAgentTraceRecorder("sketch", 1_000);
    recorder.addReasoning("x".repeat(20_000), "provider", 1_100);
    const eventId = recorder.startTool({
      toolName: "Read",
      input: {
        file_path: "notes.md",
        authorization: "Bearer secret-token-value",
        nested: { apiKey: "private-key", safe: "Bearer another-secret-value" },
      },
      startedAt: 1_200,
    });
    recorder.finishTool({
      eventId,
      output: { text: "sk-abcdefghijklmnop", count: 3 },
      outputCaptured: true,
      endedAt: 1_500,
    });
    recorder.complete({ completedAt: 1_600, model: "claude-test", stopReason: "end_turn", turns: 2 });

    expect(() => automationAgentTraceSchema.parse(recorder.trace)).not.toThrow();
    expect(recorder.trace.truncated).toBe(true);
    expect(recorder.trace.events[0]).toMatchObject({
      type: "reasoning",
      source: "provider",
      at: 1_100,
    });
    if (recorder.trace.events[0]?.type !== "reasoning") throw new Error("Expected a reasoning event");
    expect(recorder.trace.events[0].text.length).toBeLessThanOrEqual(12 * 1024);
    expect(recorder.trace.events[1]).toMatchObject({
      type: "tool_call",
      toolName: "Read",
      input: {
        file_path: "notes.md",
        authorization: "[redacted]",
        nested: { apiKey: "[redacted]", safe: "Bearer [redacted]" },
      },
      output: { text: "[redacted]", count: 3 },
      status: "completed",
      durationMs: 300,
      outputCaptured: true,
    });
  });
});
