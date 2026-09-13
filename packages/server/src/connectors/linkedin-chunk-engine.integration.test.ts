import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { ConversationSliceRow } from "../db/repositories/conversation-slices";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import type { AimfoxMessage } from "./aimfox-client";
import type { ChunkEngineKnobs } from "./chunk-engine";
import type { ChunkGenerate } from "./chunk-generate";
import { parseEmissionAnchor } from "./emission-refresh-tier";
import { LINKEDIN_CHUNK_STREAM_KEY, type LinkedinChunkRosterSnapshot } from "./linkedin-chunk-adapter";
import { runLinkedinChunkConversation } from "./linkedin-chunk-runner";
import { LINKEDIN_CONVERSATION_FILE_TYPE, emitLinkedinSyncedItems } from "./linkedin-emission";
import { ingestLinkedinConversation } from "./linkedin-ingest";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { SyncedItem } from "./types";

const ACCOUNT_ID = "urn:li:account:owner";
const CONVERSATION_URN = "urn:li:conversation:42";
const LEAD_ID = "urn:li:lead:7";
const CONNECTOR_TYPE = "linkedin_aimfox";

const roster: LinkedinChunkRosterSnapshot = {
  accountId: ACCOUNT_ID,
  conversationUrn: CONVERSATION_URN,
  leadId: LEAD_ID,
  leadName: "Priya Nair",
  ownerName: "Owner",
};

const knobs: ChunkEngineKnobs = {
  windowMessages: 2,
  windowTokens: 7_500,
  minMessages: 2,
  targetMessages: 25,
  maxMessages: 50,
  maxTokens: 4_000,
  tickMinutes: 30,
  idleCloseHours: 72,
  provisionalRefreshMessages: 5,
  model: null,
  reasoningEffort: "high",
  burstThresholdMessages: null,
  topicRegistryCap: 30,
  groupWorkerPool: 4,
  maxWindowsPerRun: 8,
};

function inbound(id: string, at: string, body: string): AimfoxMessage {
  return { id, body, created_at: Date.parse(at), sender: { id: LEAD_ID, full_name: "Priya Nair" } };
}

function outbound(id: string, at: string, body: string): AimfoxMessage {
  return { id, body, created_at: Date.parse(at), sender: { id: ACCOUNT_ID, full_name: "Owner" } };
}

/** Counts the numbered prompt lines the engine renders, so a stub can cover the whole window. */
function promptMessageCount(prompt: string): number {
  return [...prompt.matchAll(/^\d+\. /gm)].length;
}

/** Never splits: every window comes back as one topic segment. */
const singleTopic: ChunkGenerate = async (prompt) =>
  JSON.stringify({ segments: [{ start: 1, end: promptMessageCount(prompt), threads: ["outreach"] }] });

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>): void {
  describe(label, () => {
    let db!: Kysely<DB>;
    let connectorConfigId!: string;

    beforeEach(async () => {
      db = await createDb();
      const ownerId = `owner-${randomUUID()}`;
      await createUserRepository(db).create({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
      const config = await createConnectorRepository(db).createConfig({
        connectorType: CONNECTOR_TYPE,
        authType: "api_key",
        credentials: JSON.stringify({ type: "api_key", api_key: "k" }),
        scopeConfig: "{}",
        createdBy: ownerId,
      });
      connectorConfigId = config.id;
    }, 30_000);

    afterEach(async () => {
      await db.destroy();
    });

    async function ingest(messages: AimfoxMessage[], source: "history" | "live", receivedAt: string): Promise<number> {
      const result = await ingestLinkedinConversation({
        db,
        accountId: ACCOUNT_ID,
        conversationUrn: CONVERSATION_URN,
        leadName: roster.leadName,
        messages,
        source,
        receivedAt,
      });
      return result.conversationId;
    }

    async function runEngine(
      conversationId: number,
      now: string,
      generate: ChunkGenerate = singleTopic,
      knobOverrides: Partial<ChunkEngineKnobs> = {},
    ) {
      return runLinkedinChunkConversation({
        db,
        logger: createTestLogger(),
        now: new Date(now),
        conversationId,
        roster,
        knobs: { ...knobs, ...knobOverrides },
        generate,
      });
    }

    async function messageIds(conversationId: number): Promise<number[]> {
      const rows = await db
        .selectFrom("conversation_messages")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .orderBy("id", "asc")
        .execute();
      return rows.map((row) => row.id);
    }

    async function streamCursorMessageId(conversationId: number): Promise<number | null> {
      const row = await db
        .selectFrom("conversation_slice_stream_cursors")
        .select("last_message_id")
        .where("conversation_id", "=", conversationId)
        .where("stream_key", "=", LINKEDIN_CHUNK_STREAM_KEY)
        .executeTakeFirst();
      return row?.last_message_id ?? null;
    }

    /** Every message id a slice actually holds, so a skipped history row shows up as a hole. */
    function chunkedMessageIds(rows: ConversationSliceRow[]): number[] {
      return rows
        .flatMap((row) => JSON.parse(row.denoised_message_ids ?? "[]") as number[])
        .sort((left, right) => left - right);
    }

    async function slices(conversationId: number): Promise<ConversationSliceRow[]> {
      return db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .orderBy("first_message_id", "asc")
        .execute();
    }

    async function emitAndPersist(now: string): Promise<Array<{ item: SyncedItem; kind: string }>> {
      const results: Array<{ item: SyncedItem; kind: string }> = [];
      const repo = createConnectorRepository(db);
      for await (const item of emitLinkedinSyncedItems({
        db,
        logger: createTestLogger(),
        visibility: "owner",
        ownerEmail: "owner@example.com",
        refreshMessages: knobs.provisionalRefreshMessages,
        refreshMaxMinutes: 60,
        now: new Date(now),
      })) {
        const outcome = await processSyncedItem({
          db,
          repo,
          connectorConfigId,
          connectorType: CONNECTOR_TYPE,
          item,
          existingHashes: await loadExistingContentHashes(db, CONNECTOR_TYPE, connectorConfigId),
        });
        if (outcome.kind !== "skipped_empty" && item.conversationSliceId) {
          await db
            .updateTable("conversation_slices")
            .set({ indexed_file_id: outcome.indexedFileId, legacy_unjudged_at: null })
            .where("id", "=", item.conversationSliceId)
            .execute();
        }
        results.push({ item, kind: outcome.kind });
      }
      return results;
    }

    async function files() {
      return db
        .selectFrom("indexed_files")
        .select([
          "id",
          "provider_file_id",
          "thread_id",
          "file_name",
          "file_type",
          "rollup_group_id",
          "source_created_at",
          "source_updated_at",
          "source_meta",
          "summary_status",
          "content",
        ])
        .orderBy("source_created_at", "asc")
        .execute();
    }

    it("cuts a two-day reply into one topic and a later topic into another", async () => {
      const conversationId = await ingest(
        [
          outbound("m-1", "2026-09-01T09:00:00.000Z", "Loved your talk, can we compare notes on pricing?"),
          inbound("m-2", "2026-09-03T10:00:00.000Z", "Yes, pricing is exactly what we are wrestling with."),
          outbound("m-3", "2026-09-03T11:00:00.000Z", "Separately, who runs hiring on your side?"),
          inbound("m-4", "2026-09-03T11:05:00.000Z", "Hiring sits with Dev, I will introduce you."),
        ],
        "history",
        "2026-09-03T11:10:00.000Z",
      );

      /** Splits the pitch pair from the referral pair whenever both are in the window. */
      const twoTopics: ChunkGenerate = async (prompt) => {
        const count = promptMessageCount(prompt);
        return count >= 4
          ? JSON.stringify({
              segments: [
                { start: 1, end: 2, threads: ["pricing"] },
                { start: 3, end: count, threads: ["referral"] },
              ],
            })
          : JSON.stringify({ segments: [{ start: 1, end: count, threads: ["pricing"] }] });
      };

      await runEngine(conversationId, "2026-09-03T11:15:00.000Z", twoTopics);
      const cut = await slices(conversationId);
      expect(cut).toHaveLength(2);
      expect(cut[0]).toMatchObject({ status: "closed", flush_reason: "llm_boundary", message_count: 2 });
      expect(cut[1]).toMatchObject({ status: "open", message_count: 2 });

      const emitted = await emitAndPersist("2026-09-03T11:15:00.000Z");
      expect(emitted).toHaveLength(2);
      const indexed = await files();
      expect(indexed).toHaveLength(2);
      expect(indexed.map((file) => file.file_type)).toEqual([
        LINKEDIN_CONVERSATION_FILE_TYPE,
        LINKEDIN_CONVERSATION_FILE_TYPE,
      ]);
      expect(indexed.map((file) => file.thread_id)).toEqual([
        `${ACCOUNT_ID}:${CONVERSATION_URN}`,
        `${ACCOUNT_ID}:${CONVERSATION_URN}`,
      ]);
      expect(indexed.map((file) => file.rollup_group_id)).toEqual([
        `linkedin:${ACCOUNT_ID}:profile:${LEAD_ID}`,
        `linkedin:${ACCOUNT_ID}:profile:${LEAD_ID}`,
      ]);
      expect(indexed[0]).toMatchObject({
        source_created_at: "2026-09-01T09:00:00.000Z",
        source_updated_at: "2026-09-03T10:00:00.000Z",
      });
      expect(indexed[0]?.file_name).toBe("LinkedIn: Owner <> Priya Nair · 2026-09-01 to 2026-09-03");
      expect(indexed[1]).toMatchObject({
        source_created_at: "2026-09-03T11:00:00.000Z",
        source_updated_at: "2026-09-03T11:05:00.000Z",
      });
      expect(indexed[1]?.file_name).toBe("LinkedIn: Owner <> Priya Nair · 2026-09-03");
      const manifests = indexed.map(
        (file) =>
          (JSON.parse(file.source_meta ?? "{}") as { linkedinAimfox?: { segmentManifest?: unknown } }).linkedinAimfox
            ?.segmentManifest,
      );
      expect(manifests[0]).toMatchObject({ messageCount: 2, inboundCount: 1, outboundCount: 1 });
      expect(manifests[1]).toMatchObject({ messageCount: 2, inboundCount: 1, outboundCount: 1 });
    });

    it("closes the earlier slice in backfill mode when history holds a 20-day silence", async () => {
      const conversationId = await ingest(
        [
          outbound("m-1", "2026-08-01T09:00:00.000Z", "Opening note about the integration"),
          inbound("m-2", "2026-08-01T09:30:00.000Z", "Interesting, let me look"),
          inbound("m-3", "2026-08-21T10:00:00.000Z", "Sorry for the silence, different question now"),
          outbound("m-4", "2026-08-21T10:10:00.000Z", "No problem, happy to help"),
        ],
        "history",
        "2026-08-21T10:20:00.000Z",
      );

      await runEngine(conversationId, "2026-08-21T10:30:00.000Z");
      const cut = await slices(conversationId);
      expect(cut).toHaveLength(2);
      expect(cut[0]).toMatchObject({
        status: "closed",
        flush_reason: "gap",
        message_count: 2,
        started_at: "2026-08-01T09:00:00.000Z",
        ended_at: "2026-08-01T09:30:00.000Z",
      });
      expect(cut[1]).toMatchObject({ status: "open", message_count: 2, started_at: "2026-08-21T10:00:00.000Z" });
    });

    it("closes a re-ingested tail against its send time, not the time it was ingested", async () => {
      const conversationId = await ingest(
        [
          outbound("m-1", "2021-03-01T09:00:00.000Z", "Opening note from years ago"),
          inbound("m-2", "2021-03-01T09:30:00.000Z", "Not right now, thanks"),
        ],
        "history",
        "2026-09-01T10:00:00.000Z",
      );

      await runEngine(conversationId, "2026-09-01T10:05:00.000Z");

      const cut = await slices(conversationId);
      expect(cut).toHaveLength(1);
      expect(cut[0]).toMatchObject({ status: "closed", flush_reason: "gap" });
    });

    it("holds the 72-hour wall inside one production-sized backfill window", async () => {
      const conversationId = await ingest(
        [
          outbound("m-1", "2026-08-01T09:00:00.000Z", "Opening note about the integration"),
          inbound("m-2", "2026-08-01T09:30:00.000Z", "Interesting, let me look"),
          outbound("m-3", "2026-08-01T10:00:00.000Z", "Take your time"),
          inbound("m-4", "2026-08-21T10:00:00.000Z", "Sorry for the silence, different question now"),
          outbound("m-5", "2026-08-21T10:10:00.000Z", "No problem, happy to help"),
        ],
        "history",
        "2026-08-21T10:20:00.000Z",
      );

      const result = await runEngine(conversationId, "2026-08-21T10:30:00.000Z", singleTopic, {
        windowMessages: 250,
        maxWindowsPerRun: 4,
      });
      expect(result.historyPendingRemaining).toBe(false);

      const cut = await slices(conversationId);
      expect(cut).toHaveLength(2);
      expect(cut[0]).toMatchObject({
        status: "closed",
        flush_reason: "gap",
        message_count: 3,
        started_at: "2026-08-01T09:00:00.000Z",
        ended_at: "2026-08-01T10:00:00.000Z",
      });
      expect(cut[1]).toMatchObject({ status: "open", message_count: 2, started_at: "2026-08-21T10:00:00.000Z" });
      expect(chunkedMessageIds(cut)).toEqual(await messageIds(conversationId));
    });

    it("resumes a history backlog that outlived the window budget without skipping a row", async () => {
      const conversationId = await ingest(
        [
          outbound("m-1", "2026-09-01T09:00:00.000Z", "Opening pitch"),
          inbound("m-2", "2026-09-01T09:05:00.000Z", "Tell me more"),
          outbound("m-3", "2026-09-01T09:10:00.000Z", "Here is the detail"),
          inbound("m-4", "2026-09-01T09:15:00.000Z", "Works for me"),
        ],
        "history",
        "2026-09-01T09:20:00.000Z",
      );
      const ids = await messageIds(conversationId);

      const first = await runEngine(conversationId, "2026-09-01T09:25:00.000Z", singleTopic, { maxWindowsPerRun: 2 });
      expect(first).toMatchObject({ historyPendingRemaining: true, pendingRemaining: true, liveWindows: 0 });
      expect(first.backfillWindows).toBe(2);
      expect(chunkedMessageIds(await slices(conversationId))).toEqual(ids.slice(0, 3));
      expect(await streamCursorMessageId(conversationId)).toBe(ids[2]);

      const second = await runEngine(conversationId, "2026-09-01T09:30:00.000Z", singleTopic, { maxWindowsPerRun: 2 });
      expect(second.historyPendingRemaining).toBe(false);
      expect(chunkedMessageIds(await slices(conversationId))).toEqual(ids);
      expect(await streamCursorMessageId(conversationId)).toBe(ids[3]);
    });

    it("admits a live row only once the history backlog has drained", async () => {
      const conversationId = await ingest(
        [
          outbound("m-1", "2026-09-01T09:00:00.000Z", "Opening pitch"),
          inbound("m-2", "2026-09-01T09:05:00.000Z", "Tell me more"),
          outbound("m-3", "2026-09-01T09:10:00.000Z", "Here is the detail"),
          inbound("m-4", "2026-09-01T09:15:00.000Z", "Works for me"),
        ],
        "history",
        "2026-09-01T09:20:00.000Z",
      );
      await ingest(
        [inbound("m-5", "2026-09-01T09:25:00.000Z", "One more thought before the call")],
        "live",
        "2026-09-01T09:25:00.000Z",
      );
      const ids = await messageIds(conversationId);
      const liveId = ids[4];

      const first = await runEngine(conversationId, "2026-09-01T09:26:00.000Z", singleTopic, { maxWindowsPerRun: 2 });
      expect(first.historyPendingRemaining).toBe(true);
      expect(chunkedMessageIds(await slices(conversationId))).toEqual(ids.slice(0, 3));
      expect(chunkedMessageIds(await slices(conversationId))).not.toContain(liveId);

      const second = await runEngine(conversationId, "2026-09-01T09:27:00.000Z", singleTopic, { maxWindowsPerRun: 2 });
      expect(second.historyPendingRemaining).toBe(false);
      expect(second.liveWindows).toBe(1);
      const cut = await slices(conversationId);
      expect(cut).toHaveLength(1);
      expect(cut[0]).toMatchObject({ status: "open", message_count: 5 });
      expect(chunkedMessageIds(cut)).toEqual(ids);
    });

    it("gives the live tick only the windows the backfill loop left", async () => {
      const conversationId = await ingest(
        [
          outbound("m-1", "2026-09-01T09:00:00.000Z", "Opening pitch"),
          inbound("m-2", "2026-09-01T09:05:00.000Z", "Tell me more"),
        ],
        "history",
        "2026-09-01T09:06:00.000Z",
      );
      await ingest(
        [
          outbound("m-3", "2026-09-01T09:10:00.000Z", "Here is the detail"),
          inbound("m-4", "2026-09-01T09:15:00.000Z", "Works for me"),
        ],
        "live",
        "2026-09-01T09:15:00.000Z",
      );
      const ids = await messageIds(conversationId);

      const result = await runEngine(conversationId, "2026-09-01T09:20:00.000Z", singleTopic, { maxWindowsPerRun: 2 });
      expect(result).toMatchObject({
        historyPendingRemaining: false,
        backfillWindows: 1,
        liveWindows: 1,
        pendingRemaining: true,
      });
      expect(chunkedMessageIds(await slices(conversationId))).toEqual(ids.slice(0, 3));
    });

    it("skips the live tick when the backfill loop spent the whole window budget", async () => {
      const conversationId = await ingest(
        [
          outbound("m-1", "2026-09-01T09:00:00.000Z", "Opening pitch"),
          inbound("m-2", "2026-09-01T09:05:00.000Z", "Tell me more"),
          outbound("m-3", "2026-09-01T09:10:00.000Z", "Here is the detail"),
        ],
        "history",
        "2026-09-01T09:15:00.000Z",
      );
      await ingest(
        [inbound("m-4", "2026-09-01T09:20:00.000Z", "One more thought")],
        "live",
        "2026-09-01T09:20:00.000Z",
      );
      const ids = await messageIds(conversationId);

      const exhausted = await runEngine(conversationId, "2026-09-01T09:25:00.000Z", singleTopic, {
        maxWindowsPerRun: 2,
      });
      expect(exhausted).toMatchObject({
        historyPendingRemaining: false,
        backfillWindows: 2,
        liveWindows: 0,
        tickSkipped: true,
        pendingRemaining: true,
        skippedReason: "window_budget_exhausted",
      });
      expect(chunkedMessageIds(await slices(conversationId))).toEqual(ids.slice(0, 3));

      const drained = await runEngine(conversationId, "2026-09-01T09:30:00.000Z", singleTopic, { maxWindowsPerRun: 2 });
      expect(drained.liveWindows).toBe(1);
      expect(chunkedMessageIds(await slices(conversationId))).toEqual(ids);
    });

    it("re-enriches an unchanged open slice once the time gate expires with no new message", async () => {
      const conversationId = await ingest(
        [outbound("m-1", "2026-09-01T10:00:00.000Z", "Opening pitch about the pilot")],
        "history",
        "2026-09-01T10:00:00.000Z",
      );
      await runEngine(conversationId, "2026-09-01T10:05:00.000Z");
      const initial = await emitAndPersist("2026-09-01T10:05:00.000Z");
      expect(initial.map((entry) => entry.kind)).toEqual(["created"]);
      expect(initial[0]?.item.enrichmentRefresh).toBe("full");

      await ingest([inbound("m-2", "2026-09-01T10:40:00.000Z", "No thanks")], "live", "2026-09-01T10:40:00.000Z");
      await runEngine(conversationId, "2026-09-01T10:45:00.000Z");
      const tierOne = await emitAndPersist("2026-09-01T10:45:00.000Z");
      expect(tierOne[0]?.item.enrichmentRefresh).toBe("embeddings_only");
      expect(tierOne.map((entry) => entry.kind)).toEqual(["updated"]);

      await db.updateTable("indexed_files").set({ summary_status: "complete" }).execute();

      const tooEarly = await emitAndPersist("2026-09-01T11:00:00.000Z");
      expect(tooEarly).toEqual([]);

      const swept = await emitAndPersist("2026-09-01T11:50:00.000Z");
      expect(swept.map((entry) => entry.kind)).toEqual(["enrichment_refreshed"]);
      expect(swept[0]?.item.enrichmentRefresh).toBe("full");
      const after = await files();
      expect(after[0]?.summary_status).toBe("pending");
      expect(parseEmissionAnchor(after[0]?.source_meta ?? null)?.enrichedMessageCount).toBe(2);

      await db.updateTable("indexed_files").set({ summary_status: "complete" }).execute();
      expect(await emitAndPersist("2026-09-01T13:00:00.000Z")).toEqual([]);
    });

    it("lets only one of two racing ticks claim the stream", async () => {
      const conversationId = await ingest(
        [outbound("m-1", "2026-09-01T09:00:00.000Z", "First"), inbound("m-2", "2026-09-01T09:05:00.000Z", "Second")],
        "live",
        "2026-09-01T09:06:00.000Z",
      );
      const [left, right] = await Promise.all([
        runEngine(conversationId, "2026-09-01T09:10:00.000Z"),
        runEngine(conversationId, "2026-09-01T09:10:00.000Z"),
      ]);
      const claimed = [left, right].filter((result) => result.liveWindows > 0);
      expect(claimed).toHaveLength(1);
      const cut = await slices(conversationId);
      expect(cut).toHaveLength(1);
      expect(cut[0]).toMatchObject({ status: "open", message_count: 2 });
    });
  });
}

runSuite("LinkedIn chunk engine (sqlite)", createTestDb);
runSuite("LinkedIn chunk engine (postgres)", createTestPgDb);
