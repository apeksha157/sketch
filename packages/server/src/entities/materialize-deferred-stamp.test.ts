import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performReset } from "../api/entities/reset-service";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";

const ADMIN_ID = "admin-1";
const CONNECTOR_ID = "cfg";

/**
 * The stamp exists so backfill admission can tell "nobody has looked at this
 * yet" from "a sweep looked and parked it indefinitely". Getting that wrong in
 * either direction is a production outage: a stamp that leaks onto unswept work
 * hides real pressure, and a missing stamp pins history indexing shut forever.
 */
describe("materialization deferred stamp", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("stamps a below-threshold mention once and leaves the stamp alone on later sweeps", async () => {
    await upsertLlmFact(db, "file-1", "Acme");

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    const first = await onlyFact(db);
    expect(first.materialized_at).toBeNull();
    expect(first.materialization_deferred_at).not.toBeNull();

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    const second = await onlyFact(db);
    expect(second.materialization_deferred_at).toBe(first.materialization_deferred_at);
  });

  /**
   * The sweep must keep re-reading parked facts: a second file naming the same
   * entity is the only way a below-threshold mention is ever promoted, and it
   * arrives long after the fact was parked.
   */
  it("still promotes a parked mention once a second file names it, clearing the stamp", async () => {
    await upsertLlmFact(db, "file-1", "Acme");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    expect((await onlyFact(db)).materialization_deferred_at).not.toBeNull();

    await upsertLlmFact(db, "file-2", "Acme");
    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });

    expect(summary.entitiesCreated).toBe(1);
    const facts = await db.selectFrom("indexed_file_facts").selectAll().orderBy("indexed_file_id").execute();
    expect(facts).toHaveLength(2);
    for (const fact of facts) {
      expect(fact.materialized_at).not.toBeNull();
      expect(fact.materialization_deferred_at).toBeNull();
    }
  });

  it("keeps parked facts in the sweep's own eligible count, which is not the admission metric", async () => {
    await upsertLlmFact(db, "file-1", "Acme");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });

    expect(summary.eligibleFacts).toBe(1);
    expect(summary.factsRead).toBe(1);
    expect(summary.deferred).toBe(1);
  });

  it("clears the stamp when an upsert changes the fact's materializer inputs", async () => {
    await upsertLlmFact(db, "file-1", "Acme");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    expect((await onlyFact(db)).materialization_deferred_at).not.toBeNull();

    /** Same fact key, different materializer input: the fact is fresh work again. */
    await upsertLlmFact(db, "file-1", "Acme", { contextSnippet: "re-extracted with more context" });

    expect((await onlyFact(db)).materialization_deferred_at).toBeNull();
  });

  it("keeps the stamp when a re-sync re-emits the identical fact", async () => {
    await upsertLlmFact(db, "file-1", "Acme");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    const stamped = await onlyFact(db);

    await upsertLlmFact(db, "file-1", "Acme");

    expect((await onlyFact(db)).materialization_deferred_at).toBe(stamped.materialization_deferred_at);
  });

  /**
   * A tombstone clears the verdict but not the stamp, so reviving on an
   * unchanged hash would otherwise resurrect a fact that needs real work and is
   * invisible to the gate.
   */
  it("clears the stamp when a tombstoned fact is revived, even on an unchanged hash", async () => {
    await upsertLlmFact(db, "file-1", "Acme");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    const factKey = (await onlyFact(db)).fact_key;
    await createIndexedFileFactRepository(db).tombstoneByFactKeys([factKey]);

    await upsertLlmFact(db, "file-1", "Acme");

    const revived = await onlyFact(db);
    expect(revived.deleted_at).toBeNull();
    expect(revived.materialization_deferred_at).toBeNull();
  });

  it("clears the stamp when a re-enrichment reopens the file's facts", async () => {
    await upsertLlmFact(db, "file-1", "Acme");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    expect((await onlyFact(db)).materialization_deferred_at).not.toBeNull();

    await createIndexedFileFactRepository(db).clearMaterializedAtForActiveFacts(["file-1"]);

    expect((await onlyFact(db)).materialization_deferred_at).toBeNull();
  });

  it("clears the stamp when an operator resets the fact type", async () => {
    await upsertLlmFact(db, "file-1", "Acme");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    expect((await onlyFact(db)).materialization_deferred_at).not.toBeNull();

    await performReset(db, {
      includeConnectors: false,
      includeAi: true,
      includeManual: false,
      orgSourceTypes: ["company"],
      factTypes: ["llm_extracted"],
    });

    expect((await onlyFact(db)).materialization_deferred_at).toBeNull();
  });
});

async function onlyFact(db: Kysely<DB>) {
  return db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
}

async function seedBase(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: ADMIN_ID,
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ADMIN_ID,
    })
    .execute();
  for (const fileId of ["file-1", "file-2"]) {
    await db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: CONNECTOR_ID,
        provider_file_id: fileId,
        file_name: fileId,
        file_type: "document",
        content_category: "document",
        source: "google_drive",
        content_hash: `hash-${fileId}`,
        is_archived: 0,
        synced_at: now,
      })
      .execute();
  }
}

async function upsertLlmFact(
  db: Kysely<DB>,
  fileId: string,
  name: string,
  overrides: { contextSnippet?: string } = {},
): Promise<void> {
  const promptVersion = "llm-extraction-v2";
  await createIndexedFileFactRepository(db).upsertFact({
    ...(overrides.contextSnippet ? { contextSnippet: overrides.contextSnippet } : {}),
    indexedFileId: fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: ADMIN_ID,
    contentHash: `hash-${fileId}`,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${fileId}:hash-${fileId}:${promptVersion}:${name}`,
    raw: {
      contentHash: `hash-${fileId}`,
      promptVersion,
      model: "gemini",
      mention: name,
      type: "company",
      variations: [],
    },
  });
}
