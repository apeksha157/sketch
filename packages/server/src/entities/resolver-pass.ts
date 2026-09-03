import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import { createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB, ResolverRunsTable } from "../db/schema";
import { type BacklogSweepResult, runBacklogSweep } from "./backlog-sweep";
import { type JudgeDrainAgenticGenerator, type JudgeDrainReport, runJudgeDrain } from "./judge-drain";
import { normalizeName } from "./name-keys";
import { GraphVerdictApplyError, applyGraphVerdict } from "./verdict-apply";
import { agePendingVerdicts } from "./verdict-ripening";

const QUEUED = "queued";
const RUNNING = "running";
const COMPLETED = "completed";
const FAILED = "failed";
const LEASE_DURATION_MS = 30 * 60 * 1000;

export type ResolverAutoApplyKind = "link_to" | "dismiss" | "remove_alias";

export interface ResolverPassDeps {
  db: Kysely<DB>;
  logger: Logger;
  generateAgenticJSON?: JudgeDrainAgenticGenerator["generateAgenticJSON"] | null;
  model?: string | null;
  intervalMs?: number;
  drainLimit?: number;
  autoApplyKinds?: ResolverAutoApplyKind[];
  now?: () => Date;
}

export interface ResolverPassResult {
  status: string;
  runKey: string;
  sweepLinked: number;
  drainFiled: number;
  agedRetired: number;
  approvedAuto: number;
  applied: number;
  bouncedDrift: number;
}

type RunRow = Selectable<ResolverRunsTable>;

/**
 * Verdicts whose proposal-time plan no longer verifies go back to human
 * re-adjudication instead of applying blind; conflicts and vanished rows are
 * someone else's completed work, not drift.
 */
const BOUNCE_CODES = new Set(["PLAN_DRIFT", "PLAN_BLOCKED", "STALE_VERDICT"]);

function runKeyFor(clock: Date): string {
  return `resolver:${clock.toISOString().slice(0, 10)}`;
}

function resultFromRun(run: RunRow): ResolverPassResult {
  return {
    status: run.status,
    runKey: run.run_key,
    sweepLinked: run.sweep_linked,
    drainFiled: run.drain_filed,
    agedRetired: run.aged_retired,
    approvedAuto: run.approved_auto,
    applied: run.applied,
    bouncedDrift: run.bounced_drift,
  };
}

async function ensureRun(db: Kysely<DB>, key: string): Promise<RunRow> {
  const existing = await db.selectFrom("resolver_runs").selectAll().where("run_key", "=", key).executeTakeFirst();
  if (existing) return existing;
  await db
    .insertInto("resolver_runs")
    .values({ id: randomUUID(), run_key: key, status: QUEUED })
    .onConflict((oc) => oc.column("run_key").doNothing())
    .execute();
  return db.selectFrom("resolver_runs").selectAll().where("run_key", "=", key).executeTakeFirstOrThrow();
}

async function previousCompletedRunStart(db: Kysely<DB>, currentRunId: string): Promise<string | null> {
  const row = await db
    .selectFrom("resolver_runs")
    .select("started_at")
    .where("status", "=", COMPLETED)
    .where("id", "!=", currentRunId)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.started_at ?? null;
}

/**
 * Fresh machine verdicts of a gated kind become approved before the executor
 * leg. remove_alias keeps the provenance rule that lived in the curation
 * tool's autoApply path: only aliases whose row proves machine cleanup or
 * legacy backfill origin — unknown provenance stays parked for a human.
 */
export async function approveGatedKinds(
  db: Kysely<DB>,
  params: { kinds: ResolverAutoApplyKind[]; since: string },
): Promise<{ approved: string[] }> {
  if (params.kinds.length === 0) return { approved: [] };
  const repo = createGraphVerdictRepository(db);
  const candidates = await db
    .selectFrom("graph_verdicts")
    .innerJoin("graph_verdict_runs", "graph_verdict_runs.id", "graph_verdicts.run_id")
    .select(["graph_verdicts.id as id", "action", "subject_entity_id", "target_name"])
    .where("graph_verdict_runs.proposed_by_user_id", "=", MACHINE_PRINCIPAL_USER_ID)
    .where("graph_verdicts.status", "=", "awaiting_human")
    .where("graph_verdicts.superseded_at", "is", null)
    .where("graph_verdicts.action", "in", params.kinds)
    .where("graph_verdicts.created_at", ">=", params.since)
    .orderBy("graph_verdicts.created_at", "asc")
    .execute();
  const approved: string[] = [];
  for (const candidate of candidates) {
    if (candidate.action === "remove_alias") {
      if (!candidate.subject_entity_id || !candidate.target_name) continue;
      const alias = await db
        .selectFrom("entity_aliases")
        .select("provenance")
        .where("entity_id", "=", candidate.subject_entity_id)
        .where("normalized_alias", "=", normalizeName(candidate.target_name))
        .executeTakeFirst();
      if (alias?.provenance !== "mint_model" && alias?.provenance !== "legacy") continue;
    }
    if (await repo.markApproved({ id: candidate.id, actorUserId: MACHINE_PRINCIPAL_USER_ID })) {
      approved.push(candidate.id);
    }
  }
  return { approved };
}

export async function runExecutorLeg(
  db: Kysely<DB>,
  logger: Logger,
): Promise<{ applied: number; bouncedDrift: number; failed: number }> {
  const approvedRows = await db
    .selectFrom("graph_verdicts")
    .select(["id"])
    .where("status", "=", "approved")
    .where("superseded_at", "is", null)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  let applied = 0;
  let bouncedDrift = 0;
  let failed = 0;
  for (const row of approvedRows) {
    try {
      await applyGraphVerdict(db, { verdictId: row.id, actorUserId: MACHINE_PRINCIPAL_USER_ID });
      applied += 1;
    } catch (error) {
      if (error instanceof GraphVerdictApplyError && BOUNCE_CODES.has(error.code)) {
        const bounced = await db
          .updateTable("graph_verdicts")
          .set({ status: "awaiting_human", updated_at: new Date().toISOString() })
          .where("id", "=", row.id)
          .where("status", "=", "approved")
          .executeTakeFirst();
        if (Number(bounced?.numUpdatedRows ?? 0) === 1) bouncedDrift += 1;
        logger.warn({ verdictId: row.id, code: error.code }, "Resolver executor bounced drifted verdict to human");
        continue;
      }
      if (error instanceof GraphVerdictApplyError) continue;
      failed += 1;
      logger.error({ err: error, verdictId: row.id }, "Resolver executor apply failed");
    }
  }
  return { applied, bouncedDrift, failed };
}

export function createResolverPassService(deps: ResolverPassDeps) {
  const intervalMs = deps.intervalMs ?? 24 * 60 * 60 * 1000;
  const drainLimit = deps.drainLimit ?? 100;
  const autoApplyKinds = deps.autoApplyKinds ?? [];
  const clock = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<ResolverPassResult> | null = null;

  async function runOnce(): Promise<ResolverPassResult> {
    if (inflight) return inflight;
    inflight = runPass().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function runPass(): Promise<ResolverPassResult> {
    const key = runKeyFor(clock());
    const current = await ensureRun(deps.db, key);
    if (current.status === COMPLETED) return resultFromRun(current);
    const cutoff = new Date(Date.now() - LEASE_DURATION_MS).toISOString();
    if (current.status === RUNNING && current.heartbeat_at !== null && current.heartbeat_at >= cutoff) {
      return resultFromRun(current);
    }
    const leaseToken = randomUUID();
    const now = clock().toISOString();
    const run = await deps.db
      .updateTable("resolver_runs")
      .set({
        lease_token: leaseToken,
        status: RUNNING,
        heartbeat_at: now,
        completed_at: null,
        error: null,
        updated_at: now,
      })
      .where("id", "=", current.id)
      .where((eb) =>
        eb.or([eb("status", "!=", RUNNING), eb("heartbeat_at", "is", null), eb("heartbeat_at", "<", cutoff)]),
      )
      .returningAll()
      .executeTakeFirst();
    if (!run) return resultFromRun(current);
    const ownedRun = run;

    async function updateOwnedRun(values: Record<string, unknown>): Promise<RunRow> {
      const updated = await deps.db
        .updateTable("resolver_runs")
        .set(values)
        .where("id", "=", ownedRun.id)
        .where("lease_token", "=", leaseToken)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new Error("resolver pass lease lost");
      return updated;
    }

    try {
      const passStartedAt = clock().toISOString();
      const sweep: BacklogSweepResult = await runBacklogSweep({ db: deps.db, logger: deps.logger }, { apply: true });
      const sweepLinked = sweep.linked?.length ?? 0;
      await updateOwnedRun({
        sweep_linked: sweepLinked,
        heartbeat_at: clock().toISOString(),
        updated_at: clock().toISOString(),
      });

      let drain: JudgeDrainReport | null = null;
      if (deps.generateAgenticJSON && drainLimit > 0) {
        drain = await runJudgeDrain(
          { db: deps.db, generateAgenticJSON: deps.generateAgenticJSON, model: deps.model ?? null },
          { limit: drainLimit, propose: true },
        );
      }
      const drainFiled = drain?.proposed?.filed ?? 0;
      await updateOwnedRun({
        drain_filed: drainFiled,
        heartbeat_at: clock().toISOString(),
        updated_at: clock().toISOString(),
      });

      /**
       * Aging measures silence between passes, so it only runs once there IS a
       * previous pass to measure from — the first ever pass ages nothing.
       */
      const since = await previousCompletedRunStart(deps.db, ownedRun.id);
      const aging = since ? await agePendingVerdicts(deps.db, { since }, deps.logger) : null;
      await updateOwnedRun({
        aged_retired: aging?.retired ?? 0,
        heartbeat_at: clock().toISOString(),
        updated_at: clock().toISOString(),
      });

      const gated = await approveGatedKinds(deps.db, { kinds: autoApplyKinds, since: passStartedAt });
      const executor = await runExecutorLeg(deps.db, deps.logger);

      const summary = {
        sweep: { scanned: sweep.scanned, linked: sweepLinked },
        drain: drain
          ? { docket: drain.docket, filed: drainFiled, counts: drain.counts, failures: drain.failures.length }
          : { skipped: true },
        aging: aging ?? { skipped: true },
        gated: { kinds: autoApplyKinds, approved: gated.approved.length },
        executor,
      };
      const completed = await updateOwnedRun({
        status: COMPLETED,
        approved_auto: gated.approved.length,
        applied: executor.applied,
        bounced_drift: executor.bouncedDrift,
        summary_json: JSON.stringify(summary),
        heartbeat_at: clock().toISOString(),
        completed_at: clock().toISOString(),
        updated_at: clock().toISOString(),
      });
      deps.logger.info({ runKey: key, ...summary }, "Resolver pass complete");
      return resultFromRun(completed);
    } catch (error) {
      await deps.db
        .updateTable("resolver_runs")
        .set({
          status: FAILED,
          error: error instanceof Error ? error.message : "resolver pass failed",
          heartbeat_at: null,
          updated_at: clock().toISOString(),
        })
        .where("id", "=", ownedRun.id)
        .where("lease_token", "=", leaseToken)
        .execute();
      throw error;
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      void runOnce().catch((error) => deps.logger.error({ err: error }, "Resolver pass failed"));
      timer = setInterval(
        () => void runOnce().catch((error) => deps.logger.error({ err: error }, "Resolver pass failed")),
        intervalMs,
      );
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inflight;
    },
  };
}
