import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable } from "kysely";
import type { DB, GraphVerdictRunsTable, GraphVerdictsTable } from "../schema";
import { MACHINE_PRINCIPAL_USER_ID } from "./machine-principal";

export type GraphVerdictRunRow = Selectable<GraphVerdictRunsTable>;
export type GraphVerdictRow = Selectable<GraphVerdictsTable>;
export type GraphVerdictStatus =
  | "awaiting_human"
  | "bounced"
  | "approved"
  | "rejected"
  | "applied"
  | "reverted"
  | "pending_corroboration"
  | "veto_window"
  | "retired";
export type GraphVerdictValidationStatus = "ok" | "failed";

/**
 * Statuses that occupy a slot in the partial unique indexes (migration 223).
 * Every predicate that decides "does an open verdict already exist for this
 * subject" must use this set — a hand-rolled two-status check silently lets
 * duplicate proposals through once machine states exist.
 */
export const GRAPH_VERDICT_ACTIVE_STATUSES = [
  "awaiting_human",
  "approved",
  "pending_corroboration",
  "veto_window",
] as const satisfies readonly GraphVerdictStatus[];

/** Statuses a human Confirm can approve; pending_corroboration has not ripened. */
export const GRAPH_VERDICT_APPROVABLE_STATUSES = ["awaiting_human", "veto_window"] as const;
/** Statuses a human Dismiss can reject — any machine-waiting state can be killed early. */
export const GRAPH_VERDICT_REJECTABLE_STATUSES = ["awaiting_human", "pending_corroboration", "veto_window"] as const;

/**
 * Unordered merge-pair identity: sorted entity ids joined with "|" (never
 * NUL — Postgres text cannot store zero bytes). A→B and B→A share one key.
 */
export function mergePairKey(subjectEntityId: string, targetEntityId: string): string {
  return subjectEntityId < targetEntityId
    ? `${subjectEntityId}|${targetEntityId}`
    : `${targetEntityId}|${subjectEntityId}`;
}

export const VETO_WINDOW_DAYS = 7;
export const DRY_STREAK_RETIRE_AT = 3;

export type CorroborationEntryKind = "reproposal" | "cross_source_cooccurrence" | "identity" | "contested_adjacency";

/**
 * One observed signal for a waiting merge. `clusterKey` bakes the independence
 * grouping in at append time (connector source + thread/rollup grouping, so
 * ten replies on one email thread are ONE cluster) — evaluation then needs no
 * file lookups. `supportsEntityId` records which side of the pair the signal
 * argues for, so the review UI can split evidence for/against.
 */
export type CorroborationEntry = {
  kind: CorroborationEntryKind;
  source: string;
  fileId: string | null;
  clusterKey: string;
  supportsEntityId: string | null;
  observedAt: string;
};

export type StoreVerdictDisposition = "inserted" | "bounced" | "corroborated" | "ripened" | "revived";

export function parseCorroboration(raw: string | null): CorroborationEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is CorroborationEntry =>
        !!entry && typeof entry === "object" && typeof (entry as { clusterKey?: unknown }).clusterKey === "string",
    );
  } catch {
    return [];
  }
}

/** Idempotency key: the same observation appended twice is one entry. */
export function corroborationKey(entry: Pick<CorroborationEntry, "kind" | "source" | "fileId">): string {
  return `${entry.kind}|${entry.source}|${entry.fileId ?? ""}`;
}

export function vetoUntilFrom(nowIso: string): string {
  return new Date(new Date(nowIso).getTime() + VETO_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The countable independence test: a corroboration entry counts only when its
 * cluster is outside the frozen proposal evidence's clusters and not already
 * counted. More of the same signal is not proof.
 */
export function independentClusterCount(proposalClusters: ReadonlySet<string>, entries: CorroborationEntry[]): number {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!proposalClusters.has(entry.clusterKey)) seen.add(entry.clusterKey);
  }
  return seen.size;
}

/** A merge ripens when proposal evidence plus independent corroboration reach two signals. */
export function shouldRipen(proposalClusters: ReadonlySet<string>, entries: CorroborationEntry[]): boolean {
  return Math.max(1, proposalClusters.size) + independentClusterCount(proposalClusters, entries) >= 2;
}

export function evidenceFileIdsOf(evidenceJson: string | null): string[] {
  if (!evidenceJson) return [];
  try {
    const parsed = JSON.parse(evidenceJson) as { fileIds?: unknown };
    return Array.isArray(parsed.fileIds) ? parsed.fileIds.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Source + thread grouping for evidence files. Files sharing a thread (or CRM
 * rollup group) collapse to one cluster; a file with neither groups alone.
 */
export async function loadEvidenceClusters(
  db: Kysely<DB>,
  fileIds: string[],
): Promise<Map<string, { source: string; clusterKey: string }>> {
  if (fileIds.length === 0) return new Map();
  const files = await db
    .selectFrom("indexed_files")
    .select(["id", "source", "thread_id", "rollup_group_id"])
    .where("id", "in", fileIds)
    .execute();
  return new Map(
    files.map((file) => [
      file.id,
      { source: file.source, clusterKey: `${file.source}:${file.thread_id ?? file.rollup_group_id ?? file.id}` },
    ]),
  );
}

export type GraphVerdictRunRollup = GraphVerdictRunRow & {
  rollups: Record<GraphVerdictStatus, number>;
};

export interface CreateGraphVerdictRunInput {
  source: string;
  proposedByUserId: string;
  tokenId: string | null;
  note: string | null;
  verdictsProposed: number;
}

export interface StoreGraphVerdictInput {
  runId: string;
  action: string;
  subjectEntityId: string | null;
  subjectContainerId?: string | null;
  subjectMentionName?: string | null;
  subjectName: string | null;
  subjectEntityType: string | null;
  targetEntityId: string | null;
  resolvedTargetEntityId?: string | null;
  targetName: string | null;
  reason: string;
  evidenceJson: string;
  evidenceFingerprint: string;
  validationStatus: GraphVerdictValidationStatus;
  validationReason: string | null;
  wouldChangeJson: string | null;
  status: GraphVerdictStatus;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}

function updatedCount(result: { numUpdatedRows?: bigint | number | string } | undefined): number {
  return Number(result?.numUpdatedRows ?? 0);
}

function toInsert(input: StoreGraphVerdictInput, id: string, now: string): Insertable<GraphVerdictsTable> {
  return {
    id,
    run_id: input.runId,
    action: input.action,
    subject_entity_id: input.subjectEntityId,
    subject_container_id: input.subjectContainerId ?? null,
    subject_mention_name: input.subjectMentionName ?? null,
    subject_name: input.subjectName,
    subject_entity_type: input.subjectEntityType,
    target_entity_id: input.targetEntityId,
    resolved_target_entity_id: input.resolvedTargetEntityId ?? null,
    target_name: input.targetName,
    reason: input.reason,
    evidence_json: input.evidenceJson,
    evidence_fingerprint: input.evidenceFingerprint,
    validation_status: input.validationStatus,
    validation_reason: input.validationReason,
    would_change_json: input.wouldChangeJson,
    status: input.status,
    superseded_at: null,
    decided_at: null,
    decided_by_user_id: null,
    applied_ledger_ref: null,
    veto_until: input.status === "veto_window" ? vetoUntilFrom(now) : null,
    corroboration_json: null,
    retired_reason: null,
    dry_streak: 0,
    merge_pair_key:
      input.action === "merge_into" && input.subjectEntityId && input.targetEntityId
        ? mergePairKey(input.subjectEntityId, input.targetEntityId)
        : null,
    created_at: now,
    updated_at: now,
  };
}

function approvedPendingBounce(input: StoreGraphVerdictInput): StoreGraphVerdictInput {
  return {
    ...input,
    validationStatus: "failed",
    validationReason: "approved_verdict_pending",
    wouldChangeJson: null,
    status: "bounced",
  };
}

function activeSubject(verdict: StoreGraphVerdictInput): {
  kind: "container" | "mention" | "entity";
  column: "subject_container_id" | "subject_mention_name" | "subject_entity_id";
  id: string;
  entityType?: string;
} {
  if (verdict.subjectContainerId) {
    return { kind: "container", column: "subject_container_id", id: verdict.subjectContainerId };
  }
  if (verdict.subjectMentionName && verdict.subjectEntityType) {
    return {
      kind: "mention",
      column: "subject_mention_name",
      id: verdict.subjectMentionName,
      entityType: verdict.subjectEntityType,
    };
  }
  if (verdict.subjectEntityId) return { kind: "entity", column: "subject_entity_id", id: verdict.subjectEntityId };
  throw new Error("Graph verdict subject is missing.");
}

async function withContainerSubjectEntity(
  db: Kysely<DB>,
  verdict: StoreGraphVerdictInput,
): Promise<StoreGraphVerdictInput> {
  if (!verdict.subjectContainerId || verdict.subjectEntityId || verdict.subjectMentionName) return verdict;
  const container = await db
    .selectFrom("containers")
    .select("classified_entity_id")
    .where("id", "=", verdict.subjectContainerId)
    .executeTakeFirst();
  return container?.classified_entity_id ? { ...verdict, subjectEntityId: container.classified_entity_id } : verdict;
}

/**
 * Verdict rows deliberately keep their original entity ids through merges.
 * They are historical proposals about a specific graph state; PR3 apply detects
 * drift by recomputing the fingerprint instead of silently repointing pending
 * approvals to a different subject.
 */
export function createGraphVerdictRepository(db: Kysely<DB>) {
  return {
    async createRun(input: CreateGraphVerdictRunInput): Promise<{ id: string }> {
      const id = randomUUID();
      await db
        .insertInto("graph_verdict_runs")
        .values({
          id,
          source: input.source,
          proposed_by_user_id: input.proposedByUserId,
          token_id: input.tokenId,
          note: input.note,
          verdicts_proposed: input.verdictsProposed,
          verdicts_stored: 0,
          verdicts_bounced: 0,
        })
        .execute();
      return { id };
    },

    /**
     * Merge proposals are keyed by unordered pair, and a re-proposal of a
     * waiting pair CORROBORATES the existing verdict instead of superseding it
     * (§6 ripening): its evidence appends to `corroboration_json` (frozen
     * `evidence_json`/fingerprint untouched, so STALE_VERDICT never fires on
     * ripening) and the returned id is the EXISTING verdict's. All pair
     * lookups run before the generic insert path — a proposal that reached
     * insertion against a waiting pair would hit the unique index instead of
     * corroborating. Non-merge rows keep the subject+action flow.
     */
    async storeVerdicts(
      verdicts: StoreGraphVerdictInput[],
    ): Promise<{ ids: string[]; rows: StoreGraphVerdictInput[]; dispositions: StoreVerdictDisposition[] }> {
      const now = new Date().toISOString();
      const rows: StoreGraphVerdictInput[] = [];
      const dispositions: StoreVerdictDisposition[] = [];
      const presetIds: (string | null)[] = [];
      const machineProposer = await (async () => {
        const runId = verdicts[0]?.runId;
        if (!runId) return false;
        const run = await db
          .selectFrom("graph_verdict_runs")
          .select("proposed_by_user_id")
          .where("id", "=", runId)
          .executeTakeFirst();
        return run?.proposed_by_user_id === MACHINE_PRINCIPAL_USER_ID;
      })();

      const isPairMerge = (
        verdict: StoreGraphVerdictInput,
      ): verdict is StoreGraphVerdictInput & {
        subjectEntityId: string;
        targetEntityId: string;
      } => verdict.action === "merge_into" && !!verdict.subjectEntityId && !!verdict.targetEntityId;

      for (const input of verdicts) {
        const verdict = await withContainerSubjectEntity(db, input);
        if (verdict.status !== "awaiting_human") {
          rows.push(verdict);
          dispositions.push(verdict.status === "bounced" ? "bounced" : "inserted");
          presetIds.push(null);
          continue;
        }

        if (isPairMerge(verdict)) {
          const pairKey = mergePairKey(verdict.subjectEntityId, verdict.targetEntityId);
          const pairRows = await db
            .selectFrom("graph_verdicts")
            .select(["id", "status", "evidence_json", "corroboration_json", "target_entity_id"])
            .where("merge_pair_key", "=", pairKey)
            .where("action", "=", "merge_into")
            .where("superseded_at", "is", null)
            .where("status", "in", [...GRAPH_VERDICT_ACTIVE_STATUSES, "retired"])
            .execute();

          if (pairRows.some((row) => row.status === "approved")) {
            rows.push(approvedPendingBounce(verdict));
            dispositions.push("bounced");
            presetIds.push(null);
            continue;
          }

          const waiting = pairRows.find(
            (row) => row.status === "pending_corroboration" || row.status === "veto_window",
          );
          if (waiting) {
            const proposalClusters = new Set(
              [...(await loadEvidenceClusters(db, evidenceFileIdsOf(waiting.evidence_json))).values()].map(
                (cluster) => cluster.clusterKey,
              ),
            );
            const existing = parseCorroboration(waiting.corroboration_json);
            const known = new Set(existing.map(corroborationKey));
            const clusters = await loadEvidenceClusters(db, evidenceFileIdsOf(verdict.evidenceJson));
            const additions: CorroborationEntry[] = [];
            for (const [fileId, cluster] of clusters) {
              const entry: CorroborationEntry = {
                kind: "reproposal",
                source: cluster.source,
                fileId,
                clusterKey: cluster.clusterKey,
                supportsEntityId: verdict.targetEntityId,
                observedAt: now,
              };
              if (!known.has(corroborationKey(entry))) additions.push(entry);
            }
            const merged = [...existing, ...additions];
            const ripens = waiting.status === "pending_corroboration" && shouldRipen(proposalClusters, merged);
            if (additions.length > 0 || ripens) {
              await db
                .updateTable("graph_verdicts")
                .set({
                  corroboration_json: JSON.stringify(merged),
                  updated_at: now,
                  ...(ripens ? { status: "veto_window", veto_until: vetoUntilFrom(now) } : {}),
                })
                .where("id", "=", waiting.id)
                .execute();
            }
            rows.push({ ...verdict, status: ripens ? "veto_window" : (waiting.status as GraphVerdictStatus) });
            dispositions.push(ripens ? "ripened" : "corroborated");
            presetIds.push(waiting.id);
            continue;
          }

          const retired = pairRows.find((row) => row.status === "retired");
          if (retired) {
            const recorded = new Set([
              ...evidenceFileIdsOf(retired.evidence_json),
              ...parseCorroboration(retired.corroboration_json)
                .map((entry) => entry.fileId)
                .filter((id): id is string => !!id),
            ]);
            const fresh = evidenceFileIdsOf(verdict.evidenceJson).filter((id) => !recorded.has(id));
            if (fresh.length === 0) {
              rows.push({
                ...verdict,
                validationStatus: "failed",
                validationReason: "retired_no_new_evidence",
                wouldChangeJson: null,
                status: "bounced",
              });
              dispositions.push("bounced");
              presetIds.push(null);
              continue;
            }
            const clusters = await loadEvidenceClusters(db, fresh);
            const revivalEntries: CorroborationEntry[] = [...clusters.entries()].map(([fileId, cluster]) => ({
              kind: "reproposal",
              source: cluster.source,
              fileId,
              clusterKey: cluster.clusterKey,
              supportsEntityId: verdict.targetEntityId,
              observedAt: now,
            }));
            await db
              .updateTable("graph_verdicts")
              .set({
                status: "pending_corroboration",
                retired_reason: null,
                dry_streak: 0,
                corroboration_json: JSON.stringify([
                  ...parseCorroboration(retired.corroboration_json),
                  ...revivalEntries,
                ]),
                updated_at: now,
              })
              .where("id", "=", retired.id)
              .where("status", "=", "retired")
              .execute();
            rows.push({ ...verdict, status: "pending_corroboration" });
            dispositions.push("revived");
            presetIds.push(retired.id);
            continue;
          }

          await db
            .updateTable("graph_verdicts")
            .set({ superseded_at: now, updated_at: now })
            .where("merge_pair_key", "=", pairKey)
            .where("action", "=", "merge_into")
            .where("status", "=", "awaiting_human")
            .where("superseded_at", "is", null)
            .execute();
          let status: GraphVerdictStatus = "awaiting_human";
          if (machineProposer) {
            const clusters = await loadEvidenceClusters(db, evidenceFileIdsOf(verdict.evidenceJson));
            const distinct = new Set([...clusters.values()].map((cluster) => cluster.clusterKey));
            status = distinct.size >= 2 ? "veto_window" : "pending_corroboration";
          }
          rows.push({ ...verdict, status });
          dispositions.push("inserted");
          presetIds.push(null);
          continue;
        }

        const subject = activeSubject(verdict);
        let approvedQuery = db
          .selectFrom("graph_verdicts")
          .select("id")
          .where(subject.column, "=", subject.id)
          .where("action", "=", verdict.action)
          .where("status", "=", "approved")
          .where("superseded_at", "is", null);
        if (subject.kind === "mention") {
          approvedQuery = approvedQuery.where("subject_entity_type", "=", subject.entityType ?? "");
        }
        const approved = await approvedQuery.executeTakeFirst();
        rows.push(approved ? approvedPendingBounce(verdict) : verdict);
        dispositions.push(approved ? "bounced" : "inserted");
        presetIds.push(null);
      }

      const ids = rows.map((row, index) => presetIds[index] ?? randomUUID());
      const inserts = rows
        .map((row, index) => ({ row, index }))
        .filter(({ index }) => dispositions[index] === "inserted" || dispositions[index] === "bounced");
      for (const { row, index } of inserts) {
        if (row.status !== "awaiting_human" || isPairMerge(row)) continue;
        const subject = activeSubject(row);
        let updateQuery = db
          .updateTable("graph_verdicts")
          .set({ superseded_at: now, updated_at: now })
          .where(subject.column, "=", subject.id)
          .where("action", "=", row.action)
          .where("status", "=", "awaiting_human")
          .where("superseded_at", "is", null);
        if (subject.kind === "mention") {
          updateQuery = updateQuery.where("subject_entity_type", "=", subject.entityType ?? "");
        }
        await updateQuery.execute();
      }
      if (inserts.length > 0) {
        await db
          .insertInto("graph_verdicts")
          .values(inserts.map(({ row, index }) => toInsert(row, ids[index] ?? randomUUID(), now)))
          .execute();
      }
      const runId = rows[0]?.runId;
      if (runId && rows.length > 0) {
        const stored = inserts.filter(({ row }) => row.status !== "bounced").length;
        const bounced = rows.filter((row) => row.status === "bounced").length;
        await db
          .updateTable("graph_verdict_runs")
          .set({ verdicts_stored: stored, verdicts_bounced: bounced })
          .where("id", "=", runId)
          .execute();
      }
      return { ids, rows, dispositions };
    },

    async listRunsWithRollups(limit = 20): Promise<GraphVerdictRunRollup[]> {
      const runs = await db
        .selectFrom("graph_verdict_runs")
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      if (runs.length === 0) return [];
      const counts = await db
        .selectFrom("graph_verdicts")
        .select(["run_id", "status", (eb) => eb.fn.countAll().as("count")])
        .where(
          "run_id",
          "in",
          runs.map((run) => run.id),
        )
        .groupBy(["run_id", "status"])
        .execute();
      const rollupsByRun = new Map<string, Record<GraphVerdictStatus, number>>();
      const empty = (): Record<GraphVerdictStatus, number> => ({
        awaiting_human: 0,
        bounced: 0,
        approved: 0,
        rejected: 0,
        applied: 0,
        reverted: 0,
        pending_corroboration: 0,
        veto_window: 0,
        retired: 0,
      });
      for (const run of runs) rollupsByRun.set(run.id, empty());
      for (const row of counts) {
        const rollup = rollupsByRun.get(row.run_id);
        if (rollup && row.status in rollup) rollup[row.status as GraphVerdictStatus] = Number(row.count);
      }
      return runs.map((run) => ({ ...run, rollups: rollupsByRun.get(run.id) ?? empty() }));
    },

    async listByRun(runId: string): Promise<GraphVerdictRow[]> {
      return db
        .selectFrom("graph_verdicts")
        .selectAll()
        .where("run_id", "=", runId)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
    },

    async listAwaitingHuman(params?: { limit?: number; offset?: number }): Promise<GraphVerdictRow[]> {
      return db
        .selectFrom("graph_verdicts")
        .selectAll()
        .where("status", "=", "awaiting_human")
        .where("superseded_at", "is", null)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(params?.limit ?? 50)
        .offset(params?.offset ?? 0)
        .execute();
    },

    /**
     * Cross-run listing for the review surface: every non-superseded verdict
     * still needing a human step (awaiting a decision, or approved but not yet
     * applied). Approved rows are included so a verdict never disappears from
     * the queue between Approve and Apply.
     */
    async listByStatuses(statuses: GraphVerdictStatus[], params?: { limit?: number }): Promise<GraphVerdictRow[]> {
      return db
        .selectFrom("graph_verdicts")
        .selectAll()
        .where("status", "in", statuses)
        .where("superseded_at", "is", null)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(params?.limit ?? 200)
        .execute();
    },

    async findById(id: string): Promise<GraphVerdictRow | null> {
      const row = await db.selectFrom("graph_verdicts").selectAll().where("id", "=", id).executeTakeFirst();
      return row ?? null;
    },

    async markApproved(input: { id: string; actorUserId: string }): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await db
        .updateTable("graph_verdicts")
        .set({
          status: "approved",
          decided_at: now,
          decided_by_user_id: input.actorUserId,
          updated_at: now,
        })
        .where("id", "=", input.id)
        .where("status", "in", [...GRAPH_VERDICT_APPROVABLE_STATUSES])
        .where("superseded_at", "is", null)
        .executeTakeFirst();
      return updatedCount(result) === 1;
    },

    async markRejected(input: { id: string; actorUserId: string }): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await db
        .updateTable("graph_verdicts")
        .set({
          status: "rejected",
          decided_at: now,
          decided_by_user_id: input.actorUserId,
          updated_at: now,
        })
        .where("id", "=", input.id)
        .where("status", "in", [...GRAPH_VERDICT_REJECTABLE_STATUSES])
        .where("superseded_at", "is", null)
        .executeTakeFirst();
      return updatedCount(result) === 1;
    },

    async markApplied(input: { id: string; ledgerRef: string | null }): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await db
        .updateTable("graph_verdicts")
        .set({ status: "applied", applied_ledger_ref: input.ledgerRef, updated_at: now })
        .where("id", "=", input.id)
        .where("status", "=", "approved")
        .executeTakeFirst();
      return updatedCount(result) === 1;
    },

    async setAppliedLedgerRef(input: { id: string; ledgerRef: string }): Promise<void> {
      await db
        .updateTable("graph_verdicts")
        .set({ applied_ledger_ref: input.ledgerRef, updated_at: new Date().toISOString() })
        .where("id", "=", input.id)
        .where("status", "=", "applied")
        .execute();
    },

    async markReverted(input: { id: string }): Promise<boolean> {
      const result = await db
        .updateTable("graph_verdicts")
        .set({ status: "reverted", updated_at: new Date().toISOString() })
        .where("id", "=", input.id)
        .where("status", "=", "applied")
        .executeTakeFirst();
      return updatedCount(result) === 1;
    },
  };
}

/**
 * Retries the common supersede/insert race once. Repeated pathological
 * contention can still surface the unique violation to the admin caller; the
 * verdict proposal surface is operational, not end-user traffic.
 */
export async function withGraphVerdictUniqueRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === 1 || !isUniqueConstraintError(error)) throw error;
    }
  }
  throw new Error("Graph verdict unique retry exhausted.");
}

export type GraphVerdictRepository = ReturnType<typeof createGraphVerdictRepository>;
