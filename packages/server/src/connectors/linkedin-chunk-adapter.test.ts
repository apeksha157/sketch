import { describe, expect, it } from "vitest";
import { configSchema } from "../config";
import type { ConversationSliceFlushReason } from "../db/repositories/conversation-slices";
import { resolveChunkEngineKnobs } from "./config-default";
import {
  LINKEDIN_CHUNK_STREAM_KEY,
  createLinkedinChunkAdapter,
  parseLinkedinChunkRosterSnapshot,
  resolveLinkedinChunkEngineKnobs,
} from "./linkedin-chunk-adapter";

/** Mirrors the `conversation_slices.flush_reason` CHECK constraint (migration 176). */
const ALLOWED_FLUSH_REASONS: ConversationSliceFlushReason[] = ["gap", "max_age", "max_size", "llm_boundary"];

const roster = {
  accountId: "urn:li:account:owner",
  conversationUrn: "urn:li:conversation:42",
  leadId: "urn:li:lead:7",
  leadName: "Priya Nair",
  ownerName: "Owner",
};

function adapter() {
  return createLinkedinChunkAdapter({
    conversationId: 1,
    roster,
    knobs: resolveChunkEngineKnobs("LINKEDIN_CHUNK", undefined),
  });
}

describe("LinkedIn chunk adapter", () => {
  it("maps every flush kind onto a CHECK-valid reason", () => {
    const linkedin = adapter();
    const mapped = (["boundary", "idle", "force_split"] as const).map((kind) => linkedin.flushReason(kind));
    expect(mapped).toEqual(["llm_boundary", "gap", "max_size"]);
    for (const reason of mapped) expect(ALLOWED_FLUSH_REASONS).toContain(reason);
  });

  it("runs one row-id ordered LLM stream with the topic registry off", () => {
    const linkedin = adapter();
    expect(linkedin.streamKey).toBe(LINKEDIN_CHUNK_STREAM_KEY);
    expect(linkedin.providerThreadId).toBeNull();
    expect(linkedin.order).toBe("row_id");
    expect(linkedin.boundaries).toBe("llm");
    expect(linkedin.usesTopicRegistry).toBe(false);
    expect(linkedin.promptHeader).toContain("LinkedIn conversation boundary engine");
  });

  it("indexes only non-empty text and labels senders by name", () => {
    const linkedin = adapter();
    const message = {
      id: 1,
      providerMessageId: "m-1",
      effectiveAt: "2026-09-01T09:00:00.000Z",
      receivedAt: "2026-09-01T09:00:00.000Z",
      text: "Hello",
      attachments: null,
      isBot: false,
      senderName: "Priya Nair",
    };
    expect(linkedin.isIndexable(message)).toBe(true);
    expect(linkedin.isIndexable({ ...message, text: "   " })).toBe(false);
    expect(linkedin.senderLabel(message)).toBe("Priya Nair");
  });

  it("persists the emitter inputs in the roster snapshot", async () => {
    const serialized = await adapter().rosterSnapshot({} as never);
    expect(parseLinkedinChunkRosterSnapshot(serialized)).toEqual(roster);
  });

  it("rejects a roster snapshot that is missing a field", () => {
    expect(parseLinkedinChunkRosterSnapshot(null)).toBeNull();
    expect(parseLinkedinChunkRosterSnapshot("not json")).toBeNull();
    expect(parseLinkedinChunkRosterSnapshot("[]")).toBeNull();
    expect(parseLinkedinChunkRosterSnapshot(JSON.stringify({ ...roster, leadId: "" }))).toBeNull();
  });

  it("resolves knobs from the LINKEDIN_CHUNK prefix", () => {
    const defaults = resolveLinkedinChunkEngineKnobs(undefined);
    expect(defaults.minMessages).toBe(2);
    expect(defaults.idleCloseHours).toBe(720);
    expect(defaults.provisionalRefreshMessages).toBe(5);

    const overridden = resolveLinkedinChunkEngineKnobs(
      configSchema.parse({ ENCRYPTION_KEY: "x".repeat(64), LINKEDIN_CHUNK_MIN_MESSAGES: "9" }),
    );
    expect(overridden.minMessages).toBe(9);
  });
});
