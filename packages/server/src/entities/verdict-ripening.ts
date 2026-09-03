import type { Kysely } from "kysely";
import type { Logger } from "pino";
import {
  type CorroborationEntry,
  DRY_STREAK_RETIRE_AT,
  corroborationKey,
  evidenceFileIdsOf,
  loadEvidenceClusters,
  parseCorroboration,
  shouldRipen,
  vetoUntilFrom,
} from "../db/repositories/graph-verdicts";
import type { DB } from "../db/schema";

type WaitingMergeRow = {
  id: string;
  status: string;
  subject_entity_id: string | null;
  target_entity_id: string | null;
  evidence_json: string;
  corroboration_json: string | null;
  dry_streak: number;
  updated_at: string;
};

async function loadWaitingMerges(db: Kysely<DB>): Promise<WaitingMergeRow[]> {
  return db
    .selectFrom("graph_verdicts")
    .select([
      "id",
      "status",
      "subject_entity_id",
      "target_entity_id",
      "evidence_json",
      "corroboration_json",
      "dry_streak",
      "updated_at",
    ])
    .where("action", "=", "merge_into")
    .where("status", "in", ["pending_corroboration", "veto_window"])
    .where("superseded_at", "is", null)
    .execute();
}

/**
 * Append entries to one verdict's corroboration list under a CAS on
 * updated_at: the post-sync trigger and the daily resolver run in different
 * loops, so a lost race retries against the fresh row and the idempotency key
 * (kind+source+fileId) makes the replayed append a no-op. Ripening happens in
 * the same write — pending rows crossing two independent signals move to
 * veto_window with the 7-day stamp.
 */
async function appendCorroboration(
  db: Kysely<DB>,
  verdictId: string,
  entries: CorroborationEntry[],
): Promise<{ appended: number; ripened: boolean }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db
      .selectFrom("graph_verdicts")
      .select(["id", "status", "evidence_json", "corroboration_json", "updated_at"])
      .where("id", "=", verdictId)
      .where("status", "in", ["pending_corroboration", "veto_window"])
      .where("superseded_at", "is", null)
      .executeTakeFirst();
    if (!row) return { appended: 0, ripened: false };
    const existing = parseCorroboration(row.corroboration_json);
    const known = new Set(existing.map(corroborationKey));
    const additions = entries.filter((entry) => !known.has(corroborationKey(entry)));
    if (additions.length === 0) return { appended: 0, ripened: false };
    const merged = [...existing, ...additions];
    const proposalClusters = new Set(
      [...(await loadEvidenceClusters(db, evidenceFileIdsOf(row.evidence_json))).values()].map(
        (cluster) => cluster.clusterKey,
      ),
    );
    const ripens = row.status === "pending_corroboration" && shouldRipen(proposalClusters, merged);
    const now = new Date().toISOString();
    const result = await db
      .updateTable("graph_verdicts")
      .set({
        corroboration_json: JSON.stringify(merged),
        updated_at: now,
        ...(ripens ? { status: "veto_window", veto_until: vetoUntilFrom(now) } : {}),
      })
      .where("id", "=", verdictId)
      .where("updated_at", "=", row.updated_at)
      .executeTakeFirst();
    if (Number(result?.numUpdatedRows ?? 0) === 1) return { appended: additions.length, ripened: ripens };
  }
  return { appended: 0, ripened: false };
}

/**
 * The post-sync trigger (§6 append path): new files that mention BOTH sides
 * of a waiting merge pair are co-occurrence evidence for that pair. Cheap set
 * intersection over entity_mentions — no model calls. Runs after fact
 * materialization so the mentions rows exist.
 */
export async function corroborateVerdictsFromFiles(
  db: Kysely<DB>,
  indexedFileIds: string[],
  logger?: Logger,
): Promise<{ evaluated: number; appended: number; ripened: number }> {
  if (indexedFileIds.length === 0) return { evaluated: 0, appended: 0, ripened: 0 };
  const waiting = await loadWaitingMerges(db);
  const pairs = waiting.filter((row) => row.subject_entity_id && row.target_entity_id);
  if (pairs.length === 0) return { evaluated: 0, appended: 0, ripened: 0 };

  const pairEntityIds = [...new Set(pairs.flatMap((row) => [row.subject_entity_id ?? "", row.target_entity_id ?? ""]))];
  const mentions = await db
    .selectFrom("entity_mentions")
    .select(["entity_id", "indexed_file_id"])
    .where("indexed_file_id", "in", indexedFileIds)
    .where("entity_id", "in", pairEntityIds)
    .execute();
  if (mentions.length === 0) return { evaluated: pairs.length, appended: 0, ripened: 0 };

  const entitiesByFile = new Map<string, Set<string>>();
  for (const mention of mentions) {
    const set = entitiesByFile.get(mention.indexed_file_id) ?? new Set<string>();
    set.add(mention.entity_id);
    entitiesByFile.set(mention.indexed_file_id, set);
  }
  const clusters = await loadEvidenceClusters(db, [...entitiesByFile.keys()]);

  let appended = 0;
  let ripened = 0;
  const now = new Date().toISOString();
  for (const verdict of pairs) {
    const entries: CorroborationEntry[] = [];
    for (const [fileId, entityIds] of entitiesByFile) {
      if (!entityIds.has(verdict.subject_entity_id ?? "") || !entityIds.has(verdict.target_entity_id ?? "")) continue;
      const cluster = clusters.get(fileId);
      if (!cluster) continue;
      entries.push({
        kind: "cross_source_cooccurrence",
        source: cluster.source,
        fileId,
        clusterKey: cluster.clusterKey,
        supportsEntityId: verdict.target_entity_id,
        observedAt: now,
      });
    }
    if (entries.length === 0) continue;
    const result = await appendCorroboration(db, verdict.id, entries);
    appended += result.appended;
    if (result.ripened) ripened += 1;
  }
  if (logger && (appended > 0 || ripened > 0)) {
    logger.info({ evaluated: pairs.length, appended, ripened }, "Verdict corroboration trigger complete");
  }
  return { evaluated: pairs.length, appended, ripened };
}

/**
 * Dry-streak aging (the weekly-mint retirement shape): a resolver pass that
 * evaluates a pending_corroboration verdict and finds nothing new bumps its
 * streak under a CAS on the current value — two racing passes cannot
 * double-age a row. At the threshold the row retires (CAS on status), freeing
 * its uniqueness slot; a later proposal with evidence beyond the recorded set
 * revives it through storeVerdicts.
 */
export async function agePendingVerdicts(
  db: Kysely<DB>,
  options: { since: string },
  logger?: Logger,
): Promise<{ evaluated: number; bumped: number; retired: number; skippedFresh: number }> {
  const waiting = await loadWaitingMerges(db);
  const pending = waiting.filter((row) => row.status === "pending_corroboration");
  let bumped = 0;
  let retired = 0;
  let skippedFresh = 0;
  const now = new Date().toISOString();
  for (const verdict of pending) {
    const freshEvidence = parseCorroboration(verdict.corroboration_json).some(
      (entry) => entry.observedAt >= options.since,
    );
    if (freshEvidence) {
      skippedFresh += 1;
      continue;
    }
    const nextStreak = verdict.dry_streak + 1;
    if (nextStreak >= DRY_STREAK_RETIRE_AT) {
      const result = await db
        .updateTable("graph_verdicts")
        .set({ status: "retired", retired_reason: "dry_streak", dry_streak: nextStreak, updated_at: now })
        .where("id", "=", verdict.id)
        .where("status", "=", "pending_corroboration")
        .where("dry_streak", "=", verdict.dry_streak)
        .executeTakeFirst();
      if (Number(result?.numUpdatedRows ?? 0) === 1) retired += 1;
      continue;
    }
    const result = await db
      .updateTable("graph_verdicts")
      .set({ dry_streak: nextStreak, updated_at: now })
      .where("id", "=", verdict.id)
      .where("status", "=", "pending_corroboration")
      .where("dry_streak", "=", verdict.dry_streak)
      .executeTakeFirst();
    if (Number(result?.numUpdatedRows ?? 0) === 1) bumped += 1;
  }
  if (logger && (bumped > 0 || retired > 0)) {
    logger.info({ evaluated: pending.length, bumped, retired, skippedFresh }, "Verdict dry-streak aging complete");
  }
  return { evaluated: pending.length, bumped, retired, skippedFresh };
}
