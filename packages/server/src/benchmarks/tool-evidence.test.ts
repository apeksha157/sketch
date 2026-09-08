import { describe, expect, it } from "vitest";
import { benchmarkReadEvidence } from "./tool-evidence";

describe("evaluated integration read evidence", () => {
  it("accepts completed managed read task identities without persisting provider content", () => {
    expect(
      benchmarkReadEvidence({
        toolName: "mcp__sketch__clickup_api",
        input: { method: "GET", path: "/list/1/task" },
        output: {
          content: [{ type: "text", text: JSON.stringify({ tasks: [{ id: "task1", description: "private body" }] }) }],
        },
        isError: false,
      }),
    ).toEqual({ taskIds: ["task1"] });
  });
  it("supports the SDK runtime content-array result shape", () => {
    expect(
      benchmarkReadEvidence({
        toolName: "mcp__sketch__clickup_api",
        input: { method: "GET" },
        output: [{ type: "text", text: '{"tasks":[{"id":"sdk-task"}]}' }],
        isError: false,
      }),
    ).toEqual({ taskIds: ["sdk-task"] });
  });
  it("rejects completion claims, tool failures and writes", () => {
    const base = { toolName: "clickup_api", input: { method: "GET" }, output: "3", isError: false };
    expect(benchmarkReadEvidence(base)).toBeNull();
    expect(benchmarkReadEvidence({ ...base, output: "ClickUp API failed: unavailable" })).toBeNull();
    expect(benchmarkReadEvidence({ ...base, output: { tasks: [{ id: "one" }] }, isError: true })).toBeNull();
    expect(
      benchmarkReadEvidence({ ...base, input: { method: "POST" }, output: { tasks: [{ id: "one" }] } }),
    ).toBeNull();
    expect(benchmarkReadEvidence({ ...base, toolName: "Bash", output: { tasks: [{ id: "one" }] } })).toBeNull();
  });
});
