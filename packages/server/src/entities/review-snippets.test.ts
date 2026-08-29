/**
 * Review evidence snippet expansion:
 *  - GET /:id/snippets cuts deduped quotes of the proposed name from the
 *    file's chunks
 *  - fileId is required and unknown review rows 404
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const config = createTestConfig();
const logger = createTestLogger();
const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";
const CONNECTOR_ID = "review-snippets-config";

describe("review evidence snippets", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    const settings = createSettingsRepository(db);
    const users = createUserRepository(db);
    await settings.create();
    await users.create({
      name: "admin",
      email: ADMIN_EMAIL,
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      authRole: "admin",
      skipEntityLinking: true,
    });
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    app = createApp(db, config, { logger });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    adminCookie = res.headers.get("set-cookie") ?? "";
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedReviewWithChunks(name: string, chunks: string[]): Promise<{ reviewId: string; fileId: string }> {
    const now = new Date().toISOString();
    const admin = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
    await db
      .insertInto("connector_configs")
      .values({
        id: CONNECTOR_ID,
        connector_type: "gmail",
        auth_type: "oauth",
        credentials: "{}",
        created_by: admin.id,
      })
      .execute();
    const fileId = randomUUID();
    await db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: CONNECTOR_ID,
        provider_file_id: fileId,
        file_name: "Daily CD Training – 2026-08-20",
        file_type: "email",
        content_category: "document",
        source: "gmail",
        content_hash: `hash-${fileId}`,
        is_archived: 0,
        synced_at: now,
      })
      .execute();
    for (const [index, content] of chunks.entries()) {
      await db
        .insertInto("document_chunks")
        .values({ id: randomUUID(), indexed_file_id: fileId, chunk_index: index, content, token_count: null })
        .execute();
    }
    const reviewId = randomUUID();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: reviewId,
        proposed_name: name,
        normalized_name: name.toLowerCase(),
        entity_type: "person",
        source: "llm_relation",
        source_id: `llm_relation:${reviewId}`,
        candidate_entity_id: null,
        candidate_score: null,
        candidate_reason: null,
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 3,
        status: "pending",
        triggered_by_user_id: admin.id,
      })
      .execute();
    return { reviewId, fileId };
  }

  it("cuts deduped quotes of the proposed name from the file's chunks", async () => {
    const { reviewId, fileId } = await seedReviewWithChunks("Shashank", [
      "Notes from training. Shashank walked the team through the demo funnel numbers.",
      "Notes from training. Shashank walked the team through the demo funnel numbers.",
      "Action items follow-up: nothing assigned to anyone today.",
      "Next steps: Shashank owns the follow-up report for Thursday.",
    ]);
    const res = await app.request(`/api/entity-review/${reviewId}/snippets?fileId=${fileId}`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quotes: string[] };
    expect(body.quotes).toHaveLength(2);
    expect(body.quotes[0]).toContain("Shashank walked the team");
    expect(body.quotes[1]).toContain("Shashank owns the follow-up");
  });

  it("requires fileId and 404s for unknown review rows", async () => {
    const { reviewId, fileId } = await seedReviewWithChunks("Shashank", ["Shashank said hi."]);
    const missingParam = await app.request(`/api/entity-review/${reviewId}/snippets`, {
      headers: { Cookie: adminCookie },
    });
    expect(missingParam.status).toBe(400);
    const unknownReview = await app.request(`/api/entity-review/${randomUUID()}/snippets?fileId=${fileId}`, {
      headers: { Cookie: adminCookie },
    });
    expect(unknownReview.status).toBe(404);
  });
});
