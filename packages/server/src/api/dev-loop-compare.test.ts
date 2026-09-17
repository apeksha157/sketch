import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createEntityRepository } from "../db/repositories/entities";
import { createExtractionStageRepository } from "../db/repositories/extraction-stages";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { LoopCompareDetail } from "../eval/consolidated-loop-report";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const NOW = "2026-09-16T00:00:00.000Z";

async function seedUsers(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: NOW });
  const admin = await users.findByEmail(ADMIN_EMAIL);
  if (!admin) throw new Error("admin missing");
  return admin.id;
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return response.headers.get("set-cookie") ?? "";
}

async function seedCompareFile(db: Kysely<DB>, adminId: string, stale = false): Promise<string> {
  const connectorId = "loop-compare-connector";
  const fileId = stale ? "loop-compare-stale" : "loop-compare-file";
  await db
    .insertInto("connector_configs")
    .values({
      id: connectorId,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: adminId,
    })
    .execute();
  const entities = createEntityRepository(db);
  const acme = await entities.upsertEntity({ name: "Acme Corp", sourceType: "company", status: "confirmed" });
  const bob = await entities.upsertEntity({ name: "Bob Jones", sourceType: "person", status: "confirmed" });
  const carol = await entities.upsertEntity({ name: "Carol Lee", sourceType: "person", status: "confirmed" });
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: connectorId,
      provider_file_id: fileId,
      file_name: "compare.txt",
      file_type: "document",
      content_category: "document",
      content: "Acme Corp, Bob Jones, Carol Lee, and Dana Wu",
      summary: "Current legacy summary",
      source: "google_drive",
      content_hash: "current-hash",
      enrichment_status: "enriched",
      summary_status: "done",
      synced_at: NOW,
      source_created_at: NOW,
    })
    .execute();
  await entities.createMention({
    entityId: acme.id,
    indexedFileId: fileId,
    confidence: "EXTRACTED",
    source: "llm_extraction",
    relation: "mentioned",
  });
  await db
    .insertInto("indexed_file_facts")
    .values(
      [
        ["acme", "Acme Corp", "company"],
        ["acme-duplicate", "Acme Corp", "company"],
        ["bob", "Bob Jones", "person"],
        ["carol", "Carol Lee", "person"],
        ["dana", "Dana Wu", "person"],
      ].map(([id, name, type]) => ({
        id: `${fileId}-${id}`,
        indexed_file_id: fileId,
        connector_config_id: connectorId,
        source: "llm_extraction",
        fact_type: "llm_extracted",
        relation: "mentioned",
        subject_name: name,
        mention_type: type,
        raw: JSON.stringify({ mention: name, type, variations: [] }),
        fact_key: `${fileId}-${id}-key`,
        content_hash: "current-hash",
      })),
    )
    .execute();
  await db
    .insertInto("entity_review_queue")
    .values({
      id: `${fileId}-bob-review`,
      proposed_name: "Bob Jones",
      normalized_name: "bob jones",
      entity_type: "person",
      status: "pending",
      triggered_by_user_id: adminId,
    })
    .execute();
  await db
    .insertInto("entity_review_evidence")
    .values({
      id: `${fileId}-bob-evidence`,
      review_id: `${fileId}-bob-review`,
      indexed_file_id: fileId,
      source: "llm_extraction",
    })
    .execute();
  await createExtractionStageRepository(db).stageExtraction({
    indexedFileId: fileId,
    contentHash: stale ? "old-hash" : "current-hash",
    extractorVersion: "loop-v2",
    stagedJson: JSON.stringify({
      mentions: [
        {
          mention: "Acme Corp",
          type: "company",
          variations: [],
          facts: [],
          resolution: { kind: "matched", entityId: acme.id },
        },
        {
          mention: "Bob Jones",
          type: "person",
          variations: [],
          facts: [],
          resolution: { kind: "matched", entityId: bob.id },
        },
        {
          mention: "Carol Lee",
          type: "person",
          variations: [],
          facts: [],
          resolution: { kind: "judged", entityId: carol.id, reason: "evidence" },
        },
      ],
      relations: [],
      entityFacts: [],
      summary: "Loop summary",
      meta: {
        guard: { overriddenByMatcher: 1 },
        validation: { schemaInvalid: 0, malformedResolution: 0 },
        toolSteps: [],
        model: "test-model",
        registrySize: 3,
      },
    }),
    model: "test-model",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.001,
  });
  return fileId;
}

describe("dev loop compare routes", () => {
  let db: Kysely<DB>;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    adminId = await seedUsers(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("is flag-gated and admin-only, returns the stages envelope, and validates limit", async () => {
    const logger = createTestLogger();
    const offApp = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: false }), { logger });
    const offResponse = await offApp.request("/api/dev/loop-stages", {
      headers: { Cookie: await login(offApp, ADMIN_EMAIL) },
    });
    expect(offResponse.status).toBe(404);

    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const memberResponse = await app.request("/api/dev/loop-stages", {
      headers: { Cookie: await login(app, MEMBER_EMAIL) },
    });
    expect(memberResponse.status).toBe(403);

    const adminCookie = await login(app, ADMIN_EMAIL);
    const adminResponse = await app.request("/api/dev/loop-stages", { headers: { Cookie: adminCookie } });
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toEqual({ stages: [] });

    const invalidResponse = await app.request("/api/dev/loop-stages?limit=201", {
      headers: { Cookie: adminCookie },
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({ error: { field: "limit" } });
  });

  it("returns seeded legacy and loop verdicts with totals", async () => {
    const fileId = await seedCompareFile(db, adminId);
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger: createTestLogger() });
    const response = await app.request(`/api/dev/loop-stages/${fileId}`, {
      headers: { Cookie: await login(app, ADMIN_EMAIL) },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { detail: LoopCompareDetail };
    expect(body.detail.aligned.map((row) => [row.key, row.verdict])).toEqual([
      ["acme corp\tcompany", "same_target"],
      ["bob jones\tperson", "loop_resolved_legacy_queued"],
      ["carol lee\tperson", "loop_resolved_legacy_unresolved"],
      ["dana wu\tperson", "legacy_only"],
    ]);
    expect(body.detail.totals).toMatchObject({
      legacyMentions: 4,
      loopMentions: 3,
      holds: 0,
      verdicts: {
        same_target: 1,
        loop_resolved_legacy_queued: 1,
        loop_resolved_legacy_unresolved: 1,
        legacy_only: 1,
      },
    });
    const listResponse = await app.request("/api/dev/loop-stages", {
      headers: { Cookie: await login(app, ADMIN_EMAIL) },
    });
    const listBody = (await listResponse.json()) as { stages: Array<{ legacyMentionCount: number }> };
    expect({
      detailCount: body.detail.totals.legacyMentions,
      alignedCount: body.detail.aligned.filter((row) => row.legacy).length,
      listCount: listBody.stages[0]?.legacyMentionCount,
    }).toEqual({ detailCount: 4, alignedCount: 4, listCount: 4 });
  });

  it("returns full detail for a stale stage with the stale note", async () => {
    const fileId = await seedCompareFile(db, adminId, true);
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger: createTestLogger() });
    const response = await app.request(`/api/dev/loop-stages/${fileId}`, {
      headers: { Cookie: await login(app, ADMIN_EMAIL) },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { detail: LoopCompareDetail };
    expect(body.detail.stage).toMatchObject({
      stale: true,
      staleNote: "stage content hash differs from the file's current content; legacy rows are from the current content",
    });
    expect(body.detail.loop.mentions).toHaveLength(3);
    expect(body.detail.legacy.mentions).toHaveLength(4);
  });
});
