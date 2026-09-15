import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { ConsolidatedMention } from "../connectors/consolidated-loop";
import type { ExtractionStage } from "../db/repositories/extraction-stages";
import type { DB } from "../db/schema";
import {
  type ConsolidatedLoopReportFile,
  classifyLoopMentions,
  evaluateConsolidatedLoopStage,
} from "./consolidated-loop-report";

const mentions: ConsolidatedMention[] = [
  {
    mention: "Acme Corp",
    type: "company",
    variations: [],
    resolution: { kind: "known", entityId: "entity-acme" },
  },
  {
    mention: "Bob Jones",
    type: "person",
    variations: [],
    resolution: { kind: "tool", entityId: "entity-bob" },
  },
  {
    mention: "Fresh Product",
    type: "product",
    variations: [],
    resolution: { kind: "new" },
  },
  {
    mention: "Alex Smith",
    type: "person",
    variations: [],
    resolution: { kind: "hold", reason: "two plausible people", candidates: [] },
  },
];

function reportFile(contentHash: string | null): ConsolidatedLoopReportFile {
  return {
    id: "file-1",
    connector_config_id: "connector-1",
    file_name: "file.txt",
    file_type: "document",
    content_category: "document",
    content: "content",
    summary: "summary",
    source: "google_drive",
    source_path: "Drive/file.txt",
    thread_id: null,
    content_hash: contentHash,
    source_created_at: null,
    source_updated_at: null,
  };
}

function extractionStage(contentHash: string | null): ExtractionStage {
  return {
    id: "stage-1",
    indexed_file_id: "file-1",
    content_hash: contentHash,
    extractor_version: "loop-v1",
    status: "staged",
    staged_json: "not parsed for a stale row",
    model: "test-model",
    rounds: 1,
    tool_calls: 0,
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.001,
    duration_ms: 5,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  };
}

describe("consolidated loop report classification", () => {
  it("classifies linked, queued, and absent legacy mentions and surfaces hold reasons", () => {
    const diagnostics = classifyLoopMentions(
      mentions,
      [{ entityId: "legacy-acme", entityName: "  ACME   CORP ", entityType: "company" }],
      [{ normalizedName: "bob jones", entityType: "person", status: "pending" }],
      new Map([
        ["entity-acme", "Acme Corporation"],
        ["entity-bob", "Robert Jones"],
      ]),
    );

    expect(diagnostics).toEqual([
      {
        mention: "Acme Corp",
        type: "company",
        resolutionKind: "known",
        targetEntityId: "entity-acme",
        targetEntityName: "Acme Corporation",
        holdReason: null,
        legacy: { kind: "linked", entityId: "legacy-acme", entityName: "  ACME   CORP " },
      },
      {
        mention: "Bob Jones",
        type: "person",
        resolutionKind: "tool",
        targetEntityId: "entity-bob",
        targetEntityName: "Robert Jones",
        holdReason: null,
        legacy: { kind: "queued", status: "pending" },
      },
      {
        mention: "Fresh Product",
        type: "product",
        resolutionKind: "new",
        targetEntityId: null,
        targetEntityName: null,
        holdReason: null,
        legacy: { kind: "none" },
      },
      {
        mention: "Alex Smith",
        type: "person",
        resolutionKind: "hold",
        targetEntityId: null,
        targetEntityName: null,
        holdReason: "two plausible people",
        legacy: { kind: "none" },
      },
    ]);
  });

  it("marks a mismatched content hash stale without parsing or comparing the stage", async () => {
    const row = await evaluateConsolidatedLoopStage(
      {} as Kysely<DB>,
      reportFile("current-hash"),
      extractionStage("old-hash"),
    );

    expect(row).toEqual({
      fileId: "file-1",
      source: "docs",
      stageCreatedAt: "2026-09-14T00:00:00.000Z",
      stale: true,
      staleNote:
        "stale: stage content hash old-hash does not match current content hash current-hash; comparison skipped",
      stageContentHash: "old-hash",
      currentContentHash: "current-hash",
    });
  });
});
