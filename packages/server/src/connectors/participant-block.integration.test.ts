/**
 * The Slack speaker block reads a JSON roster snapshot and an id-list column,
 * both of which behave differently enough between SQLite and Postgres to be
 * worth asserting on the real dialect.
 */
import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { pino } from "pino";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { getSharedPgDb } from "../test-utils";
import { buildParticipantBlock } from "./participant-block";
import { seedSlackSliceFile } from "./participant-block-slack-fixture";

const testLogger = pino({ enabled: false });
const CONNECTOR_ID = "cfg-pb-pg";

async function seedFile(db: Kysely<DB>, fileId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: "admin-pb-pg",
      name: "Admin",
      email: "admin-pb-pg@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "slack",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin-pb-pg",
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: fileId,
      file_name: fileId,
      file_type: "meeting",
      content_category: "document",
      source: "slack",
      content_hash: `hash-${fileId}`,
      is_archived: 0,
      source_updated_at: now,
      synced_at: now,
    })
    .execute();
}

describe("Slack speaker block on Postgres", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("lists only the denoised speakers with their roster affiliation and email", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedSlackSliceFile(db, { fileId, connectorConfigId: CONNECTOR_ID });

    const block = await buildParticipantBlock({ db, logger: testLogger }, { fileId, fileContent: "" });

    expect(block).toContain("Conversation participants (spoke in this chunk)");
    expect(block).toContain("- Dana Teammate (teammate) · dana@example.com");
    expect(block).toContain("- Ray External (external)");
    expect(block).not.toContain("Quiet Member");
    expect(block).not.toContain("U0SPEAKER1");
  });

  it("falls back to the first..last id range when denoised ids are absent", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedSlackSliceFile(db, { fileId, connectorConfigId: CONNECTOR_ID, denoised: false });

    const block = await buildParticipantBlock({ db, logger: testLogger }, { fileId, fileContent: "" });

    expect(block).toContain("- Quiet Member (external)");
    expect(block).not.toContain("U0QUIET001");
  });
});
