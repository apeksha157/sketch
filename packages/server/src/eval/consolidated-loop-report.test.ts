import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { ExtractionStage } from "../db/repositories/extraction-stages";
import type { DB } from "../db/schema";
import { type ConsolidatedLoopReportFile, evaluateConsolidatedLoopStage } from "./consolidated-loop-report";

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
    enrichment_status: "enriched",
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
  it("marks a mismatched content hash stale without parsing or comparing the stage", async () => {
    const row = await evaluateConsolidatedLoopStage(
      {} as Kysely<DB>,
      reportFile("current-hash"),
      extractionStage("old-hash"),
    );

    expect(row).toEqual({
      fileId: "file-1",
      source: "docs",
      stageUpdatedAt: "2026-09-14T00:00:00.000Z",
      stale: true,
      staleNote:
        "stale: stage content hash old-hash does not match current content hash current-hash; comparison skipped",
      stageContentHash: "old-hash",
      currentContentHash: "current-hash",
    });
  });
});
