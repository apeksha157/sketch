import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { startSyncScheduler } from "./sync";

describe("startSyncScheduler enrichment cadence", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    vi.useFakeTimers();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
  });

  it("runs an enrichment slice on its own timer without waiting for a sync tick", async () => {
    const fileId = randomUUID();
    await db
      .insertInto("connector_configs")
      .values({
        id: "conn-1",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: "conn-1",
        provider_file_id: fileId,
        file_name: "test.txt",
        file_type: "text",
        content_category: "document",
        source: "google_drive",
        source_path: "My Drive",
        provider_url: null,
        content: "some content here",
        summary: null,
        context_note: null,
        access_scope_id: null,
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        embedding_status: "pending",
      })
      .execute();

    const handle = startSyncScheduler(db, createTestLogger(), 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
    await handle.stop();

    const row = await db
      .selectFrom("indexed_files")
      .select("embedding_status")
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();
    expect(row.embedding_status).toBe("done");
  });
});
