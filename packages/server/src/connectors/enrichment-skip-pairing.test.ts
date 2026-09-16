import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { SKIPPED_WITHOUT_CONTENT } from "./enrichment";

async function seedOrphan(db: Kysely<DB>, connectorConfigId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: connectorConfigId,
      provider_file_id: id,
      file_name: "clip.mp4",
      content_category: "document",
      source: "google_drive",
      embedding_status: "skipped",
      summary_status: "pending",
      synced_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

describe("contentless files are skipped on both stages", () => {
  let db!: Kysely<DB>;
  const connectorConfigId = randomUUID();

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: connectorConfigId,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: randomUUID(),
      })
      .execute();
  }, 30_000);

  afterEach(async () => {
    await db.destroy();
  });

  /**
   * The worker can never finish a summary whose embedding was skipped, so a
   * pending summary here is backlog that nothing will ever drain.
   */
  it("marks the summary skipped alongside the embedding", () => {
    expect(SKIPPED_WITHOUT_CONTENT).toEqual({
      embedding_status: "skipped",
      summary_status: "skipped",
      summary_attempts: 0,
      summary_next_retry_at: null,
    });
  });

  it("leaves no file in the unreachable skipped/pending pair", async () => {
    const id = await seedOrphan(db, connectorConfigId);

    await db.updateTable("indexed_files").set(SKIPPED_WITHOUT_CONTENT).where("id", "=", id).execute();

    const row = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "summary_status"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ embedding_status: "skipped", summary_status: "skipped" });
  });

  /**
   * Migration 240 repairs rows written before the pairing existed. Asserted
   * through the same statement the migration runs so the predicate stays
   * honest in both dialects.
   */
  it("repairs pre-existing orphans without touching legitimate work", async () => {
    const orphan = await seedOrphan(db, connectorConfigId);
    const healthy = randomUUID();
    await db
      .insertInto("indexed_files")
      .values({
        id: healthy,
        connector_config_id: connectorConfigId,
        provider_file_id: healthy,
        file_name: "notes.doc",
        content_category: "document",
        source: "google_drive",
        embedding_status: "done",
        summary_status: "pending",
        synced_at: new Date().toISOString(),
      })
      .execute();

    await db
      .updateTable("indexed_files")
      .set({ summary_status: "skipped", summary_attempts: 0, summary_next_retry_at: null })
      .where("embedding_status", "=", "skipped")
      .where("summary_status", "=", "pending")
      .execute();

    const rows = await db.selectFrom("indexed_files").select(["id", "summary_status"]).orderBy("id").execute();
    expect(rows.find((r) => r.id === orphan)?.summary_status).toEqual("skipped");
    expect(rows.find((r) => r.id === healthy)?.summary_status).toEqual("pending");
  });
});
