import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { isPg } from "../db/dialect";
import { PROTECTED_ENTITY_SOURCES } from "../db/repositories/entities";
import { deleteAliasRows, listAliasRows } from "../db/repositories/entity-alias-rows";
import type { DB, EntityAliasProvenance } from "../db/schema";
import type { CleanupAction, CleanupVerdict } from "./cleanup-adjudication";
import { parseAliasesString } from "./materialize-json";
import { mergeEntitiesInTransaction } from "./merge";
import { normalizeName } from "./name-keys";
import { NON_VOUCHING_RELATIONSHIP_SOURCES } from "./relationship-provenance";

type RowState = "applied" | "skipped" | "failed";

export type RollbackManifestEntry = {
  table: string;
  primaryKey: Record<string, string | number | null>;
  before: Record<string, unknown> | null;
};

export type CleanupApplyManifest = {
  runId: string;
  verdictPath: string;
  generatedAt: string;
  mutations: RollbackManifestEntry[];
};

export type CleanupApplyPlanRow = {
  entityId: string;
  name: string;
  action: CleanupAction | "needs_human_fix";
  state: RowState;
  targetEntityId: string | null;
  resolvedTargetEntityId: string | null;
  targetName?: string | null;
  reason: string | null;
  wouldChange: Record<string, number>;
};

export type CleanupApplyResult = {
  runId: string;
  rows: CleanupApplyPlanRow[];
  counts: Record<CleanupAction | "needs_human_fix", { applied: number; skipped: number; failed: number }>;
  manifest: CleanupApplyManifest | null;
};

type LiveEntity = {
  id: string;
  name: string;
  source_type: string;
  provenance_tier: string;
  aliases: string | null;
};

export type ValidPlannedRow = CleanupApplyPlanRow & {
  state: "applied";
  action: CleanupAction;
};

export type CleanupApplyExecutionContext = {
  mergeGroupId?: string;
  userId?: string;
};

export type CleanupApplyEffect =
  | { action: "merge_into"; mergeGroupId: string | null; mergeId: string }
  | { action: "nest_under"; relationshipId: string }
  | { action: "nest_under"; existing: true }
  | { action: "archive"; archivedAt: string }
  | {
      action: "remove_alias";
      alias: string;
      normalizedAlias: string;
      aliasProvenance: EntityAliasProvenance | null;
      aliasCreatedBy: string | null;
    };

const ACTIONS: CleanupAction[] = ["keep", "merge_into", "nest_under", "archive", "remove_alias"];

function emptyCounts(): CleanupApplyResult["counts"] {
  return {
    keep: { applied: 0, skipped: 0, failed: 0 },
    merge_into: { applied: 0, skipped: 0, failed: 0 },
    nest_under: { applied: 0, skipped: 0, failed: 0 },
    archive: { applied: 0, skipped: 0, failed: 0 },
    remove_alias: { applied: 0, skipped: 0, failed: 0 },
    needs_human_fix: { applied: 0, skipped: 0, failed: 0 },
  };
}

function recordCount(
  counts: CleanupApplyResult["counts"],
  action: CleanupApplyPlanRow["action"],
  state: RowState,
): void {
  const bucket = ACTIONS.includes(action as CleanupAction) ? (action as CleanupAction) : "needs_human_fix";
  counts[bucket][state] += 1;
}

function updatedCount(result: { numUpdatedRows?: bigint | number | string } | undefined): number {
  return Number(result?.numUpdatedRows ?? 0);
}

function skippedRow(verdict: CleanupVerdict, reason: string): CleanupApplyPlanRow {
  return {
    entityId: verdict.entityId,
    name: verdict.name,
    action: verdict.action,
    state: "skipped",
    targetEntityId: verdict.targetEntityId,
    resolvedTargetEntityId: null,
    reason,
    wouldChange: {},
  };
}

function failedRow(
  verdict: CleanupVerdict,
  reason: string,
  resolvedTargetEntityId: string | null,
): CleanupApplyPlanRow {
  return {
    entityId: verdict.entityId,
    name: verdict.name,
    action: verdict.action,
    state: "failed",
    targetEntityId: verdict.targetEntityId,
    resolvedTargetEntityId,
    reason,
    wouldChange: {},
  };
}

function detectMapCycles(map: Map<string, string>): Set<string> {
  const failed = new Set<string>();
  for (const start of map.keys()) {
    const seen = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor) {
      const firstSeen = seen.get(cursor);
      if (firstSeen !== undefined) {
        for (const id of [...seen.entries()].filter(([, index]) => index >= firstSeen).map(([id]) => id))
          failed.add(id);
        break;
      }
      seen.set(cursor, seen.size);
      cursor = map.get(cursor);
    }
  }
  return failed;
}

function resolveTarget(map: Map<string, string>, targetId: string): string | null {
  const seen = new Set<string>();
  let cursor = targetId;
  while (map.has(cursor)) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    cursor = map.get(cursor) ?? cursor;
  }
  return cursor;
}

function parseEntityIdList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function liveEntities(db: Kysely<DB>, ids: string[]): Promise<Map<string, LiveEntity>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "provenance_tier", "aliases"])
    .where("id", "in", [...new Set(ids)])
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

async function liveEntitiesOfType(db: Kysely<DB>, sourceType: string, ids: string[]): Promise<Map<string, LiveEntity>> {
  const live = await liveEntities(db, ids);
  return new Map([...live].filter(([, entity]) => entity.source_type === sourceType));
}

function isProtectedSource(entity: LiveEntity | null | undefined): boolean {
  return entity ? PROTECTED_ENTITY_SOURCES.includes(entity.source_type) : false;
}

function aliasFromBlob(entity: LiveEntity, alias: string | null): string | null {
  const normalized = normalizeName(alias ?? "");
  if (!normalized) return null;
  return parseAliasesString(entity.aliases).find((value) => normalizeName(value) === normalized) ?? null;
}

/**
 * Archive guards count tasks plus only relationship edges whose source vouches
 * for an endpoint entity. Non-vouching extraction/co-mention edges are left in
 * place for undo but do not keep junk entities live.
 */
async function archiveReferenceCounts(
  db: Kysely<DB>,
  entityId: string,
): Promise<{ tasks: number; relationships: number }> {
  const tasks = await db
    .selectFrom("tasks")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("parent_entity_id", "=", entityId),
        eb("assignee_entity_id", "=", entityId),
        eb("client_entity_id", "=", entityId),
      ]),
    )
    .execute();
  const relationships = await db
    .selectFrom("entity_relationships")
    .select("id")
    .where((eb) => eb.or([eb("source_entity_id", "=", entityId), eb("target_entity_id", "=", entityId)]))
    .where("source", "not in", [...NON_VOUCHING_RELATIONSHIP_SOURCES])
    .execute();
  return { tasks: tasks.length, relationships: relationships.length };
}

async function mutationCounts(
  db: Kysely<DB>,
  action: CleanupAction,
  entityId: string,
  targetId: string | null,
  targetName: string | null = null,
) {
  if (action === "keep") return {};
  if (action === "archive") return { entities: 1 };
  if (action === "remove_alias") {
    const normalizedAlias = normalizeName(targetName ?? "");
    const aliasRows = normalizedAlias
      ? await db
          .selectFrom("entity_aliases")
          .select("id")
          .where("entity_id", "=", entityId)
          .where("normalized_alias", "=", normalizedAlias)
          .execute()
      : [];
    return { entities: 1, entity_aliases: aliasRows.length };
  }
  if (action === "nest_under") {
    const existing =
      targetId === null
        ? null
        : await db
            .selectFrom("entity_relationships")
            .select("id")
            .where("source_entity_id", "=", entityId)
            .where("target_entity_id", "=", targetId)
            .where("relationship_type", "=", "part_of")
            .executeTakeFirst();
    return { entity_relationships: existing ? 0 : 1 };
  }
  const counts: Record<string, number> = { entities: 2, entity_merges: 1 };
  const simpleRefs = [
    ["entity_source_refs", "entity_id"],
    ...(isPg(db) ? ([["entity_name_embeddings", "entity_id"]] as const) : []),
    ["entity_name_proposals", "entity_id"],
    ["entity_mentions", "entity_id"],
    ["entity_contact_points", "entity_id"],
    ["entity_share_emails", "entity_id"],
    ["entity_alias_rejections", "entity_id"],
    ["resolution_decisions", "target_entity_id"],
    ["entity_domains", "entity_id"],
    ["entity_project_bindings", "entity_id"],
    ["entity_project_member_overrides", "entity_id"],
    ["slack_user_sync_state", "entity_id"],
    ["user_entity_links", "entity_id"],
    ["project_minting_verdicts", "company_entity_id"],
    ["weekly_mint_run_events", "company_entity_id"],
    ["company_relationship_declarations", "subject_entity_id"],
    ["work_cycles", "scope_entity_id"],
  ] as const;
  for (const [table, column] of simpleRefs) {
    const rows = await db.selectFrom(table).select(column).where(column, "=", entityId).execute();
    if (rows.length > 0) counts[table] = rows.length;
  }
  const relationships = await db
    .selectFrom("entity_relationships")
    .select("id")
    .where((eb) => eb.or([eb("source_entity_id", "=", entityId), eb("target_entity_id", "=", entityId)]))
    .execute();
  if (relationships.length > 0) counts.entity_relationships = relationships.length;
  const tasks = await db
    .selectFrom("tasks")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("parent_entity_id", "=", entityId),
        eb("assignee_entity_id", "=", entityId),
        eb("client_entity_id", "=", entityId),
      ]),
    )
    .execute();
  if (tasks.length > 0) counts.tasks = tasks.length;
  const taskEvidence = await db
    .selectFrom("task_evidence")
    .select("task_id")
    .where("kind", "=", "entity")
    .where("ref_id", "=", entityId)
    .execute();
  if (taskEvidence.length > 0) counts.task_evidence = taskEvidence.length;
  const reviewRows = await db.selectFrom("entity_review_queue").selectAll().execute();
  const reviewCount = reviewRows.filter(
    (row) =>
      row.candidate_entity_id === entityId ||
      row.resolved_entity_id === entityId ||
      parseEntityIdList(row.candidate_entity_ids).includes(entityId),
  ).length;
  if (reviewCount > 0) counts.entity_review_queue = reviewCount;
  const candidateRows = await db.selectFrom("entity_candidates").selectAll().execute();
  const candidateCount = candidateRows.filter(
    (row) =>
      row.promoted_entity_id === entityId || parseEntityIdList(row.observed_person_entity_ids).includes(entityId),
  ).length;
  if (candidateCount > 0) counts.entity_candidates = candidateCount;
  const subEntities = await db
    .selectFrom("sub_entities")
    .select("id")
    .where((eb) => eb.or([eb("parent_entity_id", "=", entityId), eb("parent_scope_key", "=", entityId)]))
    .execute();
  if (subEntities.length > 0) counts.sub_entities = subEntities.length;
  return counts;
}

async function partOfCycleIds(
  db: Kysely<DB>,
  mergeMap: Map<string, string>,
  nests: Array<{ entityId: string; targetEntityId: string }>,
): Promise<Set<string>> {
  const graph = new Map<string, string>();
  const existing = await db
    .selectFrom("entity_relationships")
    .select(["source_entity_id", "target_entity_id"])
    .where("relationship_type", "=", "part_of")
    .execute();
  for (const row of existing) {
    const source = resolveTarget(mergeMap, row.source_entity_id) ?? row.source_entity_id;
    const target = resolveTarget(mergeMap, row.target_entity_id) ?? row.target_entity_id;
    if (source !== target) graph.set(source, target);
  }
  for (const nest of nests) graph.set(nest.entityId, nest.targetEntityId);
  return detectMapCycles(graph);
}

function primaryKeyFor(
  table: string,
  rowId: string | null,
  before: Record<string, unknown> | null,
): Record<string, string | number | null> {
  if (table === "entity_share_emails") {
    const separator = rowId?.indexOf(":") ?? -1;
    return {
      entity_id: String(before?.entity_id ?? (separator >= 0 ? rowId?.slice(0, separator) : "")),
      email: String(before?.email ?? (separator >= 0 ? rowId?.slice(separator + 1) : "")),
    };
  }
  if (table === "task_evidence") {
    const [taskId, kind, refId] = rowId?.split("\u0000") ?? [];
    return {
      task_id: String(before?.task_id ?? taskId ?? ""),
      kind: String(before?.kind ?? kind ?? ""),
      ref_id: String(before?.ref_id ?? refId ?? ""),
    };
  }
  if (table === "slack_user_sync_state") {
    const [teamId, slackUserId] = rowId?.split("\u0000") ?? [];
    return {
      team_id: String(before?.team_id ?? teamId ?? ""),
      slack_user_id: String(before?.slack_user_id ?? slackUserId ?? ""),
    };
  }
  if (table === "company_relationship_declarations") {
    return { subject_entity_id: String(before?.subject_entity_id ?? rowId ?? "") };
  }
  if (table === "entity_name_embeddings") return { entity_id: String(before?.entity_id ?? rowId ?? "") };
  return { id: rowId };
}

function addManifestEntry(
  mutations: RollbackManifestEntry[],
  table: string,
  rowId: string | null,
  before: Record<string, unknown> | null,
): void {
  mutations.push({ table, primaryKey: primaryKeyFor(table, rowId, before), before });
}

export async function applyNest(
  db: Kysely<DB>,
  row: ValidPlannedRow,
  mutations: RollbackManifestEntry[],
): Promise<Extract<CleanupApplyEffect, { action: "nest_under" }>> {
  if (!row.resolvedTargetEntityId) throw new Error(`nest target missing for ${row.entityId}`);
  const existing = await db
    .selectFrom("entity_relationships")
    .select("id")
    .where("source_entity_id", "=", row.entityId)
    .where("target_entity_id", "=", row.resolvedTargetEntityId)
    .where("relationship_type", "=", "part_of")
    .executeTakeFirst();
  if (existing) return { action: "nest_under", existing: true };
  const id = randomUUID();
  addManifestEntry(mutations, "entity_relationships", id, null);
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: row.entityId,
      target_entity_id: row.resolvedTargetEntityId,
      relationship_type: "part_of",
      confidence: "high",
      confidence_score: 1,
      source: "project_cleanup_apply",
    })
    .execute();
  return { action: "nest_under", relationshipId: id };
}

export async function applyArchive(
  db: Kysely<DB>,
  row: ValidPlannedRow,
  mutations: RollbackManifestEntry[],
): Promise<Extract<CleanupApplyEffect, { action: "archive" }>> {
  const before = await db.selectFrom("entities").selectAll().where("id", "=", row.entityId).executeTakeFirstOrThrow();
  addManifestEntry(mutations, "entities", row.entityId, before);
  const archivedAt = new Date().toISOString();
  const result = await db
    .updateTable("entities")
    .set({ deleted_at: archivedAt, updated_at: archivedAt })
    .where("id", "=", row.entityId)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .executeTakeFirst();
  if (updatedCount(result) !== 1) throw new Error(`archive target no longer live for ${row.entityId}`);
  return { action: "archive", archivedAt };
}

export async function applyRemoveAlias(
  db: Kysely<DB>,
  row: ValidPlannedRow,
  mutations: RollbackManifestEntry[],
): Promise<Extract<CleanupApplyEffect, { action: "remove_alias" }>> {
  const normalizedAlias = normalizeName(row.targetName ?? "");
  if (!normalizedAlias) throw new Error(`alias missing for ${row.entityId}`);
  const before = await db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", row.entityId)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .executeTakeFirstOrThrow();
  const aliases = parseAliasesString(before.aliases);
  const removed = aliases.find((alias) => normalizeName(alias) === normalizedAlias);
  if (!removed) throw new Error(`alias no longer present for ${row.entityId}`);
  const aliasRows = await listAliasRows(db, row.entityId);
  const removedRows = aliasRows.filter((aliasRow) => aliasRow.normalized_alias === normalizedAlias);
  for (const aliasRow of removedRows) {
    addManifestEntry(mutations, "entity_aliases", aliasRow.id, aliasRow);
  }
  addManifestEntry(mutations, "entities", row.entityId, before);
  const next = aliases.filter((alias) => normalizeName(alias) !== normalizedAlias);
  const result = await db
    .updateTable("entities")
    .set({ aliases: next.length > 0 ? JSON.stringify(next) : null, updated_at: new Date().toISOString() })
    .where("id", "=", row.entityId)
    .where("aliases", before.aliases === null ? "is" : "=", before.aliases)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .executeTakeFirst();
  if (updatedCount(result) !== 1) throw new Error(`alias row changed while removing alias for ${row.entityId}`);
  await deleteAliasRows(db, row.entityId, [removed]);
  return {
    action: "remove_alias",
    alias: removed,
    normalizedAlias,
    aliasProvenance: removedRows[0]?.provenance ?? null,
    aliasCreatedBy: removedRows[0]?.created_by ?? null,
  };
}

export async function applyMerge(
  db: Kysely<DB>,
  row: ValidPlannedRow,
  mutations: RollbackManifestEntry[],
  context: CleanupApplyExecutionContext = {},
): Promise<Extract<CleanupApplyEffect, { action: "merge_into" }>> {
  if (!row.resolvedTargetEntityId) throw new Error(`merge target missing for ${row.entityId}`);
  const sourceBefore = await db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", row.entityId)
    .executeTakeFirstOrThrow();
  const targetBefore = await db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", row.resolvedTargetEntityId)
    .executeTakeFirstOrThrow();
  addManifestEntry(mutations, "entities", row.entityId, sourceBefore);
  addManifestEntry(mutations, "entities", row.resolvedTargetEntityId, targetBefore);
  const result = await mergeEntitiesInTransaction(db, {
    survivorId: row.resolvedTargetEntityId,
    loserId: row.entityId,
    userId: context.userId,
    groupId: context.mergeGroupId,
    mergedBy: "project_cleanup_apply",
  });
  for (const move of result.moves) {
    if ("kind" in move) continue;
    if ("collided" in move || "selfLoopDropped" in move) {
      addManifestEntry(mutations, move.table, "rowId" in move ? move.rowId : null, move.payload);
      continue;
    }
    if ("colChanges" in move) {
      addManifestEntry(
        mutations,
        move.table,
        move.rowId,
        Object.fromEntries(Object.entries(move.colChanges).map(([column, change]) => [column, change.before])),
      );
      continue;
    }
    addManifestEntry(
      mutations,
      move.table,
      move.rowId,
      Object.fromEntries(Object.entries(move.repoint).map(([column, change]) => [column, change.from])),
    );
  }
  addManifestEntry(mutations, "entity_merges", result.mergeId, null);
  return { action: "merge_into", mergeGroupId: context.mergeGroupId ?? null, mergeId: result.mergeId };
}

export async function planCleanup(
  db: Kysely<DB>,
  verdicts: CleanupVerdict[],
  opts: { extraLiveEntityIds?: readonly string[] } = {},
): Promise<CleanupApplyPlanRow[]> {
  const rows: CleanupApplyPlanRow[] = [];
  const executable = verdicts.filter((verdict) => verdict.approved && verdict.validation === "ok");
  const sourceIds = executable.map((verdict) => verdict.entityId);
  const targetIds = executable
    .filter((verdict) => verdict.action === "merge_into" || verdict.action === "nest_under")
    .flatMap((verdict) => (verdict.targetEntityId ? [verdict.targetEntityId] : []));
  const lookupIds = [...sourceIds, ...targetIds, ...(opts.extraLiveEntityIds ?? [])];
  const allLive = await liveEntities(db, lookupIds);
  const sourceTypes = [
    ...new Set(
      sourceIds.map((id) => allLive.get(id)?.source_type).filter((sourceType): sourceType is string => !!sourceType),
    ),
  ];
  const liveBySourceType = new Map<string, Map<string, LiveEntity>>();
  for (const sourceType of sourceTypes) {
    liveBySourceType.set(sourceType, await liveEntitiesOfType(db, sourceType, lookupIds));
  }
  const archiveSources = new Set(
    executable.filter((verdict) => verdict.action === "archive").map((verdict) => verdict.entityId),
  );
  const mergeMap = new Map<string, string>();
  for (const verdict of executable) {
    if (verdict.action === "merge_into" && verdict.targetEntityId)
      mergeMap.set(verdict.entityId, verdict.targetEntityId);
  }
  const mergeCycleIds = detectMapCycles(mergeMap);
  const plannedNests = executable
    .filter((verdict) => verdict.action === "nest_under" && verdict.targetEntityId)
    .map((verdict) => ({
      entityId: verdict.entityId,
      targetEntityId: resolveTarget(mergeMap, verdict.targetEntityId ?? "") ?? verdict.targetEntityId ?? "",
    }));
  const partOfCycles = await partOfCycleIds(db, mergeMap, plannedNests);

  for (const verdict of verdicts) {
    if (!verdict.approved || verdict.validation !== "ok") {
      rows.push(skippedRow(verdict, !verdict.approved ? "not_approved" : "validation_not_ok"));
      continue;
    }
    if (!ACTIONS.includes(verdict.action as CleanupAction)) {
      rows.push(failedRow(verdict, "invalid_action", null));
      continue;
    }
    const action = verdict.action as CleanupAction;
    const source = allLive.get(verdict.entityId) ?? null;
    if (!source) {
      rows.push(failedRow(verdict, "source_not_live", null));
      continue;
    }
    const live = liveBySourceType.get(source.source_type) ?? new Map<string, LiveEntity>();
    if (isProtectedSource(source)) {
      rows.push(failedRow(verdict, "protected_source", null));
      continue;
    }
    if (action === "nest_under" && source.source_type !== "project") {
      rows.push(failedRow(verdict, "action_not_allowed_for_type", null));
      continue;
    }
    if (action === "remove_alias") {
      const normalizedAlias = normalizeName(verdict.targetName ?? "");
      if (normalizedAlias && normalizeName(source.name) === normalizedAlias) {
        rows.push(failedRow(verdict, "alias_is_canonical_name", null));
        continue;
      }
      const alias = aliasFromBlob(source, verdict.targetName);
      if (!alias) {
        rows.push(failedRow(verdict, "alias_not_found", null));
        continue;
      }
      rows.push({
        entityId: verdict.entityId,
        name: verdict.name,
        action,
        state: "applied",
        targetEntityId: verdict.targetEntityId,
        resolvedTargetEntityId: null,
        targetName: alias,
        reason: null,
        wouldChange: await mutationCounts(db, action, verdict.entityId, null, alias),
      });
      continue;
    }
    if (mergeCycleIds.has(verdict.entityId)) {
      rows.push(failedRow(verdict, "merge_cycle", null));
      continue;
    }
    const resolvedTarget =
      action === "merge_into" || action === "nest_under"
        ? verdict.targetEntityId
          ? resolveTarget(mergeMap, verdict.targetEntityId)
          : null
        : null;
    if ((action === "merge_into" || action === "nest_under") && !resolvedTarget) {
      rows.push(failedRow(verdict, "missing_or_cyclic_target", resolvedTarget));
      continue;
    }
    if (resolvedTarget && resolvedTarget === verdict.entityId) {
      rows.push(failedRow(verdict, "self_target_after_resolution", resolvedTarget));
      continue;
    }
    const target = resolvedTarget ? (allLive.get(resolvedTarget) ?? null) : null;
    if (resolvedTarget && !target) {
      rows.push(failedRow(verdict, "target_not_live", resolvedTarget));
      continue;
    }
    if (action === "merge_into" && isProtectedSource(target)) {
      rows.push(failedRow(verdict, "protected_source", resolvedTarget));
      continue;
    }
    if (target && target.source_type !== source.source_type) {
      rows.push(failedRow(verdict, "type_mismatch", resolvedTarget));
      continue;
    }
    if (resolvedTarget && !live.has(resolvedTarget)) {
      rows.push(failedRow(verdict, "target_not_live", resolvedTarget));
      continue;
    }
    if (resolvedTarget && archiveSources.has(resolvedTarget)) {
      rows.push(failedRow(verdict, "target_archived_this_run", resolvedTarget));
      continue;
    }
    if (
      action === "merge_into" &&
      target &&
      source.provenance_tier === "declared" &&
      target.provenance_tier !== "declared"
    ) {
      rows.push(failedRow(verdict, "protected_tier_direction", resolvedTarget));
      continue;
    }
    if (
      action === "nest_under" &&
      (partOfCycles.has(verdict.entityId) || (resolvedTarget && partOfCycles.has(resolvedTarget)))
    ) {
      rows.push(failedRow(verdict, "part_of_cycle", resolvedTarget));
      continue;
    }
    if (action === "archive") {
      if (source.provenance_tier === "declared") {
        rows.push(failedRow(verdict, "protected_tier", null));
        continue;
      }
      const refs = await archiveReferenceCounts(db, verdict.entityId);
      if (refs.tasks > 0 || refs.relationships > 0) {
        rows.push(
          failedRow(verdict, `archive_referenced: tasks=${refs.tasks}, relationships=${refs.relationships}`, null),
        );
        continue;
      }
    }
    rows.push({
      entityId: verdict.entityId,
      name: verdict.name,
      action,
      state: "applied",
      targetEntityId: verdict.targetEntityId,
      resolvedTargetEntityId: resolvedTarget,
      reason: null,
      wouldChange: await mutationCounts(db, action, verdict.entityId, resolvedTarget, verdict.targetName),
    });
  }

  return rows;
}

export async function planProjectCleanup(db: Kysely<DB>, verdicts: CleanupVerdict[]): Promise<CleanupApplyPlanRow[]> {
  return planCleanup(db, verdicts);
}

export async function applyProjectCleanup(
  db: Kysely<DB>,
  verdicts: CleanupVerdict[],
  opts: { execute: boolean; verdictPath: string; mergeGroupId?: string; userId?: string },
): Promise<CleanupApplyResult> {
  const runId = randomUUID();
  const rows = await planProjectCleanup(db, verdicts);
  const counts = emptyCounts();
  for (const row of rows) recordCount(counts, row.action, row.state);

  if (!opts.execute) return { runId, rows, counts, manifest: null };

  const mutations: RollbackManifestEntry[] = [];
  await db.transaction().execute(async (trx) => {
    for (const row of rows.filter((row): row is ValidPlannedRow => row.state === "applied" && row.action !== "keep")) {
      if (row.action === "merge_into")
        await applyMerge(trx, row, mutations, { mergeGroupId: opts.mergeGroupId, userId: opts.userId });
    }
    for (const row of rows.filter(
      (row): row is ValidPlannedRow => row.state === "applied" && row.action === "nest_under",
    )) {
      await applyNest(trx, row, mutations);
    }
    for (const row of rows.filter(
      (row): row is ValidPlannedRow => row.state === "applied" && row.action === "archive",
    )) {
      await applyArchive(trx, row, mutations);
    }
    for (const row of rows.filter(
      (row): row is ValidPlannedRow => row.state === "applied" && row.action === "remove_alias",
    )) {
      await applyRemoveAlias(trx, row, mutations);
    }
  });

  return {
    runId,
    rows,
    counts,
    manifest: { runId, verdictPath: opts.verdictPath, generatedAt: new Date().toISOString(), mutations },
  };
}
