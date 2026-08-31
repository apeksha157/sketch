import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { GenerateMeta } from "../connectors/gemini-generate";
import type { AgenticOptions, AgenticOutcome, AgenticTool } from "../connectors/openrouter-generate";
import { createLlmUsageRepository } from "../db/repositories/llm-usage";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB } from "../db/schema";
import { handleProposeGraphVerdicts } from "../mcp/curation/propose-graph-verdicts";
import {
  type BacklogSweepPendingDecision,
  type BacklogSweepQueueRow,
  backlogSweepEvidenceFileIds,
  createBacklogSweepContext,
  decideBacklogSweepRow,
} from "./backlog-sweep";
import { candidateLookupView, entitySummaryView, fileContextView, pairwiseEvidenceView } from "./judge-views";
import { parseAliasesString } from "./materialize-json";
import { ENTITY_INDEX_COLUMNS, type IndexEntityRow } from "./materialize-types";
import { buildCandidatePool, findEditDistanceMatches, normalizeStrict } from "./name-dedup";
import { normalizeEntityMatchName } from "./name-keys";

export interface JudgeDrainAgenticGenerator {
  generateAgenticJSON<T>(prompt: string, opts: AgenticOptions): Promise<AgenticOutcome<T>>;
}

export interface JudgeDrainDeps {
  db: Kysely<DB>;
  generateAgenticJSON: JudgeDrainAgenticGenerator["generateAgenticJSON"];
  model?: string | null;
}

export interface JudgeDrainOptions {
  limit?: number;
  propose?: boolean;
  rowIds?: string[];
}

export type JudgeDrainVerdictKind = "link" | "dismiss" | "distinct" | "merge" | "hold";

export interface JudgeDrainContaminatedPair {
  leftEntityId: string;
  rightEntityId: string;
  reason: "strict" | "edit_distance";
}

export interface JudgeDrainVerdictReport {
  rowId: string;
  name: string;
  entityType: string;
  verdict: JudgeDrainVerdictKind;
  targetEntityId?: string;
  mergePair?: [string, string];
  reason: string;
  contaminated: JudgeDrainContaminatedPair[];
  toolCalls: number;
  costUsd: number | null;
}

export interface JudgeDrainReport {
  scanned: number;
  docket: number;
  sweepLinkable: number;
  skippedNoEvidence: number;
  verdicts: JudgeDrainVerdictReport[];
  counts: Record<JudgeDrainVerdictKind, number>;
  guard: { demotedUnoffered: number };
  proposed?: { filed: number; alreadyProposed: number; bounced: number };
  failures: Array<{ rowId: string; error: string }>;
}

type EvidenceExcerpt = {
  fileId: string;
  fileName: string;
  source: string;
  content: string;
};

type PendingDocketRow = {
  row: BacklogSweepQueueRow;
  decision: BacklogSweepPendingDecision;
  evidence: EvidenceExcerpt[];
};

type RawJudgeVerdict = {
  verdict?: unknown;
  entityId?: unknown;
  targetEntityId?: unknown;
  ruledOutEntityIds?: unknown;
  mergePair?: unknown;
  reason?: unknown;
  consideredCandidates?: unknown;
  notes?: unknown;
};

const DEFAULT_MODEL = "openai/gpt-5.6-luna";
const DOCKET_DECISIONS = new Set([
  "adjacencyContested",
  "adjacencyVetoed",
  "multiMatch",
  "skippedSingleTokenExact",
  "blockedByDistinct",
]);

const candidateLookupArgsSchema = z.object({ name: z.string().min(1), entityType: z.string().min(1) });
const entitySummaryArgsSchema = z.object({ entityId: z.string().min(1) });
const pairwiseEvidenceArgsSchema = z.object({ entityIds: z.array(z.string().min(1)).min(2).max(5) });
const fileContextArgsSchema = z.object({ fileId: z.string().min(1) });

function emptyCounts(): Record<JudgeDrainVerdictKind, number> {
  return { link: 0, dismiss: 0, distinct: 0, merge: 0, hold: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function hasSurvivingCandidates(decision: BacklogSweepPendingDecision): boolean {
  return decision.kind !== "link" && (decision.candidateIds?.length ?? 0) > 0;
}

function isDocketDecision(decision: BacklogSweepPendingDecision): boolean {
  if (decision.kind === "link") return false;
  if (decision.kind === "blockedByDistinct") return hasSurvivingCandidates(decision);
  return DOCKET_DECISIONS.has(decision.kind);
}

function parseCandidateIds(decision: BacklogSweepPendingDecision): string[] {
  return decision.kind === "link" ? [decision.targetEntityId] : orderedUnique(decision.candidateIds ?? []);
}

function collectOfferedIdsFromValue(value: unknown, offeredIds: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectOfferedIdsFromValue(item, offeredIds);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if ((key === "id" || key === "entityId") && typeof nested === "string" && nested.trim()) {
      offeredIds.add(nested);
    }
    collectOfferedIdsFromValue(nested, offeredIds);
  }
}

function collectOfferedIdsFromJson(text: string, offeredIds: Set<string>): void {
  try {
    collectOfferedIdsFromValue(JSON.parse(text), offeredIds);
  } catch {}
}

function judgeTools(db: Kysely<DB>, offeredIds: Set<string>): AgenticTool[] {
  return [
    {
      name: "candidate_lookup",
      description: "Find live and tombstoned candidate entities by name and entity type.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, entityType: { type: "string" } },
        required: ["name", "entityType"],
      },
      run: async (args) => {
        const result = await candidateLookupView(db, candidateLookupArgsSchema.parse(args));
        collectOfferedIdsFromJson(result, offeredIds);
        return result;
      },
    },
    {
      name: "entity_summary",
      description:
        "Return a compact summary of an entity id, including aliases, evidence, relationships, and email hints.",
      parameters: {
        type: "object",
        properties: { entityId: { type: "string" } },
        required: ["entityId"],
      },
      run: async (args) => {
        const { entityId } = entitySummaryArgsSchema.parse(args);
        const result = await entitySummaryView(db, entityId);
        collectOfferedIdsFromJson(result, offeredIds);
        return result;
      },
    },
    {
      name: "pairwise_evidence",
      description: "Return shared evidence and pairwise overlap for two to five entity ids.",
      parameters: {
        type: "object",
        properties: { entityIds: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 } },
        required: ["entityIds"],
      },
      run: async (args) => {
        const { entityIds } = pairwiseEvidenceArgsSchema.parse(args);
        const result = await pairwiseEvidenceView(db, entityIds);
        collectOfferedIdsFromJson(result, offeredIds);
        return result;
      },
    },
    {
      name: "file_context",
      description: "Return metadata and mentioned entity context for an evidence file id.",
      parameters: {
        type: "object",
        properties: { fileId: { type: "string" } },
        required: ["fileId"],
      },
      run: async (args) => {
        const { fileId } = fileContextArgsSchema.parse(args);
        const result = await fileContextView(db, fileId);
        collectOfferedIdsFromJson(result, offeredIds);
        return result;
      },
    },
  ];
}

async function loadPendingRows(db: Kysely<DB>, rowIds: string[] | undefined): Promise<BacklogSweepQueueRow[]> {
  let query = db.selectFrom("entity_review_queue").selectAll().where("status", "=", "pending");
  const ids = orderedUnique(rowIds ?? []);
  if (ids.length > 0) query = query.where("id", "in", ids);
  const rows = await query.orderBy("first_seen_at", "asc").orderBy("id", "asc").execute();
  return rows.sort((left, right) => {
    const typeOrder = (type: string) => (type === "person" ? 0 : type === "company" ? 1 : 2);
    const typeDelta = typeOrder(left.entity_type) - typeOrder(right.entity_type);
    if (typeDelta !== 0) return typeDelta;
    if (left.first_seen_at !== right.first_seen_at) return left.first_seen_at.localeCompare(right.first_seen_at);
    return left.id.localeCompare(right.id);
  });
}

async function loadEvidenceExcerpts(db: Kysely<DB>, reviewId: string): Promise<EvidenceExcerpt[]> {
  const rows = await db
    .selectFrom("entity_review_evidence")
    .innerJoin("indexed_files", "indexed_files.id", "entity_review_evidence.indexed_file_id")
    .select([
      "indexed_files.id as file_id",
      "indexed_files.file_name",
      "indexed_files.source",
      "indexed_files.content",
      "entity_review_evidence.seen_at",
      "entity_review_evidence.id as evidence_id",
    ])
    .where("entity_review_evidence.review_id", "=", reviewId)
    .orderBy("entity_review_evidence.seen_at", "asc")
    .orderBy("entity_review_evidence.id", "asc")
    .execute();
  const byFile = new Map<string, EvidenceExcerpt>();
  for (const row of rows) {
    const content = row.content?.trim();
    if (!content || byFile.has(row.file_id)) continue;
    byFile.set(row.file_id, {
      fileId: row.file_id,
      fileName: row.file_name,
      source: row.source,
      content: content.slice(0, 2000),
    });
  }
  return [...byFile.values()].slice(0, 3);
}

async function selectDocket(
  db: Kysely<DB>,
  opts: JudgeDrainOptions,
): Promise<{
  scanned: number;
  sweepLinkable: number;
  skippedNoEvidence: number;
  docket: PendingDocketRow[];
}> {
  const rows = await loadPendingRows(db, opts.rowIds);
  const ctx = await createBacklogSweepContext(db);
  const docket: PendingDocketRow[] = [];
  let sweepLinkable = 0;
  let skippedNoEvidence = 0;
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : Number.POSITIVE_INFINITY;

  for (const row of rows) {
    const evidence = await loadEvidenceExcerpts(db, row.id);
    if (evidence.length === 0) {
      skippedNoEvidence += 1;
      continue;
    }
    const decision = await decideBacklogSweepRow(ctx, row);
    if (decision.kind === "link") {
      sweepLinkable += 1;
      continue;
    }
    if (!isDocketDecision(decision)) continue;
    if (docket.length < limit) docket.push({ row, decision, evidence });
  }

  return { scanned: rows.length, sweepLinkable, skippedNoEvidence, docket };
}

async function loadCandidates(db: Kysely<DB>, ids: readonly string[]): Promise<IndexEntityRow[]> {
  const orderedIds = orderedUnique([...ids]);
  if (orderedIds.length === 0) return [];
  const rows = await db
    .selectFrom("entities")
    .select([...ENTITY_INDEX_COLUMNS])
    .where("id", "in", orderedIds)
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return orderedIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

function candidateValues(candidate: IndexEntityRow): string[] {
  return [candidate.name, ...parseAliasesString(candidate.aliases)].filter((value) => value.trim().length > 0);
}

function contaminatedPairs(candidates: IndexEntityRow[]): JudgeDrainContaminatedPair[] {
  const pairs = new Map<string, JudgeDrainContaminatedPair>();
  const strictByKey = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    for (const value of candidateValues(candidate)) {
      const key = normalizeStrict(value);
      if (!key) continue;
      const ids = strictByKey.get(key);
      if (ids) ids.add(candidate.id);
      else strictByKey.set(key, new Set([candidate.id]));
    }
  }
  for (const ids of strictByKey.values()) {
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        pairs.set(`${sorted[i]}\u0000${sorted[j]}`, {
          leftEntityId: sorted[i],
          rightEntityId: sorted[j],
          reason: "strict",
        });
      }
    }
  }

  const pool = buildCandidatePool(
    candidates.flatMap((candidate) =>
      candidateValues(candidate).map((value) => ({ entityId: candidate.id, valueKind: "name" as const, value })),
    ),
  );
  for (const candidate of candidates) {
    for (const value of candidateValues(candidate)) {
      for (const hit of findEditDistanceMatches(value, pool)) {
        if (hit.entityId === candidate.id) continue;
        const [left, right] = [candidate.id, hit.entityId].sort((a, b) => a.localeCompare(b));
        const key = `${left}\u0000${right}`;
        if (!pairs.has(key)) pairs.set(key, { leftEntityId: left, rightEntityId: right, reason: "edit_distance" });
      }
    }
  }
  return [...pairs.values()].sort(
    (left, right) =>
      left.leftEntityId.localeCompare(right.leftEntityId) || left.rightEntityId.localeCompare(right.rightEntityId),
  );
}

async function loadOrgContext(db: Kysely<DB>): Promise<Record<string, unknown> | null> {
  const settings = await db
    .selectFrom("settings")
    .select(["org_name", "org_context"])
    .where("id", "=", "default")
    .executeTakeFirst();
  if (!settings) return null;
  let parsedContext: unknown = null;
  try {
    parsedContext = settings.org_context ? JSON.parse(settings.org_context) : null;
  } catch {}
  const context = {
    ...(settings.org_name ? { name: settings.org_name } : {}),
    ...(parsedContext && typeof parsedContext === "object" && !Array.isArray(parsedContext) ? parsedContext : {}),
  };
  return Object.keys(context).length > 0 ? context : null;
}

function buildPrompt(params: {
  row: BacklogSweepQueueRow;
  decision: BacklogSweepPendingDecision;
  candidates: IndexEntityRow[];
  contaminated: JudgeDrainContaminatedPair[];
  evidence: EvidenceExcerpt[];
  orgContext: Record<string, unknown> | null;
}): string {
  const candidateLines = params.candidates.map((candidate) => {
    const aliases = parseAliasesString(candidate.aliases).slice(0, 4);
    return {
      id: candidate.id,
      name: candidate.name,
      type: candidate.source_type,
      provenanceTier: candidate.provenance_tier,
      aliases,
    };
  });
  const row = {
    id: params.row.id,
    proposedName: params.row.proposed_name,
    normalizedName: params.row.normalized_name,
    entityType: params.row.entity_type,
    proposedEmail: params.row.proposed_email,
    occurrenceCount: params.row.occurrence_count,
    source: params.row.source,
    sourceId: params.row.source_id,
    deterministicOutcome: params.decision.kind,
  };
  return [
    "You are the Sketch graph judge for one unresolved entity review queue row.",
    "Return only JSON with one of these shapes:",
    '{"verdict":"link","entityId":"<candidate entity id>","reason":"..."}',
    '{"verdict":"dismiss","reason":"junk/not-an-entity explanation"}',
    '{"verdict":"distinct","ruledOutEntityIds":["<candidate entity id>"],"reason":"..."}',
    '{"verdict":"merge","mergePair":["<candidate entity id>","<candidate entity id>"],"reason":"..."}',
    '{"verdict":"hold","consideredCandidates":[{"entityId":"<candidate entity id>","note":"..."}],"reason":"..."}',
    "Copy entity ids verbatim from the candidate list or from tool-result JSON. Never invent ids from memory.",
    "If contaminated pairs are present, link to either member only when the evidence identifies that exact record independently of the duplicate question, such as an email match or a unique attribute. Otherwise return merge for the pair and leave the row held.",
    "A merge verdict proposes that two candidate ids are the same real-world entity; it does not resolve this review row.",
    "A distinct verdict means the mention is real but is provably not one or more listed candidate ids.",
    "",
    `Queue row:\n${JSON.stringify(row, null, 2)}`,
    `Candidates:\n${JSON.stringify(candidateLines, null, 2)}`,
    `Contaminated pairs:\n${JSON.stringify(params.contaminated, null, 2)}`,
    `Org context:\n${JSON.stringify(params.orgContext, null, 2)}`,
    `Evidence excerpts:\n${JSON.stringify(params.evidence, null, 2)}`,
  ].join("\n");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function parseJudgeVerdict(raw: unknown): {
  verdict: JudgeDrainVerdictKind;
  targetEntityId?: string;
  mergePair?: [string, string];
  reason: string;
} {
  const parsed = z
    .object({
      verdict: z.enum(["link", "dismiss", "distinct", "merge", "hold"]),
      entityId: z.unknown().optional(),
      targetEntityId: z.unknown().optional(),
      ruledOutEntityIds: z.unknown().optional(),
      mergePair: z.unknown().optional(),
      reason: z.unknown().optional(),
      consideredCandidates: z.unknown().optional(),
      notes: z.unknown().optional(),
    })
    .passthrough()
    .parse(raw) as RawJudgeVerdict & { verdict: JudgeDrainVerdictKind };
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim()
      : typeof parsed.notes === "string" && parsed.notes.trim()
        ? parsed.notes.trim()
        : parsed.verdict;
  if (parsed.verdict === "link") {
    const target =
      typeof parsed.entityId === "string" && parsed.entityId.trim()
        ? parsed.entityId.trim()
        : typeof parsed.targetEntityId === "string" && parsed.targetEntityId.trim()
          ? parsed.targetEntityId.trim()
          : "";
    if (!target) throw new Error("link verdict missing entityId");
    return { verdict: "link", targetEntityId: target, reason };
  }
  if (parsed.verdict === "merge") {
    const pair = stringArray(parsed.mergePair);
    if (pair.length !== 2) throw new Error("merge verdict requires exactly two mergePair ids");
    return { verdict: "merge", mergePair: [pair[0], pair[1]], reason };
  }
  if (parsed.verdict === "distinct") {
    const ruledOut = stringArray(parsed.ruledOutEntityIds);
    if (ruledOut.length === 0) throw new Error("distinct verdict missing ruledOutEntityIds");
    return { verdict: "distinct", reason: `${reason}; ruledOut=${orderedUnique(ruledOut).join(",")}` };
  }
  return { verdict: parsed.verdict, reason };
}

function applyUnofferedGuard(
  verdict: ReturnType<typeof parseJudgeVerdict>,
  offeredIds: ReadonlySet<string>,
): { verdict: ReturnType<typeof parseJudgeVerdict>; demoted: boolean } {
  if (verdict.verdict === "link") {
    return verdict.targetEntityId && offeredIds.has(verdict.targetEntityId)
      ? { verdict, demoted: false }
      : { verdict: { verdict: "hold", reason: "unoffered_target" }, demoted: true };
  }
  if (verdict.verdict === "merge") {
    const [left, right] = verdict.mergePair ?? ["", ""];
    return offeredIds.has(left) && offeredIds.has(right)
      ? { verdict, demoted: false }
      : { verdict: { verdict: "hold", reason: "unoffered_target" }, demoted: true };
  }
  return { verdict, demoted: false };
}

async function recordUsage(db: Kysely<DB>, meta: GenerateMeta | null): Promise<void> {
  if (!meta) return;
  try {
    await createLlmUsageRepository(db).recordUsage({
      context: "judge:drain",
      model: meta.model,
      outcome: meta.outcome,
      promptTokens: meta.usage?.promptTokens ?? null,
      completionTokens: meta.usage?.completionTokens ?? null,
      durationMs: meta.durationMs,
      costUsd: meta.costUsd ?? null,
    });
  } catch {}
}

async function judgeRow(params: {
  deps: JudgeDrainDeps;
  row: BacklogSweepQueueRow;
  decision: BacklogSweepPendingDecision;
  evidence: EvidenceExcerpt[];
  orgContext: Record<string, unknown> | null;
}): Promise<{ report: JudgeDrainVerdictReport; demotedUnoffered: boolean }> {
  const candidateIds = parseCandidateIds(params.decision);
  const candidates = await loadCandidates(params.deps.db, candidateIds);
  const contaminated = contaminatedPairs(candidates);
  const offeredIds = new Set(candidates.map((candidate) => candidate.id));
  const prompt = buildPrompt({ ...params, candidates, contaminated });
  let meta: GenerateMeta | null = null;
  const outcome = await params.deps.generateAgenticJSON<unknown>(prompt, {
    maxToolRounds: 4,
    maxTokens: 4096,
    label: `judgeDrain:${params.row.id}`,
    model: params.deps.model,
    reasoningEffort: "medium",
    thinkingBudget: null,
    tools: judgeTools(params.deps.db, offeredIds),
    onMeta: (value) => {
      meta = value;
    },
  });
  if (!meta) meta = outcome.meta;
  await recordUsage(params.deps.db, meta);
  const guarded = applyUnofferedGuard(parseJudgeVerdict(outcome.value), offeredIds);
  return {
    report: {
      rowId: params.row.id,
      name: params.row.proposed_name,
      entityType: params.row.entity_type,
      verdict: guarded.verdict.verdict,
      ...(guarded.verdict.targetEntityId ? { targetEntityId: guarded.verdict.targetEntityId } : {}),
      ...(guarded.verdict.mergePair ? { mergePair: guarded.verdict.mergePair } : {}),
      reason: guarded.verdict.reason,
      contaminated,
      toolCalls: outcome.toolSteps.length,
      costUsd: meta.costUsd ?? null,
    },
    demotedUnoffered: guarded.demoted,
  };
}

async function judgeRowWithRetry(
  params: Parameters<typeof judgeRow>[0],
): Promise<Awaited<ReturnType<typeof judgeRow>>> {
  try {
    return await judgeRow(params);
  } catch {
    return judgeRow(params);
  }
}

async function activeProposalExists(db: Kysely<DB>, row: BacklogSweepQueueRow, verdict: JudgeDrainVerdictReport) {
  if (verdict.verdict === "link" || verdict.verdict === "dismiss") {
    let query = db
      .selectFrom("graph_verdicts")
      .select("id")
      .where("subject_mention_name", "=", normalizeEntityMatchName(row.entity_type, row.proposed_name))
      .where("subject_entity_type", "=", row.entity_type)
      .where("action", "=", verdict.verdict === "link" ? "link_to" : "dismiss")
      .where("status", "in", ["awaiting_human", "approved"])
      .where("superseded_at", "is", null);
    query =
      verdict.verdict === "link"
        ? query.where("target_entity_id", "=", verdict.targetEntityId ?? "")
        : query.where("target_entity_id", "is", null);
    return Boolean(await query.executeTakeFirst());
  }
  if (verdict.verdict === "merge" && verdict.mergePair) {
    const [subjectEntityId, targetEntityId] = verdict.mergePair;
    return Boolean(
      await db
        .selectFrom("graph_verdicts")
        .select("id")
        .where("subject_entity_id", "=", subjectEntityId)
        .where("action", "=", "merge_into")
        .where("target_entity_id", "=", targetEntityId)
        .where("status", "in", ["awaiting_human", "approved"])
        .where("superseded_at", "is", null)
        .executeTakeFirst(),
    );
  }
  return false;
}

async function fileProposal(params: {
  db: Kysely<DB>;
  row: BacklogSweepQueueRow;
  verdict: JudgeDrainVerdictReport;
}): Promise<"filed" | "alreadyProposed" | "bounced" | "skipped"> {
  if (params.verdict.verdict !== "link" && params.verdict.verdict !== "dismiss" && params.verdict.verdict !== "merge") {
    return "skipped";
  }
  if (await activeProposalExists(params.db, params.row, params.verdict)) return "alreadyProposed";
  const fileIds = await backlogSweepEvidenceFileIds(params.db, params.row.id);
  const evidence = { fileIds, reviewIds: [params.row.id], notes: [params.verdict.reason] };
  const verdict =
    params.verdict.verdict === "merge" && params.verdict.mergePair
      ? {
          action: "merge_into" as const,
          subjectEntityId: params.verdict.mergePair[0],
          targetEntityId: params.verdict.mergePair[1],
          reason: params.verdict.reason,
          evidence,
        }
      : {
          action: params.verdict.verdict === "link" ? ("link_to" as const) : ("dismiss" as const),
          subjectMentionName: params.row.proposed_name,
          subjectEntityType: params.row.entity_type,
          ...(params.verdict.targetEntityId ? { targetEntityId: params.verdict.targetEntityId } : {}),
          reason: params.verdict.reason,
          evidence,
        };
  const result = await handleProposeGraphVerdicts({ verdicts: [verdict] }, params.db, {
    userId: MACHINE_PRINCIPAL_USER_ID,
    tokenId: "judge-drain",
  });
  const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
    stored?: number;
    results?: Array<{ disposition?: string }>;
  };
  if ((parsed.stored ?? 0) > 0) return "filed";
  return parsed.results?.some((row) => row.disposition === "bounced") ? "bounced" : "skipped";
}

export async function runJudgeDrain(deps: JudgeDrainDeps, opts: JudgeDrainOptions = {}): Promise<JudgeDrainReport> {
  const selected = await selectDocket(deps.db, opts);
  const report: JudgeDrainReport = {
    scanned: selected.scanned,
    docket: selected.docket.length,
    sweepLinkable: selected.sweepLinkable,
    skippedNoEvidence: selected.skippedNoEvidence,
    verdicts: [],
    counts: emptyCounts(),
    guard: { demotedUnoffered: 0 },
    ...(opts.propose ? { proposed: { filed: 0, alreadyProposed: 0, bounced: 0 } } : {}),
    failures: [],
  };
  const orgContext = await loadOrgContext(deps.db);

  for (const entry of selected.docket) {
    try {
      const judged = await judgeRowWithRetry({
        deps,
        row: entry.row,
        decision: entry.decision,
        evidence: entry.evidence,
        orgContext,
      });
      report.verdicts.push(judged.report);
      report.counts[judged.report.verdict] += 1;
      if (judged.demotedUnoffered) report.guard.demotedUnoffered += 1;
      if (opts.propose && report.proposed) {
        const filed = await fileProposal({ db: deps.db, row: entry.row, verdict: judged.report });
        if (filed === "filed") report.proposed.filed += 1;
        if (filed === "alreadyProposed") report.proposed.alreadyProposed += 1;
        if (filed === "bounced") report.proposed.bounced += 1;
      }
    } catch (error) {
      report.failures.push({ rowId: entry.row.id, error: errorMessage(error) });
    }
  }

  return report;
}

export function defaultJudgeDrainModel(model: string | null | undefined): string {
  return (
    model?.trim() ||
    process.env.CONSOLIDATED_LOOP_MODEL?.trim() ||
    process.env.PROJECT_MINTING_MODEL?.trim() ||
    DEFAULT_MODEL
  );
}
