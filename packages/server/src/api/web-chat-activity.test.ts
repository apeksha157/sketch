import { describe, expect, it } from "vitest";
import { MAX_ACTIVITY_DETAIL_BYTES, MAX_COMPLETED_ACTIVITY_ITEMS, WebChatActivity } from "./web-chat-activity";

function command(detail = "pnpm test") {
  return {
    lines: ["Bash"],
    items: [
      {
        kind: "shell" as const,
        label: "Bash",
        icon: { type: "tool" as const, name: "Bash" },
        detail,
        mode: "technical" as const,
      },
    ],
  };
}

describe("WebChatActivity", () => {
  it("keeps same-name concurrent calls ordered and applies their actual independent outcomes", () => {
    const activity = new WebChatActivity("run");
    activity.start("a", 100, command());
    activity.start("b", 101, command());
    activity.finish("b", "failed", 200);
    activity.finish("a", "succeeded", 300);
    expect(activity.snapshot().map((part) => part.data.items?.[0])).toMatchObject([
      { id: "run:a", status: "succeeded", startedAt: 100, endedAt: 300 },
      { id: "run:b", status: "failed", startedAt: 101, endedAt: 200 },
    ]);
    expect(activity.start("a", 400, command())).toEqual([]);
    expect(activity.finish("a", "failed", 500)).toEqual([]);
    expect(activity.finish("unknown", "failed", 500)).toEqual([]);
  });

  it("marks unresolved calls interrupted without changing a known result", () => {
    const activity = new WebChatActivity("run");
    activity.start("a", 1, command());
    activity.start("b", 2, command());
    activity.finish("a", "succeeded", 3);
    expect(activity.finishPending("interrupted", 4)).toHaveLength(1);
    expect(activity.snapshot().map((part) => part.data.items?.[0]?.status)).toEqual(["succeeded", "interrupted"]);
  });

  it("enriches in place without regressing a completed invocation", () => {
    const activity = new WebChatActivity("run");
    activity.start("a", 1, command());
    activity.finish("a", "failed", 2);
    const originalRevision = activity.snapshot()[0].data.items?.[0]?.revision ?? 0;
    activity.enrich("a", {
      lines: ["Using GitHub"],
      items: [{ ...command().items[0], integration: { appId: "github", name: "GitHub" } }],
    });
    expect(activity.snapshot()[0].data.items?.[0]).toMatchObject({
      status: "failed",
      endedAt: 2,
      integration: { name: "GitHub" },
    });
    expect(activity.snapshot()[0].data.items?.[0]?.revision).toBeGreaterThan(originalRevision);
  });

  it("prunes completed detail first and tells live clients when detail is unavailable", () => {
    const activity = new WebChatActivity("run");
    activity.start("old", 1, command("x".repeat(MAX_ACTIVITY_DETAIL_BYTES)));
    activity.finish("old", "succeeded", 2);
    const updates = activity.start("active", 3, command("new command"));
    expect(updates).toContainEqual(
      expect.objectContaining({
        id: "run:old",
        data: { lines: ["Bash"], items: [expect.objectContaining({ detailUnavailable: true, status: "succeeded" })] },
      }),
    );
    expect(activity.snapshot()[0].data.items?.[0]?.detail).toBeUndefined();
    expect(activity.snapshot()[1].data.items?.[0]?.detail).toBe("new command");
  });

  it("bounds completed snapshots and emits a tombstone for an evicted row", () => {
    const activity = new WebChatActivity("run");
    activity.start("active", 1, command());
    let updates: ReturnType<WebChatActivity["finish"]> = [];
    for (let index = 0; index <= MAX_COMPLETED_ACTIVITY_ITEMS; index++) {
      activity.start(String(index), 2, command());
      updates = activity.finish(String(index), "succeeded", 3);
    }
    expect(activity.snapshot()).toHaveLength(MAX_COMPLETED_ACTIVITY_ITEMS + 1);
    expect(activity.snapshot()[0].id).toBe("run:active");
    expect(updates).toContainEqual({ type: "data-progress", id: "run:0", data: { lines: [], items: [] } });
  });
});
