import type { MintContextBlock } from "./mint-context";

export type EnrichmentStageKey =
  | "extractEntities"
  | "dedupAdjudicate"
  | "reconcileFacts"
  | "matchEntities"
  | "generateSummary"
  | "extractEntityFacts"
  | "engagementFloor"
  | "materialize";

/**
 * Task minting's own stages. Kept in the same vocabulary as enrichment so one
 * ring, one dump reader and one rail serve both pipelines; the keys are
 * disjoint, so a report always says which pipeline it came from.
 */
export type MintStageKey = "neighbourhood" | "gatherContext" | "extractCandidates" | "writeCandidates";

/**
 * The `Search` tool's stages, in run order. Disjoint from the other two key sets, so a
 * report always says which pipeline produced it.
 *
 * `rerank` is retained for dev-tools compatibility and carries the settled positions
 * after `search()` returns. Entity ranking is applied only inside fusion, so this stage
 * is reported as skipped and never changes the order.
 */
export type SearchStageKey =
  | "discoverEntities"
  | "resolveEntities"
  | "embedQuery"
  | "ftsCandidates"
  | "vectorCandidates"
  | "fuse"
  | "filter"
  | "rbac"
  | "finalize"
  | "rerank"
  | "finalOutput";

export type StageKey = EnrichmentStageKey | MintStageKey | SearchStageKey;

export type EnrichmentStageKind = "model" | "code";
export type EnrichmentStageStatus = "done" | "failed" | "skipped";

export type StageOutcome = {
  subject: string;
  kind: string;
  result: "kept" | "dropped" | "created" | "updated" | "linked" | "queued" | "suppressed" | "deferred";
  reason?: string;
};

/**
 * One scored candidate's journey through hybrid search.
 *
 * The `StageOutcome` shape cannot carry a ranking, so search reports this instead. Emitted
 * once, on `rerank` — positions do not settle until the recency slice and email collapse
 * have both run.
 */
export interface SearchCandidate {
  fileId: string;
  fileName: string;
  source: string;
  ftsRank: number | null;
  vecRank: number | null;
  similarity: number | null;
  boosted: boolean;
  score: number;
  /** Null once the candidate was dropped or merged into another result. */
  finalPosition: number | null;
  droppedAt: StageKey | null;
  dropReason: string | null;
  /** Set when email-thread collapse folded this file into another result. */
  mergedInto: string | null;
}

/**
 * One chunk the vector arm scored, before per-file dedup.
 *
 * Reported at chunk grain rather than file grain because that is where the cosine score
 * actually lives: a file's rank is decided by its single best chunk, and seeing which
 * chunk won — and which near-misses lost — is the only way to tell a bad embedding from
 * a bad query.
 */
/**
 * Which vector a hit came from. A file is searchable through four independent vectors,
 * and knowing which one matched is the difference between "the document is about this"
 * and "the document is called this".
 */
export type VectorHitSource = "content" | "file_name" | "summary" | "image";

export interface VectorChunkHit {
  rank: number;
  fileId: string;
  source: VectorHitSource;
  /** The text that was embedded: a chunk body, the file name, or the summary. */
  chunkPreview: string;
  distance: number;
  similarity: number;
  /** True when this hit became its file's representative and carried it to the fusion. */
  bestForFile: boolean;
}

export interface MaterializeStageSummary {
  eligibleFacts: number;
  indexBuilds: number;
  scopeKeyReads: number;
}

export interface StageReport {
  stage: StageKey;
  label: string;
  kind: EnrichmentStageKind;
  status: EnrichmentStageStatus;
  context?: MintContextBlock[];
  outcomes?: StageOutcome[];
  error?: string;
  parallelGroup?: string;
  summary?: Record<string, unknown>;
  materializeSummary?: MaterializeStageSummary;
  candidates?: SearchCandidate[];
  vectorChunks?: VectorChunkHit[];
}

export type StageReporter = (report: StageReport) => void;

export type { MintContextBlock } from "./mint-context";
