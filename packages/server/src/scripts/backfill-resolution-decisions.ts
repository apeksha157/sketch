import { parseArgs } from "node:util";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { loadConfig, validateConfig } from "../config";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { createResolutionDecisionRepository } from "../db/repositories/resolution-decisions";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { readPersonEmailFromMetadata } from "../entities/materialize-json";
import { strongestProvenanceTier } from "../entities/provenance";
import { connectionStringForDbArg } from "./resolution-eval/db";

export interface ResolutionDecisionBackfillCensus {
  rowsSeen: number;
  ledgerRowsWritten: number;
  tiersPromoted: number;
  skippedDeadTarget: number;
}

async function existingLinkKeys(db: Kysely<DB>): Promise<Set<string>> {
  const rows = await db
    .selectFrom("resolution_decisions")
    .select(["normalized_mention_name", "entity_type", "scope"])
    .where("verdict", "=", "link")
    .execute();
  return new Set(rows.map((row) => `${row.normalized_mention_name}\0${row.entity_type}\0${row.scope}`));
}

export async function backfillResolutionDecisions(db: Kysely<DB>): Promise<ResolutionDecisionBackfillCensus> {
  const ledger = createResolutionDecisionRepository(db);
  const entityRepo = createEntityRepository(db);
  const seenLinkKeys = await existingLinkKeys(db);
  const rows = await db
    .selectFrom("entity_review_queue")
    .selectAll()
    .where("status", "=", "confirmed")
    .where("resolved_entity_id", "is not", null)
    .orderBy("resolved_at", "asc")
    .orderBy("id", "asc")
    .execute();
  let ledgerRowsWritten = 0;
  let tiersPromoted = 0;
  let skippedDeadTarget = 0;

  for (const row of rows) {
    if (!row.resolved_entity_id) continue;
    const target = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", row.resolved_entity_id)
      .where("source_type", "=", row.entity_type)
      .where(whereLiveEntity())
      .executeTakeFirst();
    if (!target) {
      skippedDeadTarget += 1;
      continue;
    }

    const decider = row.resolved_by === MACHINE_PRINCIPAL_USER_ID ? "judge" : "human";
    const targetTier = strongestProvenanceTier(
      target.provenance_tier,
      decider === "judge" ? "machine_confirmed" : "human_confirmed",
    );
    if (targetTier !== target.provenance_tier && (await entityRepo.promoteProvenanceTier(target.id, targetTier))) {
      tiersPromoted += 1;
    }
    const evidence = await db
      .selectFrom("entity_review_evidence")
      .select(["indexed_file_id", "source"])
      .where("review_id", "=", row.id)
      .execute();
    const source = row.source ?? evidence[0]?.source ?? "entity-review";
    const sourceId = row.source_id ?? `review:${row.id}`;
    const key = `${row.normalized_name}\0${row.entity_type}\0global`;
    await ledger.recordLink({
      normalizedMentionName: row.normalized_name,
      entityType: row.entity_type,
      targetEntityId: target.id,
      targetName: target.name,
      targetEmail: readPersonEmailFromMetadata(target.metadata) ?? row.proposed_email,
      decider,
      decidedBy: row.resolved_by ?? "backfill",
      source,
      sourceId,
      evidenceFileIds: evidence.map((item) => item.indexed_file_id),
    });
    if (!seenLinkKeys.has(key)) {
      seenLinkKeys.add(key);
      ledgerRowsWritten += 1;
    }
  }

  return { rowsSeen: rows.length, ledgerRowsWritten, tiersPromoted, skippedDeadTarget };
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

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      db: { type: "string" },
    },
  });
  const db = await createDbFromArg(parsed.values.db);
  try {
    await runMigrations(db);
    console.log(JSON.stringify(await backfillResolutionDecisions(db), null, 2));
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
