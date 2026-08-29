import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { type GraphVerdictRow, createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { ContainersTable, DB, EntitiesTable, EntityAliasProvenance } from "../db/schema";
import type { CleanupAction, CleanupVerdict } from "./cleanup-adjudication";
import {
  type CleanupApplyEffect,
  type CleanupApplyPlanRow,
  type RollbackManifestEntry,
  type ValidPlannedRow,
  applyArchive,
  applyMerge,
  applyNest,
  applyRemoveAlias,
  planCleanup,
} from "./cleanup-apply";
import { unmergeEntitiesInTransaction } from "./merge";
import { normalizeName } from "./name-keys";
import { strongestProvenanceTier } from "./provenance";
import { type VerdictFingerprintEvidence, containerVerdictFingerprint, fingerprintFor } from "./verdict-fingerprint";

export type GraphVerdictApplyErrorCode =
  | "NOT_FOUND"
  | "INVALID_VERDICT_STATE"
  | "STALE_VERDICT"
  | "PLAN_BLOCKED"
  | "PLAN_DRIFT"
  | "APPLY_CONFLICT"
  | "NOTHING_TO_REVERT";

export class GraphVerdictApplyError extends Error {
  constructor(
    public readonly code: GraphVerdictApplyErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GraphVerdictApplyError";
  }
}

export type GraphVerdictApplyResult = {
  verdictId: string;
  dryRun: boolean;
  status: "approved" | "awaiting_human" | "applied";
  ledgerRef: string | null;
  wouldChange: Record<string, number>;
  plan: CleanupApplyPlanRow | ContainerApplyPlanRow;
};

export type GraphVerdictReversionResult = {
  verdictId: string;
  status: "reverted";
  ledgerRef: string;
};

type EntityRow = Selectable<EntitiesTable>;
type ContainerRow = Selectable<ContainersTable>;

type ContainerClassification = "team" | "project" | "time_box" | "account" | "ignore";
type ContainerEntityStatus = "active" | "historical";

type ContainerVerdictEvidence = {
  classification: ContainerClassification;
  entityStatus: ContainerEntityStatus;
};

type ContainerApplyPlanRow = {
  entityId: string | null;
  containerId: string;
  name: string;
  action: "classify_container";
  state: "applied";
  targetEntityId: string | null;
  resolvedTargetEntityId: string | null;
  reason: string | null;
  classification: ContainerClassification;
  entityStatus: ContainerEntityStatus;
  wouldChange: Record<string, number>;
};

type WouldChangeMetadata = Record<string, unknown>;

function updatedCount(
  result: { numUpdatedRows?: bigint | number | string; numDeletedRows?: bigint | number | string } | undefined,
): number {
  return Number(result?.numUpdatedRows ?? result?.numDeletedRows ?? 0);
}

function parseEvidence(raw: string): VerdictFingerprintEvidence {
  try {
    const parsed = JSON.parse(raw) as { fileIds?: unknown; reviewIds?: unknown; notes?: unknown };
    return {
      fileIds: Array.isArray(parsed.fileIds)
        ? parsed.fileIds.filter((item): item is string => typeof item === "string")
        : [],
      reviewIds: Array.isArray(parsed.reviewIds)
        ? parsed.reviewIds.filter((item): item is string => typeof item === "string")
        : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { fileIds: [], reviewIds: [], notes: [] };
  }
}

function parseContainerEvidence(raw: string): ContainerVerdictEvidence {
  try {
    const parsed = JSON.parse(raw) as { classification?: unknown; entityStatus?: unknown };
    const classification = parsed.classification;
    const entityStatus = parsed.entityStatus;
    if (
      (classification === "team" ||
        classification === "project" ||
        classification === "time_box" ||
        classification === "account" ||
        classification === "ignore") &&
      (entityStatus === "active" || entityStatus === "historical")
    ) {
      return { classification, entityStatus };
    }
  } catch {}
  throw new GraphVerdictApplyError("PLAN_BLOCKED", "Container classification evidence is invalid");
}

async function loadEntities(
  db: Kysely<DB>,
  verdict: GraphVerdictRow,
): Promise<{ subject: EntityRow | null; target: EntityRow | null }> {
  const ids = [
    ...new Set([verdict.subject_entity_id, verdict.target_entity_id].filter((id): id is string => Boolean(id))),
  ];
  if (ids.length === 0) return { subject: null, target: null };
  const rows = await db.selectFrom("entities").selectAll().where("id", "in", ids).execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    subject: verdict.subject_entity_id ? (byId.get(verdict.subject_entity_id) ?? null) : null,
    target: verdict.target_entity_id ? (byId.get(verdict.target_entity_id) ?? null) : null,
  };
}

function toCleanupVerdict(verdict: GraphVerdictRow): CleanupVerdict {
  if (!verdict.subject_entity_id) {
    throw new GraphVerdictApplyError("PLAN_BLOCKED", "Cleanup verdict subject entity is missing", {
      verdictId: verdict.id,
    });
  }
  return {
    entityId: verdict.subject_entity_id,
    name: verdict.subject_name ?? verdict.subject_entity_id,
    action: verdict.action as CleanupAction,
    targetEntityId: verdict.target_entity_id,
    targetName: verdict.target_name,
    reason: verdict.reason,
    evidence: parseEvidence(verdict.evidence_json).notes ?? [],
    mechanical: false,
    approved: true,
    validation: "ok",
    validationReason: null,
  };
}

async function verifiedPlan(db: Kysely<DB>, verdict: GraphVerdictRow): Promise<CleanupApplyPlanRow> {
  if (!verdict.subject_entity_id) {
    throw new GraphVerdictApplyError("PLAN_BLOCKED", "Cleanup verdict subject entity is missing", {
      verdictId: verdict.id,
    });
  }
  const { subject, target } = await loadEntities(db, verdict);
  const fingerprint = fingerprintFor({
    action: verdict.action,
    subject,
    target,
    ...(verdict.action === "remove_alias" ? { targetName: verdict.target_name } : {}),
    evidence: parseEvidence(verdict.evidence_json),
  });
  if (fingerprint !== verdict.evidence_fingerprint) {
    throw new GraphVerdictApplyError("STALE_VERDICT", "Evidence changed since proposal", { verdictId: verdict.id });
  }
  const rows = await planCleanup(db, [toCleanupVerdict(verdict)]);
  const plan = rows[0];
  if (!plan) throw new GraphVerdictApplyError("PLAN_BLOCKED", "Planner returned no row", { verdictId: verdict.id });
  if (plan.state !== "applied") {
    throw new GraphVerdictApplyError("PLAN_BLOCKED", plan.reason ?? "plan_not_applied", {
      verdictId: verdict.id,
      reason: plan.reason,
    });
  }
  if (plan.resolvedTargetEntityId !== verdict.resolved_target_entity_id) {
    throw new GraphVerdictApplyError("PLAN_DRIFT", "Resolved target changed since proposal", {
      verdictId: verdict.id,
      reason: "plan_drift",
    });
  }
  return plan;
}

function ledgerRefForEffect(effect: CleanupApplyEffect): string {
  if (effect.action === "merge_into") {
    if (!effect.mergeGroupId) throw new GraphVerdictApplyError("APPLY_CONFLICT", "Merge ledger group missing");
    return `merge-group:${effect.mergeGroupId}`;
  }
  if (effect.action === "nest_under") {
    if ("existing" in effect) return "noop:existing";
    return `relationship:${effect.relationshipId}`;
  }
  if (effect.action === "remove_alias") return `alias-removed:${effect.normalizedAlias}`;
  return `archived-at:${effect.archivedAt}`;
}

function parseWouldChangeMetadata(raw: string | null): WouldChangeMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as WouldChangeMetadata) : {};
  } catch {
    return {};
  }
}

function numericWouldChange(raw: string | null): Record<string, number> {
  return Object.fromEntries(
    Object.entries(parseWouldChangeMetadata(raw)).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

async function addWouldChangeMetadata(
  db: Kysely<DB>,
  verdictId: string,
  currentWouldChangeJson: string | null,
  metadata: WouldChangeMetadata,
): Promise<void> {
  await db
    .updateTable("graph_verdicts")
    .set({
      would_change_json: JSON.stringify({ ...parseWouldChangeMetadata(currentWouldChangeJson), ...metadata }),
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", verdictId)
    .execute();
}

async function promoteMergeSurvivorTier(
  db: Kysely<DB>,
  verdict: GraphVerdictRow,
  plan: ValidPlannedRow,
): Promise<void> {
  if (!plan.resolvedTargetEntityId) throw new GraphVerdictApplyError("APPLY_CONFLICT", "Merge target missing");
  const row = await db
    .selectFrom("entities")
    .select(["id", "provenance_tier"])
    .where("id", "=", plan.resolvedTargetEntityId)
    .where(whereLiveEntity())
    .executeTakeFirst();
  if (!row) throw new GraphVerdictApplyError("APPLY_CONFLICT", "Merge survivor no longer live");
  await addWouldChangeMetadata(db, verdict.id, verdict.would_change_json, {
    priorSurvivorProvenanceTier: row.provenance_tier,
  });
  const nextTier = strongestProvenanceTier(row.provenance_tier, "human_confirmed");
  if (nextTier === row.provenance_tier) return;
  const result = await db
    .updateTable("entities")
    .set({ provenance_tier: nextTier, updated_at: new Date().toISOString() })
    .where("id", "=", row.id)
    .where("provenance_tier", "=", row.provenance_tier)
    .executeTakeFirst();
  if (updatedCount(result) !== 1) {
    throw new GraphVerdictApplyError("APPLY_CONFLICT", "Merge survivor tier changed during apply");
  }
}

async function applyPlannedRow(
  db: Kysely<DB>,
  verdict: GraphVerdictRow,
  plan: ValidPlannedRow,
  actorUserId: string,
): Promise<string> {
  const mutations: RollbackManifestEntry[] = [];
  if (plan.action === "keep") return "keep";
  if (plan.action === "merge_into") {
    const groupId = `graph-verdict:${verdict.id}`;
    const ledgerRef = ledgerRefForEffect(
      await applyMerge(db, plan, mutations, { mergeGroupId: groupId, userId: actorUserId }),
    );
    await promoteMergeSurvivorTier(db, verdict, plan);
    return ledgerRef;
  }
  if (plan.action === "nest_under") return ledgerRefForEffect(await applyNest(db, plan, mutations));
  if (plan.action === "remove_alias") {
    const effect = await applyRemoveAlias(db, plan, mutations);
    await createEntityReviewRepo(db).addRejection({
      entityId: plan.entityId,
      rejectedName: effect.alias,
      rejectedBy: `graph-verdict:${verdict.id}`,
    });
    await addWouldChangeMetadata(db, verdict.id, verdict.would_change_json, {
      removedAlias: effect.alias,
      removedAliasProvenance: effect.aliasProvenance,
      removedAliasCreatedBy: effect.aliasCreatedBy,
    });
    return ledgerRefForEffect(effect);
  }
  return ledgerRefForEffect(await applyArchive(db, plan, mutations));
}

function appliedResult(verdict: GraphVerdictRow, plan: CleanupApplyPlanRow): GraphVerdictApplyResult {
  return {
    verdictId: verdict.id,
    dryRun: false,
    status: "applied",
    ledgerRef: verdict.applied_ledger_ref,
    wouldChange: plan.wouldChange,
    plan,
  };
}

function containerPlan(
  verdict: GraphVerdictRow,
  container: ContainerRow,
  evidence: ContainerVerdictEvidence,
  entityId: string | null,
  wouldChange: Record<string, number>,
): ContainerApplyPlanRow {
  return {
    entityId,
    containerId: container.id,
    name: container.name,
    action: "classify_container",
    state: "applied",
    targetEntityId: null,
    resolvedTargetEntityId: entityId,
    reason: verdict.reason,
    classification: evidence.classification,
    entityStatus: evidence.entityStatus,
    wouldChange,
  };
}

function containerAppliedResult(verdict: GraphVerdictRow, plan: ContainerApplyPlanRow): GraphVerdictApplyResult {
  return {
    verdictId: verdict.id,
    dryRun: false,
    status: "applied",
    ledgerRef: verdict.applied_ledger_ref,
    wouldChange: plan.wouldChange,
    plan,
  };
}

function storedWouldChange(verdict: GraphVerdictRow): Record<string, number> {
  return numericWouldChange(verdict.would_change_json);
}

async function loadAppliedResult(db: Kysely<DB>, verdictId: string): Promise<GraphVerdictApplyResult | null> {
  const verdict = await createGraphVerdictRepository(db).findById(verdictId);
  if (!verdict || verdict.status !== "applied") return null;
  if (verdict.action === "classify_container" && verdict.subject_container_id) {
    const container = await db
      .selectFrom("containers")
      .selectAll()
      .where("id", "=", verdict.subject_container_id)
      .executeTakeFirst();
    if (!container) return null;
    const evidence = parseContainerEvidence(verdict.evidence_json);
    return containerAppliedResult(
      verdict,
      containerPlan(verdict, container, evidence, container.classified_entity_id, storedWouldChange(verdict)),
    );
  }
  if (!verdict.subject_entity_id) return null;
  return appliedResult(verdict, {
    entityId: verdict.subject_entity_id,
    name: verdict.subject_name ?? verdict.subject_entity_id,
    action: verdict.action as CleanupAction,
    state: "applied",
    targetEntityId: verdict.target_entity_id,
    resolvedTargetEntityId: verdict.resolved_target_entity_id,
    ...(verdict.action === "remove_alias" ? { targetName: verdict.target_name } : {}),
    reason: null,
    wouldChange: storedWouldChange(verdict),
  });
}

async function loadContainerForVerdict(db: Kysely<DB>, verdict: GraphVerdictRow): Promise<ContainerRow> {
  if (!verdict.subject_container_id) {
    throw new GraphVerdictApplyError("PLAN_BLOCKED", "Container verdict subject is missing", { verdictId: verdict.id });
  }
  const container = await db
    .selectFrom("containers")
    .selectAll()
    .where("id", "=", verdict.subject_container_id)
    .executeTakeFirst();
  if (!container) {
    throw new GraphVerdictApplyError("PLAN_BLOCKED", "Container subject was not found", { verdictId: verdict.id });
  }
  if (containerVerdictFingerprint({ action: verdict.action, container }) !== verdict.evidence_fingerprint) {
    throw new GraphVerdictApplyError("STALE_VERDICT", "Container evidence changed since proposal", {
      verdictId: verdict.id,
    });
  }
  return container;
}

async function resolveContainerEntity(db: Kysely<DB>, container: ContainerRow): Promise<EntityRow | null> {
  if (container.classified_entity_id) {
    const linked = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", container.classified_entity_id)
      .where(whereLiveEntity())
      .executeTakeFirst();
    if (linked) return linked;
  }
  const byRef = await db
    .selectFrom("entity_source_refs")
    .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
    .selectAll("entities")
    .where("entity_source_refs.source", "=", container.connector_type)
    .where("entity_source_refs.source_id", "=", container.external_id)
    .where(whereLiveEntity())
    .executeTakeFirst();
  return byRef ?? null;
}

async function mintContainerEntity(
  db: Kysely<DB>,
  container: ContainerRow,
  classification: "team" | "project",
): Promise<string> {
  const now = new Date().toISOString();
  const entityId = randomUUID();
  await db
    .insertInto("entities")
    .values({
      id: entityId,
      name: container.name,
      source_type: classification,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto("entity_source_refs")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      source: container.connector_type,
      source_id: container.external_id,
      source_url: null,
      last_seen_at: now,
    })
    .execute();
  return entityId;
}

async function archiveContainerEntity(db: Kysely<DB>, entityId: string): Promise<string> {
  const effect = await applyArchive(
    db,
    {
      entityId,
      name: entityId,
      action: "archive",
      state: "applied",
      targetEntityId: null,
      resolvedTargetEntityId: null,
      reason: null,
      wouldChange: { entities: 1 },
    },
    [],
  );
  return `archived-at:${effect.archivedAt}`;
}

async function applyContainerVerdict(
  trx: Kysely<DB>,
  verdict: GraphVerdictRow,
  dryRun: boolean | undefined,
): Promise<GraphVerdictApplyResult> {
  const evidence = parseContainerEvidence(verdict.evidence_json);
  const repo = createGraphVerdictRepository(trx);
  if (!dryRun) {
    const claimed = await repo.markApplied({ id: verdict.id, ledgerRef: null });
    if (!claimed) {
      throw new GraphVerdictApplyError("APPLY_CONFLICT", "Graph verdict apply claim lost", { verdictId: verdict.id });
    }
  }
  const container = await loadContainerForVerdict(trx, verdict);
  const labelOnly =
    evidence.classification === "time_box" ||
    evidence.classification === "account" ||
    evidence.classification === "ignore";
  const existingEntity = labelOnly ? null : await resolveContainerEntity(trx, container);
  const wouldChange: Record<string, number> = labelOnly
    ? { containers: 1 }
    : { containers: 1, entities: 1, entity_source_refs: existingEntity ? 0 : 1 };
  const plan = containerPlan(
    verdict,
    container,
    evidence,
    existingEntity?.id ?? container.classified_entity_id,
    wouldChange,
  );
  if (dryRun) {
    return {
      verdictId: verdict.id,
      dryRun: true,
      status: verdict.status as "approved" | "awaiting_human",
      ledgerRef: verdict.applied_ledger_ref,
      wouldChange,
      plan,
    };
  }

  let ledgerRef: string;
  let entityId: string | null = null;
  if (labelOnly) {
    ledgerRef = `label:${evidence.classification}`;
  } else {
    const classification = evidence.classification;
    if (classification !== "team" && classification !== "project") {
      throw new GraphVerdictApplyError("PLAN_BLOCKED", "Container classification cannot create an entity", {
        verdictId: verdict.id,
      });
    }
    if (existingEntity) {
      entityId = existingEntity.id;
      ledgerRef = `retyped:${existingEntity.id}:${existingEntity.source_type}`;
      const retyped = await trx
        .updateTable("entities")
        .set({ source_type: classification, updated_at: new Date().toISOString() })
        .where("id", "=", existingEntity.id)
        .where(whereLiveEntity())
        .executeTakeFirst();
      if (updatedCount(retyped) !== 1) {
        throw new GraphVerdictApplyError("APPLY_CONFLICT", "Container entity retype target changed", {
          verdictId: verdict.id,
        });
      }
    } else {
      entityId = await mintContainerEntity(trx, container, classification);
      ledgerRef = `entity:${entityId}`;
    }
    if (evidence.entityStatus === "historical") {
      ledgerRef = `${ledgerRef};${await archiveContainerEntity(trx, entityId)}`;
    }
  }

  /**
   * CAS on the verdict link as read in this transaction: a prior applied verdict is
   * legal to overwrite (re-classification after a reopen), a concurrent change is not.
   */
  const updated = await trx
    .updateTable("containers")
    .set({
      classification: evidence.classification,
      classification_status: evidence.entityStatus,
      classified_entity_id: entityId,
      verdict_id: verdict.id,
      last_reviewed_fingerprint: verdict.evidence_fingerprint,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", container.id)
    .where("verdict_id", container.verdict_id === null ? "is" : "=", container.verdict_id)
    .executeTakeFirst();
  if (updatedCount(updated) !== 1) {
    throw new GraphVerdictApplyError("APPLY_CONFLICT", "Container classification changed during apply", {
      verdictId: verdict.id,
    });
  }
  await repo.setAppliedLedgerRef({ id: verdict.id, ledgerRef });
  const appliedPlan = containerPlan(
    verdict,
    { ...container, classified_entity_id: entityId },
    evidence,
    entityId,
    wouldChange,
  );
  return containerAppliedResult({ ...verdict, status: "applied", applied_ledger_ref: ledgerRef }, appliedPlan);
}

export async function applyGraphVerdict(
  db: Kysely<DB>,
  input: { verdictId: string; actorUserId: string; dryRun?: boolean },
): Promise<GraphVerdictApplyResult> {
  const repo = createGraphVerdictRepository(db);
  const existing = await repo.findById(input.verdictId);
  if (!existing) {
    throw new GraphVerdictApplyError("NOT_FOUND", "Graph verdict not found", { verdictId: input.verdictId });
  }
  if (existing.status === "applied" && !input.dryRun) {
    const applied = await loadAppliedResult(db, input.verdictId);
    if (applied) return applied;
  }
  if (existing.status !== "approved" && !(input.dryRun && existing.status === "awaiting_human")) {
    throw new GraphVerdictApplyError("INVALID_VERDICT_STATE", "Graph verdict is not applicable", {
      verdictId: input.verdictId,
      status: existing.status,
    });
  }

  try {
    return await db.transaction().execute(async (trx) => {
      const txRepo = createGraphVerdictRepository(trx);
      const verdict = await txRepo.findById(input.verdictId);
      if (!verdict) {
        throw new GraphVerdictApplyError("NOT_FOUND", "Graph verdict not found", { verdictId: input.verdictId });
      }
      if (verdict.status !== "approved" && !(input.dryRun && verdict.status === "awaiting_human")) {
        throw new GraphVerdictApplyError("INVALID_VERDICT_STATE", "Graph verdict is not applicable", {
          verdictId: input.verdictId,
          status: verdict.status,
        });
      }
      if (verdict.action === "classify_container") {
        return applyContainerVerdict(trx, verdict, input.dryRun);
      }
      const plan = await verifiedPlan(trx, verdict);
      if (input.dryRun) {
        return {
          verdictId: verdict.id,
          dryRun: true,
          status: verdict.status as "approved" | "awaiting_human",
          ledgerRef: verdict.applied_ledger_ref,
          wouldChange: plan.wouldChange,
          plan,
        };
      }
      const claimed = await txRepo.markApplied({ id: verdict.id, ledgerRef: null });
      if (!claimed) {
        throw new GraphVerdictApplyError("APPLY_CONFLICT", "Graph verdict apply claim lost", { verdictId: verdict.id });
      }
      const ledgerRef = await applyPlannedRow(trx, verdict, plan as ValidPlannedRow, input.actorUserId);
      await txRepo.setAppliedLedgerRef({ id: verdict.id, ledgerRef });
      return appliedResult({ ...verdict, status: "applied", applied_ledger_ref: ledgerRef }, plan);
    });
  } catch (err) {
    if (err instanceof GraphVerdictApplyError && err.code === "APPLY_CONFLICT") {
      const applied = await loadAppliedResult(db, input.verdictId);
      if (applied) return applied;
    }
    throw err;
  }
}

function parseLedgerRef(
  ref: string,
):
  | { kind: "merge"; groupId: string }
  | { kind: "relationship"; id: string }
  | { kind: "archive"; at: string }
  | { kind: "alias_removed"; normalizedAlias: string }
  | { kind: "existing" }
  | { kind: "keep" } {
  if (ref.startsWith("merge-group:")) return { kind: "merge", groupId: ref.slice("merge-group:".length) };
  if (ref.startsWith("relationship:")) return { kind: "relationship", id: ref.slice("relationship:".length) };
  if (ref.startsWith("archived-at:")) return { kind: "archive", at: ref.slice("archived-at:".length) };
  if (ref.startsWith("alias-removed:")) {
    return { kind: "alias_removed", normalizedAlias: ref.slice("alias-removed:".length) };
  }
  if (ref === "noop:existing") return { kind: "existing" };
  if (ref === "keep") return { kind: "keep" };
  throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Unknown graph verdict ledger ref");
}

function parseContainerLedgerRef(
  ref: string,
):
  | { kind: "label"; classification: ContainerClassification }
  | { kind: "entity"; entityId: string; archivedAt: string | null }
  | { kind: "retyped"; entityId: string; oldType: string; archivedAt: string | null } {
  const [primary, archive] = ref.split(";");
  const archivedAt = archive?.startsWith("archived-at:") ? archive.slice("archived-at:".length) : null;
  if (primary?.startsWith("label:")) {
    const classification = primary.slice("label:".length);
    if (
      classification === "team" ||
      classification === "project" ||
      classification === "time_box" ||
      classification === "account" ||
      classification === "ignore"
    ) {
      return { kind: "label", classification };
    }
  }
  if (primary?.startsWith("entity:")) return { kind: "entity", entityId: primary.slice("entity:".length), archivedAt };
  if (primary?.startsWith("retyped:")) {
    const parts = primary.split(":");
    const entityId = parts[1];
    const oldType = parts.slice(2).join(":");
    if (entityId && oldType) return { kind: "retyped", entityId, oldType, archivedAt };
  }
  throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Unknown container verdict ledger ref");
}

async function assertMintedEntityHasNoRelationships(db: Kysely<DB>, entityId: string): Promise<void> {
  const relationship = await db
    .selectFrom("entity_relationships")
    .select("id")
    .where((eb) => eb.or([eb("source_entity_id", "=", entityId), eb("target_entity_id", "=", entityId)]))
    .executeTakeFirst();
  if (relationship) {
    throw new GraphVerdictApplyError("APPLY_CONFLICT", "Minted entity gained relationships");
  }
  const task = await db
    .selectFrom("tasks")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("parent_entity_id", "=", entityId),
        eb("assignee_entity_id", "=", entityId),
        eb("client_entity_id", "=", entityId),
      ]),
    )
    .executeTakeFirst();
  if (task) {
    throw new GraphVerdictApplyError("APPLY_CONFLICT", "Minted entity gained task references");
  }
}

async function clearContainerVerdictLink(db: Kysely<DB>, row: GraphVerdictRow, entityId: string | null): Promise<void> {
  if (!row.subject_container_id) {
    throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Container verdict subject is missing");
  }
  let query = db
    .updateTable("containers")
    .set({
      classification: null,
      classification_status: null,
      classified_entity_id: null,
      verdict_id: null,
      last_reviewed_fingerprint: null,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", row.subject_container_id)
    .where("verdict_id", "=", row.id);
  query = entityId
    ? query.where("classified_entity_id", "=", entityId)
    : query.where("classified_entity_id", "is", null);
  const cleared = await query.executeTakeFirst();
  if (updatedCount(cleared) !== 1) {
    throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Container row no longer matches ledger");
  }
}

async function revertContainerVerdict(trx: Kysely<DB>, row: GraphVerdictRow, ledgerRef: string): Promise<void> {
  const ledger = parseContainerLedgerRef(ledgerRef);
  const repo = createGraphVerdictRepository(trx);
  const won = await repo.markReverted({ id: row.id });
  if (!won) {
    throw new GraphVerdictApplyError("APPLY_CONFLICT", "Graph verdict reversion claim lost", { verdictId: row.id });
  }
  if (ledger.kind === "label") {
    await clearContainerVerdictLink(trx, row, null);
    return;
  }
  if (ledger.kind === "retyped") {
    const result = await trx
      .updateTable("entities")
      .set({ source_type: ledger.oldType, deleted_at: null, updated_at: new Date().toISOString() })
      .where("id", "=", ledger.entityId)
      .where("deleted_at", ledger.archivedAt ? "=" : "is", ledger.archivedAt)
      .where("merged_into_entity_id", "is", null)
      .executeTakeFirst();
    if (updatedCount(result) !== 1) {
      throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Retyped entity no longer matches ledger");
    }
    await clearContainerVerdictLink(trx, row, ledger.entityId);
    return;
  }
  await assertMintedEntityHasNoRelationships(trx, ledger.entityId);
  if (ledger.archivedAt) {
    const existing = await trx
      .selectFrom("entities")
      .select("id")
      .where("id", "=", ledger.entityId)
      .where("deleted_at", "=", ledger.archivedAt)
      .where("merged_into_entity_id", "is", null)
      .executeTakeFirst();
    if (!existing) {
      throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Minted archived entity no longer matches ledger");
    }
  } else {
    await archiveContainerEntity(trx, ledger.entityId);
  }
  await clearContainerVerdictLink(trx, row, ledger.entityId);
}

function aliasProvenanceFromMetadata(value: unknown): EntityAliasProvenance {
  if (
    value === "human_confirmed" ||
    value === "judge" ||
    value === "merge" ||
    value === "mint_model" ||
    value === "roster" ||
    value === "legacy"
  ) {
    return value;
  }
  return "legacy";
}

async function restoreRemovedAlias(trx: Kysely<DB>, row: GraphVerdictRow, normalizedAlias: string): Promise<void> {
  if (!row.subject_entity_id) {
    throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Graph verdict subject entity is missing");
  }
  const metadata = parseWouldChangeMetadata(row.would_change_json);
  const alias = typeof metadata.removedAlias === "string" ? metadata.removedAlias : row.target_name;
  if (!alias || normalizeName(alias) !== normalizedAlias) {
    throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Removed alias metadata no longer matches ledger");
  }
  const entity = await trx
    .selectFrom("entities")
    .select("id")
    .where("id", "=", row.subject_entity_id)
    .where(whereLiveEntity())
    .executeTakeFirst();
  if (!entity) throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Alias entity is not live");
  const provenance = aliasProvenanceFromMetadata(metadata.removedAliasProvenance);
  const createdBy = typeof metadata.removedAliasCreatedBy === "string" ? metadata.removedAliasCreatedBy : null;
  await trx
    .deleteFrom("entity_alias_rejections")
    .where("entity_id", "=", entity.id)
    .where("normalized_rejected_name", "=", normalizedAlias)
    .where("rejected_by", "=", `graph-verdict:${row.id}`)
    .execute();
  await createEntityRepository(trx).appendAlias(entity.id, alias, provenance, createdBy, { bypassGate: true });
}

async function restoreMergeSurvivorTier(trx: Kysely<DB>, row: GraphVerdictRow, groupId: string): Promise<void> {
  const metadata = parseWouldChangeMetadata(row.would_change_json);
  const priorTier = metadata.priorSurvivorProvenanceTier;
  if (typeof priorTier !== "string") return;
  const merge = await trx
    .selectFrom("entity_merges")
    .select("survivor_entity_id")
    .where("group_id", "=", groupId)
    .executeTakeFirst();
  if (!merge) return;
  await trx
    .updateTable("entities")
    .set({ provenance_tier: priorTier, updated_at: new Date().toISOString() })
    .where("id", "=", merge.survivor_entity_id)
    .where(whereLiveEntity())
    .execute();
}

export async function revertGraphVerdict(
  db: Kysely<DB>,
  input: { verdictId: string; actorUserId: string },
): Promise<GraphVerdictReversionResult> {
  const row = await createGraphVerdictRepository(db).findById(input.verdictId);
  if (!row) {
    throw new GraphVerdictApplyError("NOT_FOUND", "Graph verdict not found", { verdictId: input.verdictId });
  }
  if (row.status !== "applied" || !row.applied_ledger_ref) {
    throw new GraphVerdictApplyError("INVALID_VERDICT_STATE", "Graph verdict is not revertible", {
      verdictId: input.verdictId,
      status: row.status,
    });
  }
  const appliedLedgerRef = row.applied_ledger_ref;
  if (row.action === "classify_container") {
    return db.transaction().execute(async (trx) => {
      await revertContainerVerdict(trx, row, appliedLedgerRef);
      return { verdictId: row.id, status: "reverted", ledgerRef: appliedLedgerRef };
    });
  }
  const subjectEntityId = row.subject_entity_id;
  if (!subjectEntityId) {
    throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Graph verdict subject entity is missing");
  }
  const ledger = parseLedgerRef(appliedLedgerRef);
  return db.transaction().execute(async (trx) => {
    const repo = createGraphVerdictRepository(trx);
    const won = await repo.markReverted({ id: row.id });
    if (!won) {
      throw new GraphVerdictApplyError("APPLY_CONFLICT", "Graph verdict reversion claim lost", { verdictId: row.id });
    }
    if (ledger.kind === "merge") {
      const merge = await trx
        .selectFrom("entity_merges")
        .select("id")
        .where("group_id", "=", ledger.groupId)
        .where("unmerged_at", "is", null)
        .executeTakeFirst();
      if (!merge) throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Merge ledger row is not active");
      await unmergeEntitiesInTransaction(trx, { mergeId: merge.id, userId: input.actorUserId });
      await restoreMergeSurvivorTier(trx, row, ledger.groupId);
    } else if (ledger.kind === "relationship") {
      const result = await trx.deleteFrom("entity_relationships").where("id", "=", ledger.id).executeTakeFirst();
      if (updatedCount(result) !== 1) {
        throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Relationship row is already gone");
      }
    } else if (ledger.kind === "archive") {
      const result = await trx
        .updateTable("entities")
        .set({ deleted_at: null, updated_at: new Date().toISOString() })
        .where("id", "=", subjectEntityId)
        .where("deleted_at", "=", ledger.at)
        .where("merged_into_entity_id", "is", null)
        .executeTakeFirst();
      if (updatedCount(result) !== 1) {
        throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Archive row no longer matches ledger");
      }
    } else if (ledger.kind === "alias_removed") {
      await restoreRemovedAlias(trx, row, ledger.normalizedAlias);
    } else {
      throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "This verdict did not create a reversible graph row");
    }
    return { verdictId: row.id, status: "reverted", ledgerRef: appliedLedgerRef };
  });
}
