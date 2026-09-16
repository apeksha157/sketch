import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB } from "../db/schema";
import { getSharedPgDb, spyOnExecutedSql } from "../test-utils";
import { buildMaterializeDeps } from "./materialize-deps";
import { normalizeEntityMatchName } from "./name-keys";
import { decideEntityMatch, proposeEntity, toMatchDeps } from "./propose";

const NOW = "2026-08-29T00:00:00.000Z";

describe("adjacency proposal linking", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  async function seedBase(db: Kysely<DB>): Promise<void> {
    await db
      .insertInto("users")
      .values([
        { id: "user-1", name: "Reviewer", email: "reviewer@example.com" },
        { id: MACHINE_PRINCIPAL_USER_ID, name: "Sketch Machine", email: null },
      ])
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "config-1",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "user-1",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "config-1",
        provider_file_id: `provider-${id}`,
        file_name: `${id}.txt`,
        file_type: "meeting_transcript",
        content_category: "document",
        source: "fireflies",
        synced_at: NOW,
      })
      .execute();
  }

  async function mention(db: Kysely<DB>, entityId: string, indexedFileId: string): Promise<void> {
    await db
      .insertInto("entity_mentions")
      .values({
        id: randomUUID(),
        entity_id: entityId,
        indexed_file_id: indexedFileId,
        confidence: "INFERRED",
        source: "test",
        relation: "mentioned",
        mentioned_at: NOW,
      })
      .execute();
  }

  async function edge(db: Kysely<DB>, sourceEntityId: string, targetEntityId: string): Promise<void> {
    await db
      .insertInto("entity_relationships")
      .values({
        id: randomUUID(),
        source_entity_id: sourceEntityId,
        target_entity_id: targetEntityId,
        relationship_type: "works_at",
        confidence: "INFERRED",
        confidence_score: 0.1,
        source: "test",
      })
      .execute();
  }

  async function proposePerson(db: Kysely<DB>, name: string, sourceId: string, contextFileId?: string | null) {
    const deps = await buildMaterializeDeps(db);
    return proposeEntity(deps, {
      name,
      email: null,
      entityType: "person",
      subtype: "external",
      source: "test",
      sourceId,
      evidence: contextFileId ? [{ indexedFileId: contextFileId }] : [],
      contextFileId,
      triggeredByUserId: "user-1",
      provenanceTier: "inferred",
    });
  }

  it("links a unique edge winner and replays the file-scoped decision when adjacency is suppressed", async () => {
    await seedBase(db);
    await seedFile(db, "file-link");

    const entityRepo = createEntityRepository(db);
    const jain = await entityRepo.createPersonEntity({
      name: "Vishal Jain",
      subtype: "external",
      source: "seed",
      sourceId: "vishal-jain",
      provenanceTier: "human_confirmed",
    });
    await entityRepo.createPersonEntity({
      name: "Vishal Rao",
      subtype: "external",
      source: "seed",
      sourceId: "vishal-rao",
      provenanceTier: "human_confirmed",
    });
    const company = await entityRepo.createEntity({
      name: "Acme",
      sourceType: "company",
      subtype: "external",
      provenanceTier: "human_confirmed",
    });
    await mention(db, company.id, "file-link");
    await edge(db, jain.id, company.id);

    const decisionDeps = await buildMaterializeDeps(db);
    const decisionInput = {
      name: "Vishal",
      email: null,
      entityType: "person" as const,
      subtype: "external" as const,
      source: "test",
      sourceId: "vishal-link",
      evidence: [{ indexedFileId: "file-link" }],
      contextFileId: "file-link",
      triggeredByUserId: "user-1",
      provenanceTier: "inferred" as const,
    };
    const decisionSpy = spyOnExecutedSql(db);
    const decision = await decideEntityMatch(toMatchDeps(decisionDeps), decisionInput);
    expect(decision).toMatchObject({
      status: "linked",
      entityId: jain.id,
      link: { via: "adjacency" },
      intents: [{ kind: "record_adjacency", contextFileId: "file-link" }],
    });
    expect(decisionSpy.sqls.some((sql) => /^\s*(insert|update|delete)\b/i.test(sql))).toBe(false);
    const withoutAdjacency = await decideEntityMatch(
      { ...toMatchDeps(decisionDeps), readAdjacency: undefined },
      decisionInput,
    );
    expect(withoutAdjacency.status).toBe("ambiguous");
    decisionSpy.mockRestore();

    const linked = await proposeEntity(decisionDeps, decisionInput);

    expect(linked.kind).toBe("linked");
    if (linked.kind !== "linked") throw new Error("unreachable");
    expect(linked.entity.id).toBe(jain.id);

    const aliases = await db.selectFrom("entity_aliases").selectAll().where("entity_id", "=", jain.id).execute();
    const refreshed = await entityRepo.getEntity(jain.id);
    expect(aliases).toHaveLength(0);
    expect(refreshed?.aliases).toBeNull();

    const ledger = await db
      .selectFrom("resolution_decisions")
      .selectAll()
      .where("normalized_mention_name", "=", normalizeEntityMatchName("person", "Vishal"))
      .where("scope", "=", "file:file-link")
      .executeTakeFirstOrThrow();
    expect(ledger.decider).toBe("adjacency");
    expect(ledger.decided_by).toBe(MACHINE_PRINCIPAL_USER_ID);
    expect(ledger.target_entity_id).toBe(jain.id);

    const suppressedDeps = await buildMaterializeDeps(db);
    const spy = spyOnExecutedSql(db);
    const replayed = await proposeEntity(suppressedDeps, {
      name: "Vishal",
      email: null,
      entityType: "person",
      subtype: "external",
      source: "test",
      sourceId: "vishal-replay",
      evidence: [{ indexedFileId: "file-link" }],
      contextFileId: "file-link",
      triggeredByUserId: "user-1",
      provenanceTier: "inferred",
      suppressContextLinking: true,
    });

    expect(replayed.kind).toBe("linked");
    if (replayed.kind !== "linked") throw new Error("unreachable");
    expect(replayed.entity.id).toBe(jain.id);
    expect(spy.sqls.some((sql) => sql.includes("entity_relationships"))).toBe(false);
    spy.mockRestore();
  });

  it("queues vetoes, no-signal single-token people, and alias-only non-person hits", async () => {
    await seedBase(db);
    await seedFile(db, "file-veto");
    await seedFile(db, "file-other");

    const entityRepo = createEntityRepository(db);
    const jain = await entityRepo.createPersonEntity({
      name: "Vishal Jain",
      subtype: "external",
      source: "seed",
      sourceId: "veto-jain",
      provenanceTier: "human_confirmed",
    });
    const rao = await entityRepo.createPersonEntity({
      name: "Vishal Rao",
      subtype: "external",
      source: "seed",
      sourceId: "veto-rao",
      provenanceTier: "human_confirmed",
    });
    const company = await entityRepo.createEntity({
      name: "Globex",
      sourceType: "company",
      subtype: "external",
      provenanceTier: "human_confirmed",
    });
    await entityRepo.createPersonEntity({
      name: "Asha Mehta",
      subtype: "external",
      source: "seed",
      sourceId: "asha-mehta",
      provenanceTier: "human_confirmed",
    });
    await mention(db, company.id, "file-veto");
    await mention(db, company.id, "file-other");
    await mention(db, rao.id, "file-other");
    await edge(db, jain.id, company.id);

    const veto = await proposePerson(db, "Vishal", "vishal-veto", "file-veto");
    expect(veto.kind).toBe("queued");
    const vetoRow = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("normalized_name", "=", normalizeEntityMatchName("person", "Vishal"))
      .executeTakeFirstOrThrow();
    expect(vetoRow.candidate_entity_id).toBeNull();
    expect(vetoRow.candidate_reason).toBe("adjacency");
    expect(JSON.parse(vetoRow.candidate_entity_ids ?? "[]").sort()).toEqual([jain.id, rao.id].sort());

    const noSignal = await proposePerson(db, "Asha", "asha-nosignal", "file-veto");
    expect(noSignal.kind).toBe("queued");

    const project = await entityRepo.createEntity({
      name: "Project Falcon",
      sourceType: "project",
      subtype: "external",
      provenanceTier: "human_confirmed",
    });
    await entityRepo.appendAlias(project.id, "Saudi Arabia", "mint_model", "test", { bypassGate: true });
    const companyDeps = await buildMaterializeDeps(db);
    const aliasOnly = await proposeEntity(companyDeps, {
      name: "Saudi Arabia",
      entityType: "company",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "saudi-arabia",
      evidence: [{ indexedFileId: "file-veto" }],
      contextFileId: "file-veto",
      triggeredByUserId: "user-1",
      provenanceTier: "inferred",
    });

    expect(aliasOnly.kind).toBe("queued");
    const aliasRow = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("normalized_name", "=", normalizeEntityMatchName("company", "Saudi Arabia"))
      .executeTakeFirstOrThrow();
    expect(aliasRow.candidate_reason).toBe("alias-exact");
    expect(aliasRow.candidate_entity_id).toBe(project.id);
  });

  it("links one-edit person candidates only through adjacency context", async () => {
    await seedBase(db);
    await seedFile(db, "file-edit");

    const entityRepo = createEntityRepository(db);
    const akanksha = await entityRepo.createPersonEntity({
      name: "Akanksha Mehta",
      subtype: "external",
      source: "seed",
      sourceId: "akanksha",
      provenanceTier: "human_confirmed",
    });
    const company = await entityRepo.createEntity({
      name: "Initech",
      sourceType: "company",
      subtype: "external",
      provenanceTier: "human_confirmed",
    });
    await mention(db, company.id, "file-edit");
    await edge(db, akanksha.id, company.id);

    const linked = await proposePerson(db, "Akansha Mehta", "akansha-link", "file-edit");
    expect(linked.kind).toBe("linked");
    if (linked.kind !== "linked") throw new Error("unreachable");
    expect(linked.entity.id).toBe(akanksha.id);

    const created = await proposePerson(db, "Akansha Mehta", "akansha-create", null);
    expect(created.kind).toBe("created");
    if (created.kind !== "created") throw new Error("unreachable");
    expect(created.entity.id).not.toBe(akanksha.id);
  });
});
