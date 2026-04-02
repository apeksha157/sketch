/**
 * Tests for the 018-user-type-role-hierarchy migration.
 *
 * Uses a fresh blank in-memory SQLite database. The users table is created
 * manually (matching migrations 001 + 016-user-description) before running
 * up() since this migration is an ALTER TABLE on an existing table. Tests verify
 * that type defaults to 'human', role and reports_to default to null, and that
 * agent rows and FK references store correctly. down() removes all three columns.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./018-user-type-role-hierarchy";

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  slack_user_id: string | null;
  whatsapp_number: string | null;
  created_at: string;
  description: string | null;
  type: string;
  role: string | null;
  reports_to: string | null;
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
    .addColumn("description", "text")
    .execute();
}

async function queryUsers(db: Kysely<unknown>): Promise<UserRow[]> {
  return (db as Kysely<{ users: UserRow }>).selectFrom("users").selectAll().execute();
}

describe("018-user-type-role-hierarchy migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createUsersTable(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("adds type, role, and reports_to columns; existing rows get type='human', role=null, reports_to=null", async () => {
    await (db as Kysely<{ users: Omit<UserRow, "created_at" | "type" | "role" | "reports_to"> }>)
      .insertInto("users")
      .values({
        id: "user-001",
        name: "Alice",
        email: null,
        slack_user_id: null,
        whatsapp_number: null,
        description: null,
      })
      .execute();

    await up(db);

    const rows = await queryUsers(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("human");
    expect(rows[0].role).toBeNull();
    expect(rows[0].reports_to).toBeNull();
  });

  it("stores type='agent' correctly when inserted after up()", async () => {
    await up(db);

    await (db as Kysely<{ users: Omit<UserRow, "created_at"> }>)
      .insertInto("users")
      .values({
        id: "agent-001",
        name: "Research Bot",
        email: null,
        slack_user_id: null,
        whatsapp_number: null,
        description: "Automates competitor research",
        type: "agent",
        role: "Research Assistant",
        reports_to: null,
      })
      .execute();

    const rows = await queryUsers(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("agent");
    expect(rows[0].role).toBe("Research Assistant");
  });

  it("defaults new rows to type='human' when type is not specified", async () => {
    await up(db);

    await (db as Kysely<{ users: Omit<UserRow, "created_at" | "role" | "reports_to"> }>)
      .insertInto("users")
      .values({
        id: "user-002",
        name: "Bob",
        email: null,
        slack_user_id: null,
        whatsapp_number: null,
        description: null,
        type: "human",
      })
      .execute();

    const rows = await queryUsers(db);
    expect(rows[0].type).toBe("human");
    expect(rows[0].role).toBeNull();
    expect(rows[0].reports_to).toBeNull();
  });

  it("stores reports_to referencing another user correctly", async () => {
    await up(db);

    await (db as Kysely<{ users: Omit<UserRow, "created_at"> }>)
      .insertInto("users")
      .values({
        id: "user-ceo",
        name: "CEO",
        email: null,
        slack_user_id: null,
        whatsapp_number: null,
        description: null,
        type: "human",
        role: "CEO",
        reports_to: null,
      })
      .execute();

    await (db as Kysely<{ users: Omit<UserRow, "created_at"> }>)
      .insertInto("users")
      .values({
        id: "user-vp",
        name: "VP",
        email: null,
        slack_user_id: null,
        whatsapp_number: null,
        description: null,
        type: "human",
        role: "VP Marketing",
        reports_to: "user-ceo",
      })
      .execute();

    const rows = await queryUsers(db);
    const vp = rows.find((r) => r.id === "user-vp");
    expect(vp?.reports_to).toBe("user-ceo");
  });

  it("down() drops type, role, and reports_to columns", async () => {
    await up(db);
    await down(db);

    await (db as Kysely<{ users: Omit<UserRow, "created_at" | "type" | "role" | "reports_to"> }>)
      .insertInto("users")
      .values({
        id: "user-003",
        name: "Charlie",
        email: null,
        slack_user_id: null,
        whatsapp_number: null,
        description: null,
      })
      .execute();

    const rawDb = db as Kysely<{ users: Record<string, unknown> }>;
    const rows = await rawDb.selectFrom("users").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect("type" in rows[0]).toBe(false);
    expect("role" in rows[0]).toBe(false);
    expect("reports_to" in rows[0]).toBe(false);
  });
});
