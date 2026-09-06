import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { InListTooLargeError, idInList } from "./id-in-list";

const databases: Kysely<DB>[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

describe("idInList", () => {
  it("compiles a SQLite IN predicate", () => {
    const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    databases.push(db);

    const compiled = db
      .selectFrom("indexed_files")
      .select("id")
      .where(idInList(db, sql.ref("indexed_files.id"), ["file-1", "file-2"]))
      .compile();

    expect(compiled.sql).toContain('"indexed_files"."id" IN (?,?)');
    expect(compiled.parameters).toEqual(["file-1", "file-2"]);
  });

  it("throws a typed error before a SQLite list exceeds the guarded cap", () => {
    const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    databases.push(db);
    const ids = Array.from({ length: 32_001 }, (_, index) => `file-${index}`);

    expect(() => idInList(db, sql.ref("indexed_files.id"), ids)).toThrow(InListTooLargeError);
  });

  it("compiles a Postgres array predicate with exactly one parameter", () => {
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool() }) });
    databases.push(db);
    const ids = Array.from({ length: 1_000 }, (_, index) => `file-${index}`);

    const compiled = db
      .selectFrom("indexed_files")
      .select("id")
      .where(idInList(db, sql.ref("indexed_files.id"), ids))
      .compile();

    expect(compiled.sql).toContain('"indexed_files"."id" = ANY($1::text[])');
    expect(compiled.parameters).toEqual([ids]);
  });
});
