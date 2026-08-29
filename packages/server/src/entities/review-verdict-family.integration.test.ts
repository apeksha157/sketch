import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { DB } from "../db/schema";
import { handleProposeGraphVerdicts } from "../mcp/curation/propose-graph-verdicts";
import { createTestPgDb } from "../test-utils";
import { candidateLookupView, entitySummaryView, fileContextView } from "./judge-views";
import { normalizeEntityMatchName } from "./name-keys";
import { applyGraphVerdict, revertGraphVerdict } from "./verdict-apply";

const USER_ID = "review-verdict-user";
const NOW = "2026-08-29T00:00:00.000Z";

function parseToolResult(result: Awaited<ReturnType<typeof handleProposeGraphVerdicts>>) {
  return JSON.parse(result.content[0]?.text ?? "{}") as {
    stored: number;
    bounced: number;
    results: Array<{
      verdictId: string;
      disposition: string;
      validationReason: string | null;
      subjectMentionName?: string | null;
    }>;
  };
}

async function seedBase(db: Kysely<DB>) {
  await db.insertInto("users").values({ id: USER_ID, name: "Reviewer", email: "reviewer@example.com" }).execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "review-verdict-config",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string) {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "review-verdict-config",
      provider_file_id: id,
      file_name: `${id}.txt`,
      file_type: "text",
      content_category: "document",
      source: "fireflies",
      synced_at: NOW,
    })
    .execute();
}

async function seedEntity(
  db: Kysely<DB>,
  input: { id: string; name: string; sourceType?: string; provenanceTier?: string; aliases?: string[] },
) {
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.sourceType ?? "person",
      subtype: null,
      aliases: input.aliases ? JSON.stringify(input.aliases) : null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      provenance_tier: input.provenanceTier ?? "inferred",
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

async function seedReview(
  db: Kysely<DB>,
  input: { id: string; proposedName: string; source: string; sourceId: string; fileId: string; status?: string },
) {
  await db
    .insertInto("entity_review_queue")
    .values({
      id: input.id,
      proposed_name: input.proposedName,
      normalized_name: normalizeEntityMatchName("person", input.proposedName),
      entity_type: "person",
      source: input.source,
      source_id: input.sourceId,
      candidate_entity_id: "target-person",
      candidate_score: 0.9,
      candidate_reason: "prefix",
      candidate_generated_at: NOW,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      status: input.status ?? "pending",
      triggered_by_user_id: USER_ID,
    })
    .execute();
  await db
    .insertInto("entity_review_evidence")
    .values({
      id: randomUUID(),
      review_id: input.id,
      indexed_file_id: input.fileId,
      source: input.source,
      seen_at: NOW,
    })
    .execute();
}

async function proposeMention(
  db: Kysely<DB>,
  input: { name: string; action?: "link_to" | "dismiss"; targetEntityId?: string; entityType?: string },
) {
  return parseToolResult(
    await handleProposeGraphVerdicts(
      {
        verdicts: [
          {
            action: input.action ?? "link_to",
            subjectMentionName: input.name,
            subjectEntityType: input.entityType ?? "person",
            ...(input.targetEntityId ? { targetEntityId: input.targetEntityId } : {}),
            reason: "review verdict",
            evidence: { notes: ["test"] },
          },
        ],
      },
      db,
      { userId: USER_ID, tokenId: "token" },
    ),
  );
}

describe("review mention graph verdicts", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
    await seedBase(db);
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("links every live row for a mention verdict, records a human ledger row, and reverts guarded state", async () => {
    await seedFile(db, "mention-file-a");
    await seedFile(db, "mention-file-b");
    await seedEntity(db, { id: "target-person", name: "Sehaj Singh", provenanceTier: "inferred" });
    await seedReview(db, {
      id: "review-a",
      proposedName: "sehaj",
      source: "fireflies",
      sourceId: "source-a",
      fileId: "mention-file-a",
    });
    await seedReview(db, {
      id: "review-b",
      proposedName: "sehaj",
      source: "slack",
      sourceId: "source-b",
      fileId: "mention-file-b",
      status: "deferred",
    });

    const proposed = await proposeMention(db, { name: "sehaj", targetEntityId: "target-person" });
    const verdictId = proposed.results[0]?.verdictId ?? "";
    expect(proposed).toMatchObject({ stored: 1, bounced: 0 });
    expect(proposed.results[0]).toMatchObject({
      disposition: "awaiting_human",
      subjectMentionName: normalizeEntityMatchName("person", "sehaj"),
    });

    await createGraphVerdictRepository(db).markApproved({ id: verdictId, actorUserId: USER_ID });
    const applied = await applyGraphVerdict(db, { verdictId, actorUserId: USER_ID });
    expect(applied.ledgerRef).toBe("mention-linked:2");

    await expect(
      db
        .selectFrom("entity_review_queue")
        .select(["id", "status", "resolved_entity_id", "resolved_by"])
        .where("id", "in", ["review-a", "review-b"])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      { id: "review-a", status: "confirmed", resolved_entity_id: "target-person", resolved_by: USER_ID },
      { id: "review-b", status: "confirmed", resolved_entity_id: "target-person", resolved_by: USER_ID },
    ]);
    await expect(
      db.selectFrom("entities").select("provenance_tier").where("id", "=", "target-person").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provenance_tier: "human_confirmed" });
    await expect(
      db
        .selectFrom("resolution_decisions")
        .select(["verdict", "target_entity_id", "decider", "decided_by", "verdict_ref", "status"])
        .where("normalized_mention_name", "=", normalizeEntityMatchName("person", "sehaj"))
        .execute(),
    ).resolves.toEqual([
      {
        verdict: "link",
        target_entity_id: "target-person",
        decider: "human",
        decided_by: USER_ID,
        verdict_ref: verdictId,
        status: "active",
      },
    ]);

    await revertGraphVerdict(db, { verdictId, actorUserId: USER_ID });
    await expect(
      db
        .selectFrom("entity_review_queue")
        .select(["id", "status", "resolved_entity_id", "resolved_by"])
        .where("id", "in", ["review-a", "review-b"])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      { id: "review-a", status: "pending", resolved_entity_id: null, resolved_by: null },
      { id: "review-b", status: "pending", resolved_entity_id: null, resolved_by: null },
    ]);
    await expect(
      db
        .selectFrom("resolution_decisions")
        .select("status")
        .where("verdict_ref", "=", verdictId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "stale" });
    await expect(
      db.selectFrom("entities").select("provenance_tier").where("id", "=", "target-person").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provenance_tier: "inferred" });
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", verdictId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "reverted" });
  });

  it("bounces missing rows and type mismatches, supersedes awaiting duplicates, and blocks approved duplicates", async () => {
    await seedFile(db, "guard-file");
    await seedEntity(db, { id: "target-person", name: "Sehaj Singh", sourceType: "person" });
    await seedEntity(db, { id: "wrong-company", name: "Wrong Company", sourceType: "company" });
    await seedReview(db, {
      id: "guard-review",
      proposedName: "sehaj",
      source: "fireflies",
      sourceId: "guard-source",
      fileId: "guard-file",
    });

    const missing = await proposeMention(db, { name: "nobody", targetEntityId: "target-person" });
    expect(missing.results[0]).toMatchObject({ disposition: "bounced", validationReason: "review_row_not_found" });

    const mismatch = await proposeMention(db, { name: "sehaj", targetEntityId: "wrong-company" });
    expect(mismatch.results[0]).toMatchObject({ disposition: "bounced", validationReason: "type_mismatch" });

    const first = await proposeMention(db, { name: "sehaj", targetEntityId: "target-person" });
    const second = await proposeMention(db, { name: "sehaj", targetEntityId: "target-person" });
    const firstId = first.results[0]?.verdictId ?? "";
    const secondId = second.results[0]?.verdictId ?? "";
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select(["id", "status", "superseded_at"])
        .where("id", "in", [firstId, secondId])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstId, status: "awaiting_human", superseded_at: expect.any(String) }),
        expect.objectContaining({ id: secondId, status: "awaiting_human", superseded_at: null }),
      ]),
    );

    await createGraphVerdictRepository(db).markApproved({ id: secondId, actorUserId: USER_ID });
    const third = await proposeMention(db, { name: "sehaj", targetEntityId: "target-person" });
    expect(third.results[0]).toMatchObject({
      disposition: "bounced",
      validationReason: "approved_verdict_pending",
    });
  });

  it("keeps judge views within budget, preserves totals, marks trimmed lists, and returns unknown-id errors", async () => {
    for (let index = 0; index < 70; index += 1) {
      await seedFile(db, `monster-file-${index}`);
    }
    await seedEntity(db, {
      id: "monster",
      name: "Monster Candidate",
      aliases: Array.from({ length: 60 }, (_, index) => `Monster Alias ${index}`),
    });
    for (let index = 0; index < 35; index += 1) {
      const id = `other-${index}`;
      await seedEntity(db, { id, name: `Related Person ${index}` });
      await db
        .insertInto("entity_relationships")
        .values({
          id: `rel-${index}`,
          source_entity_id: "monster",
          target_entity_id: id,
          relationship_type: index % 2 === 0 ? "works_with" : "mentions",
          confidence: "CONFIRMED",
          confidence_score: 1,
          source: "test",
        })
        .execute();
    }
    for (let index = 0; index < 12; index += 1) {
      await db
        .insertInto("entity_contact_points")
        .values({
          id: `email-${index}`,
          entity_id: "monster",
          kind: "email",
          value: `monster${index}@example.com`,
          display_value: null,
          label: null,
          source: "test",
        })
        .execute();
    }
    for (let index = 0; index < 70; index += 1) {
      await db
        .insertInto("entity_mentions")
        .values({
          id: `mention-${index}`,
          entity_id: "monster",
          indexed_file_id: `monster-file-${index}`,
          chunk_index: null,
          context_snippet: null,
          confidence: "EXTRACTED",
          source: "test",
          relation: "mentioned",
          mentioned_at: NOW,
        })
        .execute();
    }
    for (let index = 0; index < 25; index += 1) {
      await seedEntity(db, { id: `exact-${index}`, name: "Monster Candidate" });
    }
    for (let index = 0; index < 20; index += 1) {
      await seedEntity(db, { id: `candidate-${index}`, name: `Monster Candidate ${index}` });
    }

    const entityView = await entitySummaryView(db, "monster");
    expect(entityView.length).toBeLessThanOrEqual(2000);
    expect(() => JSON.parse(entityView)).not.toThrow();
    expect(entityView).toContain("more");

    const candidateView = await candidateLookupView(db, { name: "Monster Candidate", entityType: "person" });
    const parsedCandidates = JSON.parse(candidateView) as { total: number };
    expect(candidateView.length).toBeLessThanOrEqual(2000);
    expect(parsedCandidates.total).toBeGreaterThanOrEqual(40);

    expect(JSON.parse(await entitySummaryView(db, "missing-entity"))).toEqual({ error: "entity_not_found" });
    expect(JSON.parse(await fileContextView(db, "missing-file"))).toEqual({ error: "file_not_found" });
  });
});
