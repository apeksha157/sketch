import { describe, expect, it } from "vitest";
import { type ResolutionEvalManifest, manifestSchema } from "./manifest";

describe("resolution eval manifest schema", () => {
  it("round-trips a valid manifest", () => {
    const manifest: ResolutionEvalManifest = {
      version: 1,
      generatedAt: "2026-08-29T00:00:00.000Z",
      sourceDatabase: "sketch_canvas_ai",
      targetFileCount: 100,
      files: [
        {
          id: "file-1",
          contentSha256: "abc123",
          contentLength: 42,
          contentClass: "meeting_transcript",
          contentCategory: "meeting",
          fileType: "meeting_transcript",
          source: "fireflies",
        },
      ],
      sets: {
        pendingDeferredReviewIds: ["review-1"],
        singleTokenPersonReviewIds: ["review-1"],
        firstNameCollisionPersonEntityIds: ["person-1", "person-2"],
        companyPendingReviewIds: [],
        dupSuspectPairs: [
          {
            reviewId: "review-1",
            employerEntityId: "company-1",
            candidateEntityIds: ["person-1", "person-2"],
          },
        ],
      },
      expectations: {
        queueCensus: { rows: 1 },
        stalenessSweepPreview: { uniqueMatchRows: 1 },
        adjacencyGroundTruth: {
          trials: 1,
          linked: 1,
          correct: 1,
          wrong: 0,
          abstainNoSignal: 0,
          abstainAmbiguous: 0,
          precision: 1,
          coverage: 1,
          knownWrongLinks: [],
        },
        aliasProvenancePreview: { totalLiveAliases: 0, byHeuristicSignal: {} },
        dupGroups: { pairCount: 1 },
      },
    };

    expect(manifestSchema.parse(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });
});
