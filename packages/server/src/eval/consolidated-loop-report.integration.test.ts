import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createExtractionStageRepository } from "../db/repositories/extraction-stages";
import type { DB } from "../db/schema";
import { getSharedPgDb } from "../test-utils";
import {
  aggregateConsolidatedLoopReport,
  evaluateConsolidatedLoopStage,
  loadLegacyMentionClassifications,
  loadLoopCompareEntityNames,
  renderConsolidatedLoopReportMarkdown,
  selectExistingConsolidatedLoopStages,
} from "./consolidated-loop-report";

const NOW = "2026-09-15T00:00:00.000Z";

describe("existing consolidated loop report", () => {
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

  it("reports staged comparison and legacy linked and queued counts", async () => {
    const suffix = randomUUID();
    const userId = `report-user-${suffix}`;
    const connectorId = `report-connector-${suffix}`;
    const fileId = `report-file-${suffix}`;
    const acmeName = `Acme Corp ${suffix}`;
    const bobName = `Bob Jones ${suffix}`;
    const samName = `Sam Lee ${suffix}`;
    await db
      .insertInto("users")
      .values({ id: userId, name: "Report User", email: `${userId}@example.com` })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: connectorId,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: userId,
      })
      .execute();
    const entityRepo = createEntityRepository(db);
    const acme = await entityRepo.upsertEntity({ name: acmeName, sourceType: "company", status: "confirmed" });
    const bob = await entityRepo.upsertEntity({ name: bobName, sourceType: "person", status: "confirmed" });
    await db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: connectorId,
        provider_file_id: fileId,
        file_name: "report.txt",
        file_type: "document",
        content_category: "document",
        content: `${acmeName} met ${bobName}.`,
        summary: "Legacy summary.",
        source: "google_drive",
        source_path: "Drive/report.txt",
        content_hash: `hash-${suffix}`,
        summary_status: "done",
        synced_at: NOW,
        source_created_at: NOW,
        source_updated_at: NOW,
      })
      .execute();
    await db
      .updateTable("entities")
      .set({ metadata: JSON.stringify({ learned_facts: [{ fact: "Enterprise account", source_file_id: fileId }] }) })
      .where("id", "=", acme.id)
      .execute();
    await entityRepo.createMention({
      entityId: acme.id,
      indexedFileId: fileId,
      confidence: "EXTRACTED",
      source: "llm_extraction",
      relation: "mentioned",
    });
    await db
      .insertInto("indexed_file_facts")
      .values([
        {
          id: `mention-fact-${suffix}`,
          indexed_file_id: fileId,
          connector_config_id: connectorId,
          source: "llm_extraction",
          fact_type: "llm_extracted",
          relation: "mentioned",
          subject_name: acmeName,
          raw: JSON.stringify({ mention: acmeName, type: "company", variations: [] }),
          fact_key: `mention-key-${suffix}`,
          content_hash: `hash-${suffix}`,
        },
        {
          id: `bob-mention-fact-${suffix}`,
          indexed_file_id: fileId,
          connector_config_id: connectorId,
          source: "llm_extraction",
          fact_type: "llm_extracted",
          relation: "mentioned",
          subject_name: bobName,
          raw: JSON.stringify({ mention: bobName, type: "person", variations: [] }),
          fact_key: `bob-mention-key-${suffix}`,
          content_hash: `hash-${suffix}`,
        },
        {
          id: `sam-mention-fact-${suffix}`,
          indexed_file_id: fileId,
          connector_config_id: connectorId,
          source: "llm_extraction",
          fact_type: "llm_extracted",
          relation: "mentioned",
          subject_name: samName,
          raw: JSON.stringify({ mention: samName, type: "person", variations: [] }),
          fact_key: `sam-mention-key-${suffix}`,
          content_hash: `hash-${suffix}`,
        },
        {
          id: `relation-fact-${suffix}`,
          indexed_file_id: fileId,
          connector_config_id: connectorId,
          source: "llm_extraction",
          fact_type: "llm_relation",
          relation: "works_with",
          subject_name: acmeName,
          raw: "{}",
          fact_key: `relation-key-${suffix}`,
          content_hash: `hash-${suffix}`,
        },
      ])
      .execute();
    await db
      .insertInto("entity_review_queue")
      .values([
        {
          id: `review-${suffix}`,
          proposed_name: bobName,
          normalized_name: bobName.toLowerCase(),
          entity_type: "person",
          status: "pending",
          triggered_by_user_id: userId,
          source: "test",
          source_id: `bob-review-source-${suffix}`,
        },
        {
          id: `sam-review-a-${suffix}`,
          proposed_name: samName,
          normalized_name: samName.toLowerCase(),
          entity_type: "person",
          status: "pending",
          triggered_by_user_id: userId,
          source: "test",
          source_id: `sam-review-a-source-${suffix}`,
        },
        {
          id: `sam-review-b-${suffix}`,
          proposed_name: samName,
          normalized_name: samName.toLowerCase(),
          entity_type: "person",
          status: "pending",
          triggered_by_user_id: userId,
          source: "test",
          source_id: `sam-review-b-source-${suffix}`,
        },
      ])
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values([
        {
          id: `evidence-${suffix}`,
          review_id: `review-${suffix}`,
          indexed_file_id: fileId,
          source: "llm_extraction",
        },
        {
          id: `sam-evidence-a-${suffix}`,
          review_id: `sam-review-a-${suffix}`,
          indexed_file_id: fileId,
          source: "llm_extraction",
        },
        {
          id: `sam-evidence-b-${suffix}`,
          review_id: `sam-review-b-${suffix}`,
          indexed_file_id: fileId,
          source: "llm_extraction",
        },
      ])
      .execute();
    await db
      .insertInto("llm_usage_events")
      .values([
        {
          id: `legacy-usage-${suffix}`,
          context: "enrichment:extractEntities",
          indexed_file_id: fileId,
          model: "legacy-model",
          outcome: "ok",
          prompt_tokens: 100,
          completion_tokens: 20,
          duration_ms: 10,
          cost_usd: 0.01,
        },
        {
          id: `loop-usage-${suffix}`,
          context: "enrichment:consolidatedLoop",
          indexed_file_id: fileId,
          model: "loop-model",
          outcome: "ok",
          prompt_tokens: 999,
          completion_tokens: 999,
          duration_ms: 10,
          cost_usd: 9.99,
        },
      ])
      .execute();
    await createExtractionStageRepository(db).stageExtraction({
      indexedFileId: fileId,
      contentHash: `hash-${suffix}`,
      extractorVersion: "loop-v1",
      stagedJson: JSON.stringify({
        mentions: [
          {
            mention: acmeName,
            type: "company",
            variations: [],
            resolution: { kind: "known", entityId: acme.id },
          },
          {
            mention: bobName,
            type: "person",
            variations: [],
            resolution: { kind: "tool", entityId: bob.id },
          },
          {
            mention: samName,
            type: "person",
            variations: [],
            resolution: { kind: "new" },
          },
        ],
        relations: [
          {
            type: "works_with",
            source: { name: acmeName, type: "company" },
            target: { name: bobName, type: "person" },
            confidence: 0.9,
          },
        ],
        entityFacts: [{ entityId: acme.id, facts: ["Enterprise account"] }],
        summary: "Loop summary.",
        meta: {
          toolSteps: [],
          guard: { demotedUnoffered: 0, droppedFacts: 0 },
          registrySize: 2,
          model: "loop-model",
          validation: { droppedMentions: 0, droppedRelations: 0, droppedEntityFacts: 0 },
        },
      }),
      model: "loop-model",
      rounds: 1,
      toolCalls: 0,
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 0.002,
      durationMs: 15,
    });

    const selections = await selectExistingConsolidatedLoopStages(db, { fileIds: [fileId] });
    expect(selections).toHaveLength(1);
    const row = await evaluateConsolidatedLoopStage(db, selections[0].file, selections[0].stage);

    expect(row).toMatchObject({
      stale: false,
      legacyMentionCount: 3,
      loopMentionCount: 3,
      mentionRecall: 1,
      mentionPrecision: 1,
      legacyRelationCount: 1,
      loopRelationCount: 1,
      legacyFactCount: 1,
      loopFactCount: 1,
      legacyCostUsd: 0.01,
      loopCostUsd: 0.002,
      legacyTokens: 120,
      loopTokens: 75,
      resolvedLegacyQueuedCount: 1,
      guard: { registryLinked: 0 },
      mentionDiagnostics: [
        { mention: acmeName, resolutionKind: "known", legacy: { kind: "linked", entityName: acmeName } },
        { mention: bobName, resolutionKind: "tool", legacy: { kind: "queued", status: "pending" } },
        {
          mention: samName,
          resolutionKind: "new",
          legacy: {
            kind: "ambiguous",
            entityIds: [],
            reviewIds: [`sam-review-a-${suffix}`, `sam-review-b-${suffix}`],
          },
        },
      ],
    });
    const totals = aggregateConsolidatedLoopReport([row]);
    expect(totals).toMatchObject({
      files: 1,
      comparedFiles: 1,
      staleFiles: 0,
      legacyMentionCount: 3,
      loopMentionCount: 3,
      aggregateRecall: 1,
      resolvedLegacyQueuedCount: 1,
    });
    const markdown = renderConsolidatedLoopReportMarkdown("test-run", [row], totals);
    expect(markdown).toContain("Loop-resolved mentions queued by legacy: 1");
    expect(markdown).toContain(`legacy linked -> ${acmeName}`);
    expect(markdown).toContain("legacy queued (pending)");
    expect(markdown).toContain("legacy ambiguous (0 entities, 2 reviews)");
  });

  it("uses updated_at for same-day since filtering and includes loop-v1 and loop-v2 stages", async () => {
    const suffix = randomUUID();
    const userId = `report-since-user-${suffix}`;
    const connectorId = `report-since-connector-${suffix}`;
    const entityId = `report-since-entity-${suffix}`;
    await db
      .insertInto("users")
      .values({ id: userId, name: "Report User", email: `${userId}@example.com` })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: connectorId,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: userId,
      })
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: entityId,
        name: "Versioned Entity",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    const stageRepo = createExtractionStageRepository(db);
    for (const [version, resolution] of [
      ["loop-v1", { kind: "known", entityId }],
      ["loop-v2", { kind: "matched", entityId }],
    ] as const) {
      const fileId = `report-since-${version}-${suffix}`;
      await db
        .insertInto("indexed_files")
        .values({
          id: fileId,
          connector_config_id: connectorId,
          provider_file_id: fileId,
          file_name: `${version}.txt`,
          file_type: "document",
          content_category: "document",
          content: "Versioned Entity",
          summary: "Legacy summary.",
          source: "google_drive",
          content_hash: `hash-${version}-${suffix}`,
          summary_status: "done",
          synced_at: NOW,
        })
        .execute();
      const stage = await stageRepo.stageExtraction({
        indexedFileId: fileId,
        contentHash: `hash-${version}-${suffix}`,
        extractorVersion: version,
        stagedJson: JSON.stringify({
          mentions: [
            {
              mention: "Versioned Entity",
              type: "company",
              variations: [],
              facts: [],
              resolution,
            },
          ],
          relations: [],
          entityFacts: [],
          summary: `${version} summary.`,
          meta: { guard: { demotedUnoffered: 0, droppedFacts: 0 } },
        }),
      });
      await db
        .updateTable("extraction_stages")
        .set({ updated_at: "2026-09-15 12:00:00.123+05:30", created_at: "2026-09-14 12:00:00" })
        .where("id", "=", stage.id)
        .execute();
    }

    const selections = await selectExistingConsolidatedLoopStages(db, { since: "2026-09-15 00:00:00" });
    const selected = selections.filter((selection) => selection.file.id.endsWith(suffix));
    expect(selected.map((selection) => selection.stage.extractor_version).sort()).toEqual(["loop-v1", "loop-v2"]);
    const afterSelections = await selectExistingConsolidatedLoopStages(db, { since: "2026-09-15T07:00:00Z" });
    expect(afterSelections.filter((selection) => selection.file.id.endsWith(suffix))).toEqual([]);
    const rows = await Promise.all(
      selected.map((selection) => evaluateConsolidatedLoopStage(db, selection.file, selection.stage)),
    );
    expect(
      rows
        .flatMap((row) => (row.stale ? [] : row.mentionDiagnostics.map((diagnostic) => diagnostic.resolutionKind)))
        .sort(),
    ).toEqual(["known", "matched"]);
  });

  it("reconstructs exact legacy classifications and looks up deleted merged loop targets", async () => {
    const suffix = randomUUID();
    const userId = `report-compare-user-${suffix}`;
    const connectorId = `report-compare-connector-${suffix}`;
    const fileId = `report-compare-file-${suffix}`;
    await db
      .insertInto("users")
      .values({ id: userId, name: "Report User", email: `${userId}@example.com` })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: connectorId,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: userId,
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: connectorId,
        provider_file_id: fileId,
        file_name: "compare.txt",
        file_type: "document",
        content_category: "document",
        content: "classification fixture",
        source: "google_drive",
        content_hash: `hash-${suffix}`,
        synced_at: NOW,
      })
      .execute();
    const entityRepo = createEntityRepository(db);
    const linked = await entityRepo.upsertEntity({
      name: `Official ${suffix}`,
      sourceType: "company",
      status: "confirmed",
    });
    const survivor = await entityRepo.upsertEntity({
      name: `Survivor ${suffix}`,
      sourceType: "company",
      status: "confirmed",
    });
    const deleted = await entityRepo.upsertEntity({
      name: `Deleted ${suffix}`,
      sourceType: "company",
      status: "confirmed",
    });
    await db
      .updateTable("entities")
      .set({
        aliases: JSON.stringify([`Alias ${suffix}`]),
      })
      .where("id", "=", linked.id)
      .execute();
    await db
      .updateTable("entities")
      .set({ deleted_at: NOW, merged_into_entity_id: survivor.id })
      .where("id", "=", deleted.id)
      .execute();
    await entityRepo.createMention({
      entityId: linked.id,
      indexedFileId: fileId,
      confidence: "EXTRACTED",
      source: "llm_extraction",
      relation: "mentioned",
    });
    const mentionFacts = [
      [`alias-${suffix}`, `Alias ${suffix}`, "company"],
      [`queued-${suffix}`, `Queued ${suffix}`, "person"],
      [`ambiguous-${suffix}`, `Ambiguous ${suffix}`, "person"],
    ] as const;
    await db
      .insertInto("indexed_file_facts")
      .values(
        mentionFacts.map(([id, name, type]) => ({
          id,
          indexed_file_id: fileId,
          connector_config_id: connectorId,
          source: "llm_extraction",
          fact_type: "llm_extracted",
          relation: "mentioned",
          subject_name: name,
          mention_type: type,
          raw: JSON.stringify({ mention: name, type, variations: [] }),
          fact_key: `key-${id}`,
          content_hash: `hash-${suffix}`,
        })),
      )
      .execute();
    for (const [id, name] of [
      [`queued-review-${suffix}`, `Queued ${suffix}`],
      [`ambiguous-review-a-${suffix}`, `Ambiguous ${suffix}`],
      [`ambiguous-review-b-${suffix}`, `Ambiguous ${suffix}`],
    ] as const) {
      await db
        .insertInto("entity_review_queue")
        .values({
          id,
          proposed_name: name,
          normalized_name: name.toLowerCase(),
          entity_type: "person",
          status: "pending",
          triggered_by_user_id: userId,
          source: "test",
          source_id: id,
        })
        .execute();
      await db
        .insertInto("entity_review_evidence")
        .values({
          id: `evidence-${id}`,
          review_id: id,
          indexed_file_id: fileId,
          source: "llm_extraction",
        })
        .execute();
    }

    const classifications = await loadLegacyMentionClassifications(db, fileId);
    expect(classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: `Alias ${suffix}`, status: "linked", entityId: linked.id }),
        expect.objectContaining({ name: `Queued ${suffix}`, status: "queued", reviewId: `queued-review-${suffix}` }),
        expect.objectContaining({
          name: `Ambiguous ${suffix}`,
          status: "ambiguous",
          reviewIds: [`ambiguous-review-a-${suffix}`, `ambiguous-review-b-${suffix}`],
        }),
      ]),
    );

    const names = await loadLoopCompareEntityNames(db, {
      mentions: [
        {
          mention: `Deleted ${suffix}`,
          type: "company",
          variations: [],
          resolution: { kind: "matched", entityId: deleted.id },
        },
      ],
      relations: [],
      entityFacts: [{ entityId: deleted.id, facts: [] }],
      summary: "summary",
      meta: {},
    });
    expect(names.get(deleted.id)).toEqual({
      name: `Deleted ${suffix}`,
      live: false,
      mergedIntoEntityId: survivor.id,
    });
  });
});
