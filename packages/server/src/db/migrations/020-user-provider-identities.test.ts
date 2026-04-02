/**
 * Tests for the 020-user-provider-identities migration.
 *
 * Uses a fresh blank in-memory SQLite database. The users table is created manually
 * (matching migration 001) before running up() since user_provider_identities has a
 * FK reference to users.id. Tests verify the table and unique index are created
 * correctly, that tokens default to null, and that the unique index on (user_id, provider)
 * is enforced. down() drops the table cleanly.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./020-user-provider-identities";

type UserProviderIdentityRow = {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  provider_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  connected_at: string;
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

async function insertUser(db: Kysely<unknown>, id: string, name: string): Promise<void> {
  await (
    db as Kysely<{
      users: {
        id: string;
        name: string;
        email: string | null;
        slack_user_id: string | null;
        whatsapp_number: string | null;
      };
    }>
  )
    .insertInto("users")
    .values({ id, name, email: null, slack_user_id: null, whatsapp_number: null })
    .execute();
}

describe("020-user-provider-identities migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createUsersTable(db);
    await up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the user_provider_identities table and allows inserting a row", async () => {
    await insertUser(db, "user-001", "Alice");

    type InsertRow = Omit<UserProviderIdentityRow, "connected_at">;
    await (db as Kysely<{ user_provider_identities: InsertRow }>)
      .insertInto("user_provider_identities")
      .values({
        id: "identity-001",
        user_id: "user-001",
        provider: "google",
        provider_user_id: "google-uid-abc",
        provider_email: "alice@example.com",
        access_token: "ya29.access-token",
        refresh_token: "1//refresh-token",
        token_expires_at: "2024-12-31T23:59:59Z",
      })
      .execute();

    const rows = await (db as Kysely<{ user_provider_identities: UserProviderIdentityRow }>)
      .selectFrom("user_provider_identities")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("identity-001");
    expect(rows[0].user_id).toBe("user-001");
    expect(rows[0].provider).toBe("google");
    expect(rows[0].provider_user_id).toBe("google-uid-abc");
    expect(rows[0].provider_email).toBe("alice@example.com");
    expect(rows[0].access_token).toBe("ya29.access-token");
  });

  it("defaults token fields to null when not provided", async () => {
    await insertUser(db, "user-002", "Bob");

    type InsertRow = Omit<UserProviderIdentityRow, "connected_at">;
    await (db as Kysely<{ user_provider_identities: InsertRow }>)
      .insertInto("user_provider_identities")
      .values({
        id: "identity-002",
        user_id: "user-002",
        provider: "linear",
        provider_user_id: "linear-uid-xyz",
        provider_email: null,
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
      })
      .execute();

    const rows = await (db as Kysely<{ user_provider_identities: UserProviderIdentityRow }>)
      .selectFrom("user_provider_identities")
      .selectAll()
      .execute();

    expect(rows[0].provider_email).toBeNull();
    expect(rows[0].access_token).toBeNull();
    expect(rows[0].refresh_token).toBeNull();
    expect(rows[0].token_expires_at).toBeNull();
    expect(rows[0].connected_at).toBeDefined();
    expect(rows[0].connected_at.length).toBeGreaterThan(0);
  });

  it("enforces the unique index on (user_id, provider)", async () => {
    await insertUser(db, "user-003", "Charlie");

    type InsertRow = Omit<UserProviderIdentityRow, "connected_at">;
    const insertDb = db as Kysely<{ user_provider_identities: InsertRow }>;

    await insertDb
      .insertInto("user_provider_identities")
      .values({
        id: "identity-003a",
        user_id: "user-003",
        provider: "google",
        provider_user_id: "google-uid-1",
        provider_email: null,
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
      })
      .execute();

    await expect(
      insertDb
        .insertInto("user_provider_identities")
        .values({
          id: "identity-003b",
          user_id: "user-003",
          provider: "google",
          provider_user_id: "google-uid-2",
          provider_email: null,
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("allows the same provider for different users", async () => {
    await insertUser(db, "user-004", "Dana");
    await insertUser(db, "user-005", "Eve");

    type InsertRow = Omit<UserProviderIdentityRow, "connected_at">;
    const insertDb = db as Kysely<{ user_provider_identities: InsertRow }>;

    await insertDb
      .insertInto("user_provider_identities")
      .values({
        id: "identity-004",
        user_id: "user-004",
        provider: "notion",
        provider_user_id: "notion-uid-1",
        provider_email: null,
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
      })
      .execute();

    await insertDb
      .insertInto("user_provider_identities")
      .values({
        id: "identity-005",
        user_id: "user-005",
        provider: "notion",
        provider_user_id: "notion-uid-2",
        provider_email: null,
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
      })
      .execute();

    const rows = await (db as Kysely<{ user_provider_identities: UserProviderIdentityRow }>)
      .selectFrom("user_provider_identities")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(2);
  });

  it("down() drops the user_provider_identities table", async () => {
    await down(db);

    await expect(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='user_provider_identities'`.execute(db),
    ).resolves.toMatchObject({ rows: [] });
  });
});
