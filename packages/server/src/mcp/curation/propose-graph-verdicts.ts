import type { Kysely, Selectable } from "kysely";
import { z } from "zod/v4";
import {
  type GraphVerdictValidationStatus,
  type StoreGraphVerdictInput,
  type StoreVerdictDisposition,
  createGraphVerdictRepository,
  withGraphVerdictUniqueRetry,
} from "../../db/repositories/graph-verdicts";
import type { DB, EntitiesTable } from "../../db/schema";
import type { CleanupAction, CleanupVerdict } from "../../entities/cleanup-adjudication";
import { planCleanup } from "../../entities/cleanup-apply";
import { normalizeEntityMatchName } from "../../entities/name-keys";
import { resolveLiveEntity } from "../../entities/redirect";
import { GraphVerdictApplyError, mentionPlan } from "../../entities/verdict-apply";
import { fingerprintFor, mentionVerdictFingerprint } from "../../entities/verdict-fingerprint";
import { jsonResult } from "./queries";

const entityActions = ["keep", "merge_into", "nest_under", "archive", "remove_alias"] as const;
const mentionActions = ["link_to", "dismiss"] as const;

const evidenceSchema = z.object({
  fileIds: z.array(z.string()).optional(),
  reviewIds: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

const entityVerdictSchema = z.object({
  action: z.enum(entityActions),
  subjectEntityId: z.string().min(1),
  targetEntityId: z.string().min(1).optional(),
  targetName: z.string().min(1).optional(),
  reason: z.string().min(1),
  evidence: evidenceSchema.optional(),
});

const mentionVerdictSchema = z.object({
  action: z.enum(mentionActions),
  subjectMentionName: z.string().min(1),
  subjectEntityType: z.string().min(1),
  targetEntityId: z.string().min(1).optional(),
  reason: z.string().min(1),
  evidence: evidenceSchema.optional(),
});

export const proposeGraphVerdictsSchema = {
  note: z.string().optional(),
  verdicts: z
    .array(z.union([entityVerdictSchema, mentionVerdictSchema]))
    .min(1)
    .max(25),
};

export type ProposeGraphVerdictsArgs = z.infer<z.ZodObject<typeof proposeGraphVerdictsSchema>>;

type EntityRow = Selectable<EntitiesTable>;
type EntityProposal = z.infer<typeof entityVerdictSchema>;
type MentionProposal = z.infer<typeof mentionVerdictSchema>;
type Proposal = ProposeGraphVerdictsArgs["verdicts"][number];

type NormalizedEvidence = {
  fileIds: string[];
  reviewIds: string[];
  notes: string[];
};

type PreparedEntityProposal = {
  kind: "entity";
  index: number;
  proposal: EntityProposal;
  evidence: NormalizedEvidence;
  subject: EntityRow | null;
  target: EntityRow | null;
};

type PreparedMentionProposal = {
  kind: "mention";
  index: number;
  proposal: MentionProposal;
  normalizedMentionName: string;
  evidence: NormalizedEvidence;
  target: EntityRow | null;
};

type PreparedProposal = PreparedEntityProposal | PreparedMentionProposal;

type ProposalResult = {
  verdictId: string;
  action: CleanupAction | "link_to" | "dismiss";
  subjectEntityId: string | null;
  subjectMentionName?: string | null;
  subjectEntityType?: string | null;
  targetName: string | null;
  validationStatus: GraphVerdictValidationStatus;
  validationReason: string | null;
  wouldChange: Record<string, number> | null;
  disposition: ProposalDisposition;
};

type ProposalDisposition =
  | "awaiting_human"
  | "bounced"
  | "pending_corroboration"
  | "veto_window"
  | "corroborated"
  | "ripened"
  | "revived";

type StoredProposalBatch = {
  runId: string;
  stored: number;
  bounced: number;
  results: ProposalResult[];
};

function isMentionProposal(proposal: Proposal): proposal is MentionProposal {
  return "subjectMentionName" in proposal;
}

function sortedCapped(values: string[] | undefined, max: number): string[] {
  return [...new Set(values ?? [])].sort((a, b) => a.localeCompare(b)).slice(0, max);
}

function normalizeEvidence(proposal: Proposal): NormalizedEvidence {
  return {
    fileIds: sortedCapped(proposal.evidence?.fileIds, 25),
    reviewIds: sortedCapped(proposal.evidence?.reviewIds, 25),
    notes: sortedCapped(proposal.evidence?.notes, 6),
  };
}

function preparedFingerprint(prepared: PreparedEntityProposal): string {
  return fingerprintFor({
    action: prepared.proposal.action,
    subject: prepared.subject,
    target: prepared.target,
    ...(prepared.proposal.action === "remove_alias" ? { targetName: prepared.proposal.targetName ?? null } : {}),
    evidence: prepared.evidence,
  });
}

function mentionFallbackFingerprint(prepared: PreparedMentionProposal): string {
  return mentionVerdictFingerprint({
    action: prepared.proposal.action,
    mentionName: prepared.normalizedMentionName,
    entityType: prepared.proposal.subjectEntityType,
    rows: [],
    target: prepared.target,
  });
}

function bouncedVerdict(prepared: PreparedProposal, validationReason: string): StoreGraphVerdictInput {
  if (prepared.kind === "mention") {
    return {
      runId: "",
      action: prepared.proposal.action,
      subjectEntityId: null,
      subjectContainerId: null,
      subjectMentionName: prepared.normalizedMentionName,
      subjectName: prepared.proposal.subjectMentionName,
      subjectEntityType: prepared.proposal.subjectEntityType,
      targetEntityId: prepared.proposal.targetEntityId ?? null,
      targetName: prepared.target?.name ?? null,
      reason: prepared.proposal.reason,
      evidenceJson: JSON.stringify(prepared.evidence),
      evidenceFingerprint: mentionFallbackFingerprint(prepared),
      validationStatus: "failed",
      validationReason,
      wouldChangeJson: null,
      status: "bounced",
    };
  }
  return {
    runId: "",
    action: prepared.proposal.action,
    subjectEntityId: prepared.proposal.subjectEntityId,
    subjectName: prepared.subject?.name ?? null,
    subjectEntityType: prepared.subject?.source_type ?? null,
    targetEntityId: prepared.proposal.targetEntityId ?? null,
    targetName:
      prepared.proposal.action === "remove_alias"
        ? (prepared.proposal.targetName ?? null)
        : (prepared.target?.name ?? null),
    reason: prepared.proposal.reason,
    evidenceJson: JSON.stringify(prepared.evidence),
    evidenceFingerprint: preparedFingerprint(prepared),
    validationStatus: "failed",
    validationReason,
    wouldChangeJson: null,
    status: "bounced",
  };
}

function plannedEntityVerdict(
  prepared: PreparedEntityProposal,
  validationStatus: GraphVerdictValidationStatus,
  validationReason: string | null,
  wouldChange: Record<string, number> | null,
  resolvedTargetEntityId: string | null,
): StoreGraphVerdictInput {
  return {
    runId: "",
    action: prepared.proposal.action,
    subjectEntityId: prepared.proposal.subjectEntityId,
    subjectName: prepared.subject?.name ?? null,
    subjectEntityType: prepared.subject?.source_type ?? null,
    targetEntityId: prepared.proposal.targetEntityId ?? null,
    resolvedTargetEntityId,
    targetName:
      prepared.proposal.action === "remove_alias"
        ? (prepared.proposal.targetName ?? null)
        : (prepared.target?.name ?? null),
    reason: prepared.proposal.reason,
    evidenceJson: JSON.stringify(prepared.evidence),
    evidenceFingerprint: preparedFingerprint(prepared),
    validationStatus,
    validationReason,
    wouldChangeJson: wouldChange ? JSON.stringify(wouldChange) : null,
    status: validationStatus === "ok" ? "awaiting_human" : "bounced",
  };
}

function plannedMentionVerdict(
  prepared: PreparedMentionProposal,
  validationStatus: GraphVerdictValidationStatus,
  validationReason: string | null,
  wouldChange: Record<string, number> | null,
  resolvedTargetEntityId: string | null,
  fingerprint: string,
): StoreGraphVerdictInput {
  return {
    runId: "",
    action: prepared.proposal.action,
    subjectEntityId: null,
    subjectContainerId: null,
    subjectMentionName: prepared.normalizedMentionName,
    subjectName: prepared.proposal.subjectMentionName,
    subjectEntityType: prepared.proposal.subjectEntityType,
    targetEntityId: prepared.proposal.targetEntityId ?? null,
    resolvedTargetEntityId,
    targetName: prepared.target?.name ?? null,
    reason: prepared.proposal.reason,
    evidenceJson: JSON.stringify(prepared.evidence),
    evidenceFingerprint: fingerprint,
    validationStatus,
    validationReason,
    wouldChangeJson: wouldChange ? JSON.stringify(wouldChange) : null,
    status: validationStatus === "ok" ? "awaiting_human" : "bounced",
  };
}

function toCleanupVerdict(prepared: PreparedEntityProposal): CleanupVerdict {
  return {
    entityId: prepared.proposal.subjectEntityId,
    name: prepared.subject?.name ?? prepared.proposal.subjectEntityId,
    action: prepared.proposal.action,
    targetEntityId: prepared.proposal.targetEntityId ?? null,
    targetName:
      prepared.proposal.action === "remove_alias"
        ? (prepared.proposal.targetName ?? null)
        : (prepared.target?.name ?? null),
    reason: prepared.proposal.reason,
    evidence: prepared.evidence.notes,
    mechanical: false,
    approved: true,
    validation: "ok",
    validationReason: null,
  };
}

async function loadEntities(db: Kysely<DB>, proposals: Proposal[]): Promise<Map<string, EntityRow>> {
  const ids = [
    ...new Set(
      proposals.flatMap((proposal) => {
        if (isMentionProposal(proposal)) return proposal.targetEntityId ? [proposal.targetEntityId] : [];
        return proposal.targetEntityId
          ? [proposal.subjectEntityId, proposal.targetEntityId]
          : [proposal.subjectEntityId];
      }),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom("entities").selectAll().where("id", "in", ids).execute();
  return new Map(rows.map((row) => [row.id, row]));
}

function prepareProposals(args: ProposeGraphVerdictsArgs, entities: Map<string, EntityRow>) {
  const seenPairs = new Set<string>();
  const rows: Array<StoreGraphVerdictInput | null> = [];
  const plannerInputs: PreparedProposal[] = [];

  for (const [index, proposal] of args.verdicts.entries()) {
    const evidence = normalizeEvidence(proposal);
    if (isMentionProposal(proposal)) {
      const normalizedMentionName = normalizeEntityMatchName(proposal.subjectEntityType, proposal.subjectMentionName);
      const prepared: PreparedMentionProposal = {
        kind: "mention",
        index,
        proposal,
        normalizedMentionName,
        evidence,
        target: proposal.targetEntityId ? (entities.get(proposal.targetEntityId) ?? null) : null,
      };
      const pairKey = `mention\u0000${normalizedMentionName}\u0000${proposal.subjectEntityType}\u0000${proposal.action}`;
      const duplicate = seenPairs.has(pairKey);
      seenPairs.add(pairKey);
      let validationReason: string | null = null;
      if (duplicate) validationReason = "duplicate_in_batch";
      else if (proposal.action === "link_to" && !proposal.targetEntityId) validationReason = "target_required";
      else if (proposal.targetEntityId && !prepared.target) validationReason = "target_not_found";

      if (validationReason) rows[index] = bouncedVerdict(prepared, validationReason);
      else {
        rows[index] = null;
        plannerInputs.push(prepared);
      }
      continue;
    }

    const prepared: PreparedEntityProposal = {
      kind: "entity",
      index,
      proposal,
      evidence,
      subject: entities.get(proposal.subjectEntityId) ?? null,
      target: proposal.targetEntityId ? (entities.get(proposal.targetEntityId) ?? null) : null,
    };
    const pairKey =
      proposal.action === "merge_into" && proposal.targetEntityId
        ? `merge\u0000${[proposal.subjectEntityId, proposal.targetEntityId].sort().join("\u0000")}`
        : `entity\u0000${proposal.subjectEntityId}\u0000${proposal.action}`;
    const duplicate = seenPairs.has(pairKey);
    seenPairs.add(pairKey);
    let validationReason: string | null = null;
    if (duplicate) validationReason = "duplicate_in_batch";
    else if (!prepared.subject) validationReason = "subject_not_found";
    else if ((proposal.action === "merge_into" || proposal.action === "nest_under") && !proposal.targetEntityId)
      validationReason = "target_required";
    else if (proposal.targetEntityId && !prepared.target) validationReason = "target_not_found";

    if (validationReason) {
      rows[index] = bouncedVerdict(prepared, validationReason);
    } else {
      rows[index] = null;
      plannerInputs.push(prepared);
    }
  }

  return { rows, plannerInputs };
}

/**
 * Mention rows ride on the same proposal seam as cleanup rows but use the
 * live review queue as their subject, so they validate through `mentionPlan`.
 */
async function validatePreparedProposal(db: Kysely<DB>, prepared: PreparedProposal): Promise<StoreGraphVerdictInput> {
  if (prepared.kind === "entity") {
    const [planRow] = await planCleanup(db, [toCleanupVerdict(prepared)]);
    if (!planRow) return plannedEntityVerdict(prepared, "failed", "invalid_action", null, null);
    return planRow.state === "applied"
      ? plannedEntityVerdict(prepared, "ok", null, planRow.wouldChange, planRow.resolvedTargetEntityId)
      : plannedEntityVerdict(
          prepared,
          "failed",
          planRow.reason ?? "invalid_action",
          null,
          planRow.resolvedTargetEntityId,
        );
  }

  const reviewRows = await db
    .selectFrom("entity_review_queue")
    .select(["id", "candidate_generated_at"])
    .where("normalized_name", "=", prepared.normalizedMentionName)
    .where("entity_type", "=", prepared.proposal.subjectEntityType)
    .where("status", "in", ["pending", "deferred"])
    .orderBy("id", "asc")
    .execute();
  const resolvedTarget = prepared.proposal.targetEntityId
    ? await resolveLiveEntity(db, prepared.proposal.targetEntityId)
    : null;
  const fingerprint = mentionVerdictFingerprint({
    action: prepared.proposal.action,
    mentionName: prepared.normalizedMentionName,
    entityType: prepared.proposal.subjectEntityType,
    rows: reviewRows,
    target: resolvedTarget,
  });

  try {
    const planRow = await mentionPlan(db, {
      id: "",
      action: prepared.proposal.action,
      subject_mention_name: prepared.normalizedMentionName,
      subject_entity_type: prepared.proposal.subjectEntityType,
      target_entity_id: prepared.proposal.targetEntityId ?? null,
      reason: prepared.proposal.reason,
    });
    return plannedMentionVerdict(
      prepared,
      "ok",
      null,
      planRow.wouldChange,
      planRow.resolvedTargetEntityId,
      fingerprint,
    );
  } catch (error) {
    const reason =
      error instanceof GraphVerdictApplyError && typeof error.details?.reason === "string"
        ? error.details.reason
        : "invalid_action";
    return plannedMentionVerdict(prepared, "failed", reason, null, null, fingerprint);
  }
}

/**
 * Corroborated/ripened/revived proposals landed on an EXISTING verdict (the
 * result's verdictId is that row's id, not a fresh insert); pending/veto
 * statuses are machine-filed merges ripening under §6. Everything else keeps
 * the original vocabulary.
 */
function proposalDisposition(stored: StoreVerdictDisposition, status: string): ProposalDisposition {
  if (stored === "corroborated" || stored === "ripened" || stored === "revived") return stored;
  if (status === "bounced") return "bounced";
  if (status === "pending_corroboration" || status === "veto_window") return status;
  return "awaiting_human";
}

function dispositionSummary(results: ProposalResult[]): string {
  const counts = new Map<string, number>([
    ["awaiting_human", 0],
    ["bounced", 0],
  ]);
  for (const result of results) {
    counts.set(result.disposition, (counts.get(result.disposition) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([key, count]) => count > 0 || ["awaiting_human", "bounced"].includes(key))
    .map(([key, count]) => `${key}=${count}`)
    .join(" ");
}

export async function handleProposeGraphVerdicts(
  args: ProposeGraphVerdictsArgs,
  db: Kysely<DB>,
  authContext: { userId: string; tokenId: string },
) {
  const batch = await withGraphVerdictUniqueRetry(async () =>
    db.transaction().execute(async (trx): Promise<StoredProposalBatch> => {
      const entities = await loadEntities(trx, args.verdicts);
      const { rows, plannerInputs } = prepareProposals(args, entities);

      for (const prepared of plannerInputs) {
        rows[prepared.index] = await validatePreparedProposal(trx, prepared);
      }

      const repo = createGraphVerdictRepository(trx);
      const run = await repo.createRun({
        source: "curation_mcp",
        proposedByUserId: authContext.userId,
        tokenId: authContext.tokenId,
        note: args.note ?? null,
        verdictsProposed: args.verdicts.length,
      });
      const verdictRows = rows.map((row) => {
        if (!row) throw new Error("Missing graph verdict row.");
        return { ...row, runId: run.id };
      });
      const stored = await repo.storeVerdicts(verdictRows);
      const results: ProposalResult[] = stored.rows.map((row, index) => ({
        verdictId: stored.ids[index] ?? "",
        action: row.action as ProposalResult["action"],
        subjectEntityId: row.subjectEntityId,
        subjectMentionName: row.subjectMentionName ?? null,
        subjectEntityType: row.subjectEntityType,
        targetName:
          args.verdicts[index] && "targetName" in args.verdicts[index]
            ? (args.verdicts[index].targetName ?? null)
            : null,
        validationStatus: row.validationStatus,
        validationReason: row.validationReason,
        wouldChange: row.wouldChangeJson ? (JSON.parse(row.wouldChangeJson) as Record<string, number>) : null,
        disposition: proposalDisposition(stored.dispositions[index] ?? "inserted", row.status),
      }));
      return {
        runId: run.id,
        stored: stored.dispositions.filter(
          (disposition, index) => disposition === "inserted" && stored.rows[index]?.status !== "bounced",
        ).length,
        bounced: stored.rows.filter((row) => row.status === "bounced").length,
        results,
      };
    }),
  );

  return jsonResult({
    runId: batch.runId,
    stored: batch.stored,
    bounced: batch.bounced,
    results: batch.results,
    summary: dispositionSummary(batch.results),
  });
}
