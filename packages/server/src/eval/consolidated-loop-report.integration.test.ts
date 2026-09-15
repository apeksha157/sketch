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
      .values({
        id: `review-${suffix}`,
        proposed_name: bobName,
        normalized_name: bobName.toLowerCase(),
        entity_type: "person",
        status: "pending",
        triggered_by_user_id: userId,
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: `evidence-${suffix}`,
        review_id: `review-${suffix}`,
        indexed_file_id: fileId,
        source: "llm_extraction",
      })
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
      legacyMentionCount: 1,
      loopMentionCount: 2,
      mentionRecall: 1,
      mentionPrecision: 0.5,
      legacyRelationCount: 1,
      loopRelationCount: 1,
      legacyFactCount: 1,
      loopFactCount: 1,
      legacyCostUsd: 0.01,
      loopCostUsd: 0.002,
      legacyTokens: 120,
      loopTokens: 75,
      resolvedLegacyQueuedCount: 1,
      mentionDiagnostics: [
        { mention: acmeName, resolutionKind: "known", legacy: { kind: "linked", entityName: acmeName } },
        { mention: bobName, resolutionKind: "tool", legacy: { kind: "queued", status: "pending" } },
      ],
    });
    const totals = aggregateConsolidatedLoopReport([row]);
    expect(totals).toMatchObject({
      files: 1,
      comparedFiles: 1,
      staleFiles: 0,
      legacyMentionCount: 1,
      loopMentionCount: 2,
      aggregateRecall: 1,
      resolvedLegacyQueuedCount: 1,
    });
    const markdown = renderConsolidatedLoopReportMarkdown("test-run", [row], totals);
    expect(markdown).toContain("Loop-resolved mentions queued by legacy: 1");
    expect(markdown).toContain(`legacy linked -> ${acmeName}`);
    expect(markdown).toContain("legacy queued (pending)");
  });
});
