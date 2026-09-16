import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up as repairSkippedSummaryOrphans } from "../db/migrations/242-repair-skipped-summary-orphans";
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
   * Runs migration 240 itself, so the shipped statement is what gets proven
   * rather than a copy of it that could drift.
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

    await repairSkippedSummaryOrphans(db as unknown as Kysely<unknown>);

    const rows = await db.selectFrom("indexed_files").select(["id", "summary_status"]).orderBy("id").execute();
    expect(rows.find((r) => r.id === orphan)?.summary_status).toEqual("skipped");
    expect(rows.find((r) => r.id === healthy)?.summary_status).toEqual("pending");
  });

  /**
   * The manual rerun route clears the summary so smart enrichment is not
   * skipped as already-resolved. On a file whose embedding was skipped for
   * having no content, clearing the summary alone recreates the very orphan
   * migration 240 repairs — the rerun then refuses to claim it.
   */
  it("reopens both stages when a rerun targets a skipped file", async () => {
    const skipped = await seedOrphan(db, connectorConfigId);
    await db.updateTable("indexed_files").set(SKIPPED_WITHOUT_CONTENT).where("id", "=", skipped).execute();
    const enriched = randomUUID();
    await db
      .insertInto("indexed_files")
      .values({
        id: enriched,
        connector_config_id: connectorConfigId,
        provider_file_id: enriched,
        file_name: "notes.doc",
        content_category: "document",
        source: "google_drive",
        embedding_status: "done",
        summary_status: "done",
        synced_at: new Date().toISOString(),
      })
      .execute();

    for (const fileId of [skipped, enriched]) {
      await db
        .updateTable("indexed_files")
        .set((eb) => ({
          summary_status: "pending",
          embedding_status: eb
            .case()
            .when("embedding_status", "=", "skipped")
            .then("pending")
            .else(eb.ref("embedding_status"))
            .end(),
        }))
        .where("id", "=", fileId)
        .execute();
    }

    const rows = await db.selectFrom("indexed_files").select(["id", "embedding_status", "summary_status"]).execute();
    expect(rows.find((r) => r.id === skipped)).toEqual({
      id: skipped,
      embedding_status: "pending",
      summary_status: "pending",
    });
    expect(rows.find((r) => r.id === enriched)).toEqual({
      id: enriched,
      embedding_status: "done",
      summary_status: "pending",
    });
  });
});
