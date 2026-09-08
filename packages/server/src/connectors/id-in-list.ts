import type { Kysely, RawBuilder, SqlBool } from "kysely";
import { sql } from "kysely";
import { isPg } from "../db/dialect";

const SQLITE_IN_LIST_MAX_IDS = 32_000;

export class InListTooLargeError extends Error {
  constructor(
    readonly count: number,
    readonly maximum: number = SQLITE_IN_LIST_MAX_IDS,
  ) {
    super(`SQLite IN list contains ${count} ids; the maximum is ${maximum}`);
    this.name = "InListTooLargeError";
  }
}

/** Render a native text-ID predicate, keeping SQLite below its 32,766-variable default with room for other binds. */
export function idInList<Database>(
  db: Kysely<Database>,
  column: RawBuilder<unknown>,
  ids: readonly string[],
): RawBuilder<SqlBool> {
  if (ids.length === 0) return sql<SqlBool>`FALSE`;
  if (isPg(db)) return sql<SqlBool>`${column} = ANY(${ids}::text[])`;
  if (ids.length > SQLITE_IN_LIST_MAX_IDS) throw new InListTooLargeError(ids.length);
  return sql<SqlBool>`${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`,`,
  )})`;
}
