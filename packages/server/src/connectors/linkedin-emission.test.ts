import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { AimfoxMessage } from "./aimfox-client";
import { buildEmissionAnchor, parseEmissionAnchor } from "./emission-refresh-tier";
import { orderLinkedinMessages, segmentDirectionStats } from "./linkedin-aimfox";
import type { LinkedinChunkRosterSnapshot } from "./linkedin-chunk-adapter";
import {
  LINKEDIN_CONVERSATION_FILE_TYPE,
  type LinkedinEmissionSkipReason,
  emitLinkedinSyncedItems,
} from "./linkedin-emission";
import { ingestLinkedinConversation } from "./linkedin-ingest";
import type { SyncedItem } from "./types";

const ACCOUNT_ID = "urn:li:account:owner";
const CONVERSATION_URN = "urn:li:conversation:42";
const LEAD_ID = "urn:li:lead:7";

const roster: LinkedinChunkRosterSnapshot = {
  accountId: ACCOUNT_ID,
  conversationUrn: CONVERSATION_URN,
  leadId: LEAD_ID,
  leadName: "Priya Nair",
  ownerName: "Owner",
};

function inbound(id: string, createdAt: number, body: string): AimfoxMessage {
  return { id, body, created_at: createdAt, sender: { id: LEAD_ID, full_name: "Priya Nair" } };
}

function outbound(id: string, createdAt: number, body: string): AimfoxMessage {
  return { id, body, created_at: createdAt, sender: { id: ACCOUNT_ID, full_name: "Owner" } };
}

describe("LinkedIn slice emission", () => {
  let db!: Kysely<DB>;
  let connectorConfigId!: string;

  beforeEach(async () => {
    db = await createTestDb();
    await createUserRepository(db).create({ id: "owner", name: "Owner", email: "owner@example.com" });
    const config = await createConnectorRepository(db).createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "k" }),
      scopeConfig: "{}",
      createdBy: "owner",
    });
    connectorConfigId = config.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedSlice(
    messages: AimfoxMessage[],
    options: { status?: "open" | "closed"; rosterSnapshot?: string } = {},
  ): Promise<{ sliceId: string; conversationId: number; messageIds: number[] }> {
    const { conversationId } = await ingestLinkedinConversation({
      db,
      accountId: ACCOUNT_ID,
      conversationUrn: CONVERSATION_URN,
      leadName: roster.leadName,
      messages,
      source: "history",
      receivedAt: "2026-09-11T10:00:00.000Z",
    });
    const rows = await db
      .selectFrom("conversation_messages")
      .select(["id", "effective_at"])
      .where("conversation_id", "=", conversationId)
      .orderBy("id", "asc")
      .execute();
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) throw new Error("no messages seeded");
    const slice = await createConversationSlicesRepository(db).insertIfAbsent({
      id: randomUUID(),
      conversationId,
      firstMessageId: first.id,
      lastMessageId: last.id,
      startedAt: first.effective_at ?? "",
      endedAt: last.effective_at ?? "",
      messageCount: rows.length,
      denoisedMessageIds: rows.map((row) => row.id),
      flushReason: "llm_boundary",
      rosterSnapshot: options.rosterSnapshot ?? JSON.stringify(roster),
      salienceVerdict: "kept",
      status: options.status ?? "closed",
    });
    return { sliceId: slice.row.id, conversationId, messageIds: rows.map((row) => row.id) };
  }

  async function emit(
    options: { now?: Date; minMessages?: number; refreshMaxMinutes?: number } = {},
  ): Promise<{ items: SyncedItem[]; skips: LinkedinEmissionSkipReason[] }> {
    const skips: LinkedinEmissionSkipReason[] = [];
    const items: SyncedItem[] = [];
    for await (const item of emitLinkedinSyncedItems({
      db,
      logger: createTestLogger(),
      visibility: "owner",
      ownerEmail: "owner@example.com",
      refreshMessages: 5,
      refreshMaxMinutes: options.refreshMaxMinutes ?? 60,
      ...(options.minMessages !== undefined ? { minMessages: options.minMessages } : {}),
      now: options.now ?? new Date("2026-09-11T12:00:00.000Z"),
      onSkipReason: (reason) => skips.push(reason),
    })) {
      items.push(item);
    }
    return { items, skips };
  }

  async function linkFile(
    sliceId: string,
    input: { contentHash: string; sourceMeta: Record<string, unknown> },
  ): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: connectorConfigId,
        provider_file_id: sliceId,
        file_name: "LinkedIn",
        file_type: LINKEDIN_CONVERSATION_FILE_TYPE,
        content_category: "document",
        content: "irrelevant",
        source: "linkedin_aimfox",
        source_meta: JSON.stringify(input.sourceMeta),
        content_hash: input.contentHash,
        synced_at: "2026-09-11T10:00:00.000Z",
      })
      .execute();
    await db.updateTable("conversation_slices").set({ indexed_file_id: id }).where("id", "=", sliceId).execute();
    return id;
  }

  it("stamps the thread id, rollup id, path and principals the legacy segment stamped", async () => {
    const messages = [outbound("m-1", 1_756_800_000_000, "The pitch"), inbound("m-2", 1_757_000_200_000, "Interested")];
    await seedSlice(messages);
    const { items } = await emit();
    expect(items).toHaveLength(1);
    const item = items[0];
    if (!item) throw new Error("no item");
    expect(item.threadId).toBe(`${ACCOUNT_ID}:${CONVERSATION_URN}`);
    expect(item.rollupGroupId).toBe(`linkedin:${ACCOUNT_ID}:profile:${LEAD_ID}`);
    expect(item.fileType).toBe(LINKEDIN_CONVERSATION_FILE_TYPE);
    expect(item.sourcePath).toBe("LinkedIn / Priya Nair");
    expect(item.accessPrincipals).toEqual([{ type: "email", value: "owner@example.com" }]);
    expect(item.accessScope).toBeUndefined();
    expect(item.conversationSliceId).toBe(item.providerFileId);
    expect(item.content).toContain("LinkedIn conversation: Owner <> Priya Nair");
    expect(item.parentEntities).toEqual([
      { source: "aimfox", sourceId: LEAD_ID, contextSnippet: "LinkedIn conversation with Priya Nair" },
    ]);
  });

  it("writes a manifest whose counts equal the legacy direction stats over the same messages", async () => {
    const messages = [
      outbound("m-1", 1_756_800_000_000, "The pitch"),
      inbound("m-2", 1_757_000_200_000, "Interested"),
      outbound("m-3", 1_757_000_300_000, "Booking a call"),
    ];
    await seedSlice(messages);
    const { items } = await emit();
    const meta = items[0]?.sourceMeta as { linkedinAimfox?: { segmentManifest?: unknown } } | undefined;
    const legacy = segmentDirectionStats(orderLinkedinMessages(CONVERSATION_URN, messages), ACCOUNT_ID);
    expect(meta?.linkedinAimfox?.segmentManifest).toEqual({ messageCount: 3, ...legacy });
  });

  it("renders the automated tag from is_bot and still counts the message outbound", async () => {
    const campaign: AimfoxMessage = {
      id: "m-1",
      body: "Campaign opener",
      created_at: 1_756_800_000_000,
      sender: { id: ACCOUNT_ID, full_name: "Owner" },
      automated: true,
    };
    await seedSlice([campaign, inbound("m-2", 1_757_000_200_000, "Interested")]);
    const { items } = await emit();
    expect(items[0]?.content).toContain("Owner (automated): Campaign opener");
    expect(items[0]?.content).toContain("Priya Nair: Interested");
    expect(items[0]?.content).not.toContain("Priya Nair (automated)");
    const meta = items[0]?.sourceMeta as { linkedinAimfox?: { segmentManifest?: unknown } } | undefined;
    expect(meta?.linkedinAimfox?.segmentManifest).toMatchObject({
      messageCount: 2,
      inboundCount: 1,
      outboundCount: 1,
    });
  });

  it("keeps the emission anchor at the root of source_meta", async () => {
    await seedSlice([outbound("m-1", 1_756_800_000_000, "The pitch"), inbound("m-2", 1_757_000_200_000, "Yes")]);
    const { items } = await emit();
    const sourceMeta = JSON.stringify(items[0]?.sourceMeta);
    const anchor = parseEmissionAnchor(sourceMeta);
    expect(anchor).not.toBeNull();
    expect(anchor?.messageCount).toBe(2);
    expect(anchor?.enrichedMessageCount).toBe(2);
    const nested = (items[0]?.sourceMeta as { linkedinAimfox?: Record<string, unknown> }).linkedinAimfox;
    expect(nested).toMatchObject({
      accountId: ACCOUNT_ID,
      conversationUrn: CONVERSATION_URN,
      kind: "conversation_slice",
    });
  });

  it("leaves source_updated_at on the last dated message when the tail is undated", async () => {
    await seedSlice([
      outbound("m-1", 1_756_800_000_000, "The pitch"),
      inbound("m-2", 1_757_000_200_000, "Interested"),
      inbound("m-3", Number.NaN, "undated tail"),
    ]);
    const { items } = await emit();
    expect(items[0]?.sourceCreatedAt).toBe(new Date(1_756_800_000_000).toISOString());
    expect(items[0]?.sourceUpdatedAt).toBe(new Date(1_757_000_200_000).toISOString());
  });

  it("emits a one-message open slice, below the engine floor", async () => {
    await seedSlice([inbound("m-1", 1_757_000_200_000, "Not interested, but ask me about X")], { status: "open" });
    const { items, skips } = await emit();
    expect(skips).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]?.enrichmentRefresh).toBe("full");
  });

  it("skips an open slice under an explicit emission floor", async () => {
    await seedSlice([inbound("m-1", 1_757_000_200_000, "Hi")], { status: "open" });
    const { items, skips } = await emit({ minMessages: 2 });
    expect(items).toEqual([]);
    expect(skips).toEqual(["below_min_messages"]);
  });

  it("skips a slice whose roster snapshot cannot be read", async () => {
    await seedSlice([inbound("m-1", 1_757_000_200_000, "Hi")], { rosterSnapshot: "[]" });
    const { items, skips } = await emit();
    expect(items).toEqual([]);
    expect(skips).toEqual(["missing_roster_snapshot"]);
  });

  it("re-emits unchanged content at the full tier once the anchor goes stale", async () => {
    const { sliceId } = await seedSlice(
      [outbound("m-1", 1_756_800_000_000, "The pitch"), inbound("m-2", 1_757_000_200_000, "No thanks")],
      { status: "open" },
    );
    const first = await emit({ now: new Date("2026-09-11T10:40:00.000Z") });
    const item = first.items[0];
    if (!item?.contentHash) throw new Error("no first emission");

    const staleAnchor = buildEmissionAnchor({
      firstMessageId: 1,
      messageCount: 2,
      emittedAt: "2026-09-11T10:40:00.000Z",
      refreshTier: "embeddings_only",
      previous: {
        firstMessageId: 1,
        messageCount: 1,
        emittedAt: "2026-09-11T10:00:00.000Z",
        enrichedMessageCount: 1,
        enrichedAt: "2026-09-11T10:00:00.000Z",
      },
    });
    await linkFile(sliceId, { contentHash: item.contentHash, sourceMeta: staleAnchor });

    const tooEarly = await emit({ now: new Date("2026-09-11T10:50:00.000Z") });
    expect(tooEarly.items).toEqual([]);
    expect(tooEarly.skips).toEqual(["unchanged_content"]);

    const swept = await emit({ now: new Date("2026-09-11T11:05:00.000Z") });
    expect(swept.skips).toEqual([]);
    expect(swept.items).toHaveLength(1);
    expect(swept.items[0]?.enrichmentRefresh).toBe("full");
    expect(swept.items[0]?.contentHash).toBe(item.contentHash);
    expect(parseEmissionAnchor(JSON.stringify(swept.items[0]?.sourceMeta))?.enrichedMessageCount).toBe(2);
  });

  it("stops re-emitting once the anchor says enrichment caught up", async () => {
    const { sliceId } = await seedSlice(
      [outbound("m-1", 1_756_800_000_000, "The pitch"), inbound("m-2", 1_757_000_200_000, "No thanks")],
      { status: "open" },
    );
    const first = await emit({ now: new Date("2026-09-11T10:40:00.000Z") });
    const item = first.items[0];
    if (!item?.contentHash) throw new Error("no first emission");
    await linkFile(sliceId, {
      contentHash: item.contentHash,
      sourceMeta: {
        firstMessageId: 1,
        messageCount: 2,
        emittedAt: "2026-09-11T10:40:00.000Z",
        enrichedMessageCount: 2,
        enrichedAt: "2026-09-11T10:40:00.000Z",
      },
    });
    const later = await emit({ now: new Date("2026-09-11T14:00:00.000Z") });
    expect(later.items).toEqual([]);
    expect(later.skips).toEqual(["unchanged_content"]);
  });
});
