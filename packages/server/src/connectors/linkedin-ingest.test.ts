import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import type { AimfoxMessage } from "./aimfox-client";
import { LINKEDIN_DELETED_MESSAGE_TEXT, ingestLinkedinConversation } from "./linkedin-ingest";

const ACCOUNT_ID = "urn:li:account:owner";
const CONVERSATION_URN = "urn:li:conversation:42";
const LEAD_ID = "urn:li:lead:7";

function message(overrides: Partial<AimfoxMessage> & { created_at: number }): AimfoxMessage {
  return {
    body: "hello",
    sender: { id: LEAD_ID, full_name: "Priya Nair" },
    ...overrides,
  };
}

describe("LinkedIn conversation ingest", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function ingest(messages: AimfoxMessage[], source: "history" | "live" = "history") {
    return ingestLinkedinConversation({
      db,
      accountId: ACCOUNT_ID,
      conversationUrn: CONVERSATION_URN,
      leadName: "Priya Nair",
      messages,
      source,
      receivedAt: "2026-09-11T10:00:00.000Z",
    });
  }

  async function rows() {
    return db
      .selectFrom("conversation_messages")
      .select([
        "id",
        "provider_message_id",
        "sender_jid",
        "sender_name",
        "is_bot",
        "text",
        "provider_timestamp",
        "provider_from_me",
        "effective_at",
        "source",
      ])
      .orderBy("id", "asc")
      .execute();
  }

  it("maps one conversation onto the shared tables in chronological row order", async () => {
    const result = await ingest([
      message({ id: "m-2", created_at: 1_757_000_200_000, body: "Reply two days later" }),
      message({
        id: "m-1",
        created_at: 1_756_800_000_000,
        body: "The pitch",
        sender: { id: ACCOUNT_ID, full_name: "Owner" },
      }),
    ]);

    const conversation = await db.selectFrom("conversations").selectAll().executeTakeFirstOrThrow();
    expect(conversation.platform).toBe("linkedin");
    expect(conversation.kind).toBe("conversation");
    expect(conversation.provider_conversation_id).toBe(`${ACCOUNT_ID}:${CONVERSATION_URN}`);
    expect(conversation.display_name).toBe("Priya Nair");
    expect(result).toMatchObject({ conversationId: conversation.id, ingested: 2, inserted: 2, textUpdated: 0 });

    const stored = await rows();
    expect(stored.map((row) => row.provider_message_id)).toEqual(["m-1", "m-2"]);
    expect(stored.map((row) => row.text)).toEqual(["The pitch", "Reply two days later"]);
    expect(stored.map((row) => row.provider_from_me)).toEqual([1, 0]);
    expect(stored.map((row) => row.sender_jid)).toEqual([ACCOUNT_ID, LEAD_ID]);
    expect(stored.map((row) => row.is_bot)).toEqual([0, 0]);
    expect(stored.map((row) => row.source)).toEqual(["history", "history"]);
  });

  it("reuses the Aimfox message identity and falls back to a body-free hash", async () => {
    await ingest([
      message({ urn: "urn:li:message:9", created_at: 1_756_800_000_000 }),
      message({ created_at: 1_756_800_000_000, body: "no provider id" }),
    ]);
    const stored = await rows();
    expect(stored).toHaveLength(2);
    const identities = stored.map((row) => row.provider_message_id);
    expect(identities).toContain("urn:li:message:9");
    const fallback = identities.find((identity) => identity !== "urn:li:message:9");
    expect(fallback).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps an undated message without a provider timestamp and effective at receipt time", async () => {
    await ingest([
      message({ id: "dated", created_at: 1_756_800_000_000 }),
      message({ id: "undated", created_at: Number.NaN, body: "undated tail" }),
    ]);
    const stored = await rows();
    expect(stored.map((row) => row.provider_message_id)).toEqual(["dated", "undated"]);
    expect(stored[1]?.provider_timestamp).toBeNull();
    expect(stored[1]?.effective_at).toBe("2026-09-11T10:00:00.000Z");
    expect(stored[0]?.effective_at).toBe(stored[0]?.provider_timestamp);
  });

  it("drops empty non-deleted bodies and keeps deleted messages as a marker", async () => {
    await ingest([
      message({ id: "empty", created_at: 1_756_800_000_000, body: "   " }),
      message({ id: "gone", created_at: 1_756_800_100_000, body: null, deleted: true }),
    ]);
    const stored = await rows();
    expect(stored.map((row) => row.provider_message_id)).toEqual(["gone"]);
    expect(stored[0]?.text).toBe(LINKEDIN_DELETED_MESSAGE_TEXT);
  });

  it("is idempotent across re-ingest and moves text when a message is edited", async () => {
    const messages = [message({ id: "m-1", created_at: 1_756_800_000_000, body: "first draft" })];
    await ingest(messages);
    const second = await ingest(messages);
    expect(second).toMatchObject({ ingested: 1, inserted: 0, textUpdated: 0 });
    expect(await rows()).toHaveLength(1);

    const edited = await ingest([message({ id: "m-1", created_at: 1_756_800_000_000, body: "edited", edited: true })]);
    expect(edited).toMatchObject({ inserted: 0, textUpdated: 1 });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe("edited");
  });

  it("stores an automated campaign message as a bot row and a reply as a human one", async () => {
    await ingest([
      message({
        id: "campaign",
        created_at: 1_756_800_000_000,
        body: "Campaign opener",
        sender: { id: ACCOUNT_ID, full_name: "Owner" },
        automated: true,
      }),
      message({ id: "reply", created_at: 1_756_800_100_000, body: "Happy to talk" }),
    ]);
    const stored = await rows();
    expect(stored.map((row) => row.provider_message_id)).toEqual(["campaign", "reply"]);
    expect(stored.map((row) => row.is_bot)).toEqual([1, 0]);
    expect(stored.map((row) => row.provider_from_me)).toEqual([1, 0]);
  });

  it("marks later rows live once the conversation has moved onto the engine", async () => {
    await ingest([message({ id: "m-1", created_at: 1_756_800_000_000 })], "history");
    await ingest([message({ id: "m-2", created_at: 1_756_900_000_000, body: "later" })], "live");
    const stored = await rows();
    expect(stored.map((row) => row.source)).toEqual(["history", "live"]);
  });
});
