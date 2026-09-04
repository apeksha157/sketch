import { PostgresAdapter, sql } from "kysely";
import type { Kysely } from "kysely";

// biome-ignore lint/suspicious/noExplicitAny: generic adapter check works for any DB schema
export function isPg(db: Kysely<any>): boolean {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

// biome-ignore lint/suspicious/noExplicitAny: generic DB schema keeps this helper reusable across repositories.
export function metadataFlagIsTrue(db: Kysely<any>, key: string) {
  return isPg(db)
    ? sql<boolean>`(metadata::jsonb ->> ${key}) = 'true'`
    : sql<boolean>`json_extract(metadata, ${`$.${key}`}) = 1`;
}
