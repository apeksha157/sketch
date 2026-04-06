/**
 * Tests for the 016-user-description migration.
 *
 * Uses a fresh blank in-memory SQLite database. The users table is created
 * manually (matching migration 001) before running up() since this migration
 * is an ALTER TABLE on an existing table. Tests verify that the description
 * column is added, stores values correctly, and defaults to null.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./016-user-description";

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  slack_user_id: string | null;
  whatsapp_number: string | null;
  created_at: string;
  description: string | null;
};

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createUsersTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("email", "text")
    .addColumn("slack_user_id", "text", (col) => col.unique())
    .addColumn("whatsapp_number", "text", (col) => col.unique())
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

async function queryUsers(db: Kysely<unknown>): Promise<UserRow[]> {
  return (db as Kysely<{ users: UserRow }>).selectFrom("users").selectAll().execute();
}

describe("016-user-description migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createUsersTable(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("adds the description column and allows inserting a row with a description", async () => {
    await up(db);

    await (db as Kysely<{ users: Omit<UserRow, "created_at"> }>)
      .insertInto("users")
      .values({
        id: "user-001",
        name: "Alice",
        email: null,
        slack_user_id: null,
        whatsapp_number: null,
        description: "Marketing Lead, handles competitive analysis",
      })
      .execute();

    const rows = await queryUsers(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("Marketing Lead, handles competitive analysis");
  });

  it("defaults description to null when not provided", async () => {
    await up(db);

    await (db as Kysely<{ users: Omit<UserRow, "created_at" | "description"> }>)
      .insertInto("users")
      .values({
        id: "user-002",
        name: "Bob",
        email: null,
        slack_user_id: null,
        whatsapp_number: null,
      })
      .execute();

    const rows = await queryUsers(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBeNull();
  });
});
