import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { MAX_ENRICHMENT_STAGE_ATTEMPTS } from "./enrichment";
import {
  WHATSAPP_BACKFILL_GRAPH_SCOPE,
  readWhatsAppBackfillGraphBacklog,
  readWhatsAppBackfillGraphTenantTotals,
} from "./whatsapp-chunker";

const SLACK_SCOPE = { connectorType: "slack", platform: "slack" };

async function seedConnector(db: Kysely<DB>, connectorType: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: connectorType,
      auth_type: "oauth",
      credentials: "{}",
      created_by: randomUUID(),
    })
    .execute();
  return id;
}

async function seedPendingFile(
  db: Kysely<DB>,
  connectorConfigId: string,
  overrides: Partial<{ embedding_status: string; summary_status: string; embedding_attempts: number }> = {},
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: randomUUID(),
      connector_config_id: connectorConfigId,
      provider_file_id: randomUUID(),
      source: "test",
      file_name: "file",
      content_category: "document",
      embedding_status: "pending",
      summary_status: "done",
      synced_at: new Date().toISOString(),
      ...overrides,
    })
    .execute();
}

async function seedOpenFact(db: Kysely<DB>, connectorConfigId: string | null): Promise<void> {
  const id = randomUUID();
  await db
    .insertInto("indexed_file_facts")
    .values({
      id,
      fact_key: id,
      source: "test",
      fact_type: "test",
      relation: "test",
      raw: "{}",
      connector_config_id: connectorConfigId,
    })
    .execute();
}

describe("backfill pressure is scoped per connector", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  }, 30_000);

  afterEach(async () => {
    await db.destroy();
  });

  it("does not count another connector's file backlog", async () => {
    const drive = await seedConnector(db, "google_drive");
    const slack = await seedConnector(db, "slack");
    for (let i = 0; i < 50; i++) await seedPendingFile(db, drive);
    await seedPendingFile(db, slack);

    const backlog = await readWhatsAppBackfillGraphBacklog(db, SLACK_SCOPE);

    expect(backlog.pendingFiles).toEqual(1);
  });

  it("still counts the admitted connector's own file backlog", async () => {
    const slack = await seedConnector(db, "slack");
    for (let i = 0; i < 12; i++) await seedPendingFile(db, slack);

    const backlog = await readWhatsAppBackfillGraphBacklog(db, SLACK_SCOPE);

    expect(backlog.pendingFiles).toEqual(12);
  });

  /**
   * WhatsApp is not a bootstrap singleton and its groups are listed
   * tenant-wide, so two configs must not each see half the real backlog.
   */
  it("keeps one connector type's backlog whole across duplicate configs", async () => {
    const first = await seedConnector(db, "whatsapp");
    const second = await seedConnector(db, "whatsapp");
    for (let i = 0; i < 4; i++) await seedPendingFile(db, first);
    for (let i = 0; i < 6; i++) await seedPendingFile(db, second);

    const backlog = await readWhatsAppBackfillGraphBacklog(db, WHATSAPP_BACKFILL_GRAPH_SCOPE);

    expect(backlog.pendingFiles).toEqual(10);
  });

  it("counts facts with no connector against nobody", async () => {
    const slack = await seedConnector(db, "slack");
    await seedOpenFact(db, slack);
    for (let i = 0; i < 20; i++) await seedOpenFact(db, null);

    const backlog = await readWhatsAppBackfillGraphBacklog(db, SLACK_SCOPE);

    expect(backlog.openFacts).toEqual(1);
  });

  it("scopes open facts to the admitted connector type", async () => {
    const drive = await seedConnector(db, "google_drive");
    const slack = await seedConnector(db, "slack");
    for (let i = 0; i < 30; i++) await seedOpenFact(db, drive);
    await seedOpenFact(db, slack);

    expect((await readWhatsAppBackfillGraphBacklog(db, SLACK_SCOPE)).openFacts).toEqual(1);
  });

  it("scopes pending slices by platform", async () => {
    const whatsapp = await db
      .insertInto("conversations")
      .values({ platform: "whatsapp", kind: "group", provider_conversation_id: "g1" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("conversation_slices")
      .values({
        id: randomUUID(),
        conversation_id: whatsapp.id,
        first_message_id: 1,
        last_message_id: 2,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        message_count: 2,
        flush_reason: "max_size",
        roster_snapshot: "[]",
      })
      .execute();

    const slackBacklog = await readWhatsAppBackfillGraphBacklog(db, SLACK_SCOPE);
    const whatsappBacklog = await readWhatsAppBackfillGraphBacklog(db, WHATSAPP_BACKFILL_GRAPH_SCOPE);

    expect(slackBacklog.pendingSlices).toEqual(0);
    expect(whatsappBacklog.pendingSlices).toEqual(1);
  });

  /**
   * The worker abandons a stage at the attempt cap, so counting those rows was
   * pressure that could never drain.
   */
  it("ignores files whose retries the worker has abandoned", async () => {
    const slack = await seedConnector(db, "slack");
    await seedPendingFile(db, slack, {
      embedding_status: "failed",
      embedding_attempts: MAX_ENRICHMENT_STAGE_ATTEMPTS,
    });
    await seedPendingFile(db, slack, {
      embedding_status: "failed",
      embedding_attempts: MAX_ENRICHMENT_STAGE_ATTEMPTS - 1,
    });

    const backlog = await readWhatsAppBackfillGraphBacklog(db, SLACK_SCOPE);

    expect(backlog.pendingFiles).toEqual(1);
  });

  it("still counts a freshly pending file, which has no attempts yet", async () => {
    const slack = await seedConnector(db, "slack");
    await seedPendingFile(db, slack, { embedding_status: "pending", embedding_attempts: 0 });

    expect((await readWhatsAppBackfillGraphBacklog(db, SLACK_SCOPE)).pendingFiles).toEqual(1);
  });

  it("reports tenant-wide totals so global overload stays observable", async () => {
    const drive = await seedConnector(db, "google_drive");
    const slack = await seedConnector(db, "slack");
    for (let i = 0; i < 7; i++) await seedPendingFile(db, drive);
    await seedPendingFile(db, slack);

    const totals = await readWhatsAppBackfillGraphTenantTotals(db);

    expect(totals.pendingFiles).toEqual(8);
  });
});
