import { describe, expect, it } from "vitest";
import { userRequest } from "./cases";
import type { ProviderItem } from "./provider";
import { isBenchmarkWorkspaceOutput, reportMatches } from "./workspace-execution";

const items: ProviderItem[] = [
  { id: "open-one", title: "Sketch sample 1234 Plan launch", body: "", state: "open" },
  { id: "open-two", title: "Sketch sample 1234 Review copy", body: "", state: "open" },
  { id: "closed-one", title: "Sketch sample 1234 Archive notes", body: "", state: "closed" },
];

describe("workspace report matching", () => {
  it("recognizes recurring integration reports as benchmark-owned workspace outputs", () => {
    expect(isBenchmarkWorkspaceOutput("open-items-a1b2c3d4.txt")).toBe(true);
    expect(isBenchmarkWorkspaceOutput("team-notes.txt")).toBe(false);
    expect(isBenchmarkWorkspaceOutput("../open-items-a1b2c3d4.txt")).toBe(false);
  });

  it("asks Sketch for an ordinary list of names instead of IDs or JSON", () => {
    const request = userRequest({
      title: "List open tasks",
      integration: "clickup",
      operation: "list",
      prompt: 'Return JSON with {"count":1,"ids":["id"]} from {target} for {marker}.',
      facts: [],
      tags: [],
      selection: "open",
      openCount: 2,
      closedCount: 1,
      expectedText: "Ready for review",
    });

    expect(request).toContain("Tell me their names");
    expect(request).not.toMatch(/JSON|\bIDs?\b/i);
  });

  it("accepts an everyday list of the exact matching item names", () => {
    expect(
      reportMatches(
        "Here are the open tasks:\n- Sketch sample 1234 Plan launch\n- Sketch sample 1234 Review copy",
        items.slice(0, 2),
        items,
      ),
    ).toBe(true);
  });

  it("rejects a report that includes an item outside the requested selection", () => {
    expect(
      reportMatches(
        "Sketch sample 1234 Plan launch\nSketch sample 1234 Review copy\nSketch sample 1234 Archive notes",
        items.slice(0, 2),
        items,
      ),
    ).toBe(false);
  });

  it("keeps accepting legacy ID reports from already-saved cases", () => {
    expect(reportMatches('{"count":2,"ids":["open-two","open-one"]}', items.slice(0, 2), items)).toBe(true);
  });
});
