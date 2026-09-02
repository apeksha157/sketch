import { parseArgs } from "node:util";
import { Kysely, PostgresDialect, type Selectable } from "kysely";
import pg from "pg";
import { loadConfig, validateConfig } from "../config";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import { whereLiveEntity } from "../db/repositories/entities";
import { recordAlias } from "../db/repositories/entity-alias-rows";
import type { DB, EntitiesTable, EntityAliasProvenance } from "../db/schema";
import { parseAliasesString, readPersonEmailFromMetadata } from "../entities/materialize-json";
import { normalizeName } from "../entities/name-keys";
import { connectionStringForDbArg } from "./resolution-eval/db";

type Entity = Selectable<EntitiesTable>;

export interface EntityAliasBackfillCensus {
  totalBlobAliases: number;
  rowsWritten: number;
  provenanceDistribution: Record<EntityAliasProvenance, number>;
  entitiesTouched: number;
  aliasesSkippedAsDuplicate: number;
}

interface AliasEvidence {
  roster: Set<string>;
  merge: Set<string>;
  mintModel: Set<string>;
  humanConfirmed: Set<string>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVENANCE_ORDER: EntityAliasProvenance[] = [
  "legacy",
  "mint_model",
  "roster",
  "merge",
  "judge",
  "human_confirmed",
];

function emptyDistribution(): Record<EntityAliasProvenance, number> {
  return {
    legacy: 0,
    mint_model: 0,
    roster: 0,
    merge: 0,
    judge: 0,
    human_confirmed: 0,
  };
}

function normalizedEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && EMAIL_RE.test(normalized) ? normalized : null;
}

function addNormalizedAlias(
  target: Map<string, Set<string>>,
  entityId: string,
  value: string | null | undefined,
): void {
  const normalized = normalizeName(value ?? "");
  if (!normalized) return;
  const aliases = target.get(entityId) ?? new Set<string>();
  aliases.add(normalized);
  target.set(entityId, aliases);
}

function parseMergeAliasMoves(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (move): move is { kind: "alias_added"; value: string } =>
          move && typeof move === "object" && move.kind === "alias_added" && typeof move.value === "string",
      )
      .map((move) => move.value);
  } catch {
    return [];
  }
}

function strongestBackfillProvenance(evidence: AliasEvidence, normalizedAlias: string): EntityAliasProvenance {
  if (evidence.humanConfirmed.has(normalizedAlias)) return "human_confirmed";
  if (evidence.merge.has(normalizedAlias)) return "merge";
  if (evidence.roster.has(normalizedAlias)) return "roster";
  if (evidence.mintModel.has(normalizedAlias)) return "mint_model";
  return "legacy";
}

async function loadMergeAliases(db: Kysely<DB>): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const rows = await db
    .selectFrom("entity_merges")
    .select(["survivor_entity_id", "moves"])
    .where("unmerged_at", "is", null)
    .execute();
  for (const row of rows) {
    for (const alias of parseMergeAliasMoves(row.moves)) {
      addNormalizedAlias(out, row.survivor_entity_id, alias);
    }
  }
  return out;
}

async function loadReviewAliases(db: Kysely<DB>): Promise<{
  seedAliases: Map<string, Set<string>>;
  proposedNames: Map<string, Set<string>>;
}> {
  const seedAliases = new Map<string, Set<string>>();
  const proposedNames = new Map<string, Set<string>>();
  const rows = await db
    .selectFrom("entity_review_queue")
    .select(["resolved_entity_id", "proposed_name", "seed_aliases"])
    .where("status", "=", "confirmed")
    .where("resolved_entity_id", "is not", null)
    .execute();
  for (const row of rows) {
    const entityId = row.resolved_entity_id;
    if (!entityId) continue;
    addNormalizedAlias(proposedNames, entityId, row.proposed_name);
    for (const alias of parseAliasesString(row.seed_aliases)) {
      addNormalizedAlias(seedAliases, entityId, alias);
    }
  }
  return { seedAliases, proposedNames };
}

async function loadRosterEmails(db: Kysely<DB>, entities: Entity[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const entity of entities) {
    const email = readPersonEmailFromMetadata(entity.metadata);
    if (email) addNormalizedAlias(out, entity.id, email);
  }

  const contactRows = await db
    .selectFrom("entity_contact_points")
    .select(["entity_id", "value", "display_value"])
    .where("kind", "=", "email")
    .execute();
  for (const row of contactRows) {
    addNormalizedAlias(out, row.entity_id, normalizedEmail(row.value));
    addNormalizedAlias(out, row.entity_id, normalizedEmail(row.display_value));
  }

  const sourceRows = await db.selectFrom("entity_source_refs").select(["entity_id", "source_id"]).execute();
  for (const row of sourceRows) {
    addNormalizedAlias(out, row.entity_id, normalizedEmail(row.source_id));
  }
  return out;
}

async function existingAliasKeys(db: Kysely<DB>): Promise<Set<string>> {
  const rows = await db.selectFrom("entity_aliases").select(["entity_id", "normalized_alias"]).execute();
  return new Set(rows.map((row) => `${row.entity_id}\0${row.normalized_alias}`));
}

async function aliasRowCount(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_aliases")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function backfillEntityAliases(db: Kysely<DB>): Promise<EntityAliasBackfillCensus> {
  const entities = await db.selectFrom("entities").selectAll().where(whereLiveEntity()).orderBy("id", "asc").execute();
  const [rosterEmails, mergeAliases, reviewAliases, existingKeys] = await Promise.all([
    loadRosterEmails(db, entities),
    loadMergeAliases(db),
    loadReviewAliases(db),
    existingAliasKeys(db),
  ]);
  const beforeCount = await aliasRowCount(db);
  const provenanceDistribution = emptyDistribution();
  let totalBlobAliases = 0;
  let aliasesSkippedAsDuplicate = 0;
  let entitiesTouched = 0;

  for (const entity of entities) {
    const aliases = parseAliasesString(entity.aliases);
    if (aliases.length === 0) continue;
    entitiesTouched += 1;
    const seenForEntity = new Set<string>();
    for (const alias of aliases) {
      totalBlobAliases += 1;
      const normalizedAlias = normalizeName(alias);
      if (!normalizedAlias) continue;
      if (seenForEntity.has(normalizedAlias)) {
        aliasesSkippedAsDuplicate += 1;
        continue;
      }
      seenForEntity.add(normalizedAlias);
      const provenance = strongestBackfillProvenance(
        {
          roster: rosterEmails.get(entity.id) ?? new Set(),
          merge: mergeAliases.get(entity.id) ?? new Set(),
          mintModel: reviewAliases.seedAliases.get(entity.id) ?? new Set(),
          humanConfirmed: reviewAliases.proposedNames.get(entity.id) ?? new Set(),
        },
        normalizedAlias,
      );
      provenanceDistribution[provenance] += 1;
      const key = `${entity.id}\0${normalizedAlias}`;
      if (existingKeys.has(key)) continue;
      await recordAlias(db, { entityId: entity.id, alias, provenance, createdBy: "entity_alias_backfill" });
      existingKeys.add(key);
    }
  }

  return {
    totalBlobAliases,
    rowsWritten: (await aliasRowCount(db)) - beforeCount,
    provenanceDistribution: Object.fromEntries(
      PROVENANCE_ORDER.map((provenance) => [provenance, provenanceDistribution[provenance]]),
    ) as Record<EntityAliasProvenance, number>,
    entitiesTouched,
    aliasesSkippedAsDuplicate,
  };
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
    console.log(JSON.stringify(await backfillEntityAliases(db), null, 2));
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
