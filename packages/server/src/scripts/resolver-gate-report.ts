import { parseArgs } from "node:util";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { loadConfig, validateConfig } from "../config";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB } from "../db/schema";
import { createBacklogSweepContext, decideBacklogSweepRow } from "../entities/backlog-sweep";
import { normalizeName } from "../entities/name-keys";
import { connectionStringForDbArg } from "./resolution-eval/db";

/**
 * The gate report for flipping RESOLVER_AUTO_APPLY_KINDS: before a kind may
 * auto-apply, its machine-filed verdicts get machine-graded here and
 * spot-checked by a human. link_to verdicts are graded against the
 * deterministic census (decideBacklogSweepRow on the same queue row): the
 * census agreeing on the same target is a pass, a different target is a fail,
 * and census abstention leaves the row to the human sample. dismiss has no
 * deterministic oracle, so the report lists them all for spot-check.
 * remove_alias is graded by alias provenance — the executor will only approve
 * mint_model/legacy rows, so anything else counts as parked.
 */

type VerdictRow = {
  id: string;
  action: string;
  status: string;
  subject_mention_name: string | null;
  subject_entity_type: string | null;
  subject_entity_id: string | null;
  target_entity_id: string | null;
  target_name: string | null;
  reason: string;
  evidence_json: string;
};

function reviewIdsOf(evidenceJson: string): string[] {
  try {
    const parsed = JSON.parse(evidenceJson) as { reviewIds?: unknown };
    return Array.isArray(parsed.reviewIds)
      ? parsed.reviewIds.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

async function createDbFromArg(dbArg: string | undefined): Promise<Kysely<DB>> {
  if (!dbArg) {
    const config = loadConfig();
    validateConfig(config);
    return createDatabase(config);
  }
  const pool = new pg.Pool({ connectionString: connectionStringForDbArg(dbArg) });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

async function loadMachineVerdicts(db: Kysely<DB>, action: string): Promise<VerdictRow[]> {
  return db
    .selectFrom("graph_verdicts")
    .innerJoin("graph_verdict_runs", "graph_verdict_runs.id", "graph_verdicts.run_id")
    .select([
      "graph_verdicts.id as id",
      "action",
      "graph_verdicts.status as status",
      "subject_mention_name",
      "subject_entity_type",
      "subject_entity_id",
      "target_entity_id",
      "target_name",
      "reason",
      "evidence_json",
    ])
    .where("graph_verdict_runs.proposed_by_user_id", "=", MACHINE_PRINCIPAL_USER_ID)
    .where("graph_verdicts.action", "=", action)
    .where("graph_verdicts.superseded_at", "is", null)
    .where("graph_verdicts.status", "in", ["awaiting_human", "approved", "applied"])
    .orderBy("graph_verdicts.created_at", "asc")
    .execute();
}

async function gradeLinkVerdicts(db: Kysely<DB>) {
  const verdicts = await loadMachineVerdicts(db, "link_to");
  const ctx = await createBacklogSweepContext(db);
  const rows: Array<Record<string, unknown>> = [];
  let agree = 0;
  let disagree = 0;
  let censusAbstains = 0;
  let noQueueRow = 0;
  for (const verdict of verdicts) {
    const reviewId = reviewIdsOf(verdict.evidence_json)[0];
    const queueRow = reviewId
      ? await db.selectFrom("entity_review_queue").selectAll().where("id", "=", reviewId).executeTakeFirst()
      : undefined;
    if (!queueRow) {
      noQueueRow += 1;
      rows.push({ verdictId: verdict.id, name: verdict.subject_mention_name, grade: "no_queue_row" });
      continue;
    }
    const decision = await decideBacklogSweepRow(ctx, queueRow);
    if (decision.kind === "link") {
      if (decision.targetEntityId === verdict.target_entity_id) agree += 1;
      else disagree += 1;
      rows.push({
        verdictId: verdict.id,
        name: verdict.subject_mention_name,
        judgeTarget: verdict.target_entity_id,
        censusTarget: decision.targetEntityId,
        grade: decision.targetEntityId === verdict.target_entity_id ? "agree" : "DISAGREE",
        reason: verdict.reason,
      });
      continue;
    }
    censusAbstains += 1;
    rows.push({
      verdictId: verdict.id,
      name: verdict.subject_mention_name,
      judgeTarget: verdict.target_entity_id,
      censusOutcome: decision.kind,
      grade: "census_abstains",
      reason: verdict.reason,
    });
  }
  return { total: verdicts.length, agree, disagree, censusAbstains, noQueueRow, rows };
}

async function listDismissVerdicts(db: Kysely<DB>) {
  const verdicts = await loadMachineVerdicts(db, "dismiss");
  return {
    total: verdicts.length,
    rows: verdicts.map((verdict) => ({
      verdictId: verdict.id,
      name: verdict.subject_mention_name,
      entityType: verdict.subject_entity_type,
      status: verdict.status,
      reason: verdict.reason,
    })),
  };
}

async function gradeRemoveAliasVerdicts(db: Kysely<DB>) {
  const verdicts = await loadMachineVerdicts(db, "remove_alias");
  const rows: Array<Record<string, unknown>> = [];
  let eligible = 0;
  let parked = 0;
  for (const verdict of verdicts) {
    const alias =
      verdict.subject_entity_id && verdict.target_name
        ? await db
            .selectFrom("entity_aliases")
            .select("provenance")
            .where("entity_id", "=", verdict.subject_entity_id)
            .where("normalized_alias", "=", normalizeName(verdict.target_name))
            .executeTakeFirst()
        : undefined;
    const isEligible = alias?.provenance === "mint_model" || alias?.provenance === "legacy";
    if (isEligible) eligible += 1;
    else parked += 1;
    rows.push({
      verdictId: verdict.id,
      alias: verdict.target_name,
      provenance: alias?.provenance ?? null,
      grade: isEligible ? "eligible" : "parked",
    });
  }
  return { total: verdicts.length, eligible, parked, rows };
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      db: { type: "string" },
      full: { type: "boolean", default: false },
    },
  });
  const db = await createDbFromArg(parsed.values.db);
  try {
    await runMigrations(db);
    const linkTo = await gradeLinkVerdicts(db);
    const dismiss = await listDismissVerdicts(db);
    const removeAlias = await gradeRemoveAliasVerdicts(db);
    const report = parsed.values.full
      ? { link_to: linkTo, dismiss, remove_alias: removeAlias }
      : {
          link_to: { ...linkTo, rows: linkTo.rows.filter((row) => row.grade !== "agree") },
          dismiss: { total: dismiss.total, rows: dismiss.rows.slice(0, 25) },
          remove_alias: { ...removeAlias, rows: removeAlias.rows.filter((row) => row.grade !== "eligible") },
        };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
