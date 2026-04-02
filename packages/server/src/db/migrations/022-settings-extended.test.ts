/**
 * Tests for the 022-settings-extended migration.
 *
 * Uses a fresh blank in-memory SQLite database. The settings table is created manually
 * (matching migrations 004 + 007) before running up(), since this migration only adds
 * new columns. Tests verify that only the four new columns are added
 * (smtp_secure, google_oauth_client_id, google_oauth_client_secret, gemini_api_key),
 * that smtp_secure defaults to 1, and that the OAuth/Gemini columns default to null.
 * Note: down() is a no-op for this migration (SQLite cannot drop columns in older
 * versions and the migration explicitly does nothing).
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./022-settings-extended";

type SettingsRow = {
  id: string;
  admin_email: string | null;
  admin_password_hash: string | null;
  org_name: string | null;
  bot_name: string | null;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
  // From 007-settings-smtp
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_password: string | null;
  smtp_from: string | null;
  // From this migration
  smtp_secure: number;
  google_oauth_client_id: string | null;
  google_oauth_client_secret: string | null;
  gemini_api_key: string | null;
};

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createSettingsTable(db: Kysely<unknown>): Promise<void> {
  // Matches 004-settings + 007-settings-smtp columns
  await db.schema
    .createTable("settings")
    .addColumn("id", "text", (col) => col.primaryKey().defaultTo("default"))
    .addColumn("admin_email", "text")
    .addColumn("admin_password_hash", "text")
    .addColumn("org_name", "text")
    .addColumn("bot_name", "text", (col) => col.defaultTo("Sketch"))
    .addColumn("onboarding_completed_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.alterTable("settings").addColumn("smtp_host", "text").execute();
  await db.schema.alterTable("settings").addColumn("smtp_port", "integer").execute();
  await db.schema.alterTable("settings").addColumn("smtp_user", "text").execute();
  await db.schema.alterTable("settings").addColumn("smtp_password", "text").execute();
  await db.schema.alterTable("settings").addColumn("smtp_from", "text").execute();
}

describe("022-settings-extended migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createSettingsTable(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("adds smtp_secure, google_oauth_client_id, google_oauth_client_secret, gemini_api_key columns", async () => {
    await up(db);

    // Insert using the new columns to confirm they exist
    type InsertRow = Omit<SettingsRow, "created_at" | "updated_at">;
    await (db as Kysely<{ settings: InsertRow }>)
      .insertInto("settings")
      .values({
        id: "default",
        admin_email: null,
        admin_password_hash: null,
        org_name: "Acme Corp",
        bot_name: "Sketch",
        onboarding_completed_at: null,
        smtp_host: null,
        smtp_port: null,
        smtp_user: null,
        smtp_password: null,
        smtp_from: null,
        smtp_secure: 1,
        google_oauth_client_id: "client-id-123",
        google_oauth_client_secret: "client-secret-456",
        gemini_api_key: "gemini-key-789",
      })
      .execute();

    const rows = await (db as Kysely<{ settings: SettingsRow }>).selectFrom("settings").selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].google_oauth_client_id).toBe("client-id-123");
    expect(rows[0].google_oauth_client_secret).toBe("client-secret-456");
    expect(rows[0].gemini_api_key).toBe("gemini-key-789");
  });

  it("defaults smtp_secure to 1 (enabled) when not specified", async () => {
    // Insert a row before migration to verify existing rows get the default
    type PreMigrationRow = Omit<
      SettingsRow,
      | "created_at"
      | "updated_at"
      | "smtp_secure"
      | "google_oauth_client_id"
      | "google_oauth_client_secret"
      | "gemini_api_key"
    >;
    await (db as Kysely<{ settings: PreMigrationRow }>)
      .insertInto("settings")
      .values({
        id: "default",
        admin_email: null,
        admin_password_hash: null,
        org_name: null,
        bot_name: null,
        onboarding_completed_at: null,
        smtp_host: "smtp.example.com",
        smtp_port: 587,
        smtp_user: "user@example.com",
        smtp_password: "secret",
        smtp_from: "no-reply@example.com",
      })
      .execute();

    await up(db);

    const rows = await (db as Kysely<{ settings: SettingsRow }>).selectFrom("settings").selectAll().execute();

    expect(rows[0].smtp_secure).toBe(1);
  });

  it("OAuth and Gemini columns default to null on existing rows", async () => {
    type PreMigrationRow = Omit<
      SettingsRow,
      | "created_at"
      | "updated_at"
      | "smtp_secure"
      | "google_oauth_client_id"
      | "google_oauth_client_secret"
      | "gemini_api_key"
    >;
    await (db as Kysely<{ settings: PreMigrationRow }>)
      .insertInto("settings")
      .values({
        id: "default",
        admin_email: null,
        admin_password_hash: null,
        org_name: null,
        bot_name: null,
        onboarding_completed_at: null,
        smtp_host: null,
        smtp_port: null,
        smtp_user: null,
        smtp_password: null,
        smtp_from: null,
      })
      .execute();

    await up(db);

    const rows = await (db as Kysely<{ settings: SettingsRow }>).selectFrom("settings").selectAll().execute();

    expect(rows[0].google_oauth_client_id).toBeNull();
    expect(rows[0].google_oauth_client_secret).toBeNull();
    expect(rows[0].gemini_api_key).toBeNull();
  });

  it("preserves existing SMTP columns that were added by 007", async () => {
    await up(db);

    type InsertRow = Omit<SettingsRow, "created_at" | "updated_at">;
    await (db as Kysely<{ settings: InsertRow }>)
      .insertInto("settings")
      .values({
        id: "default",
        admin_email: null,
        admin_password_hash: null,
        org_name: null,
        bot_name: null,
        onboarding_completed_at: null,
        smtp_host: "mail.example.com",
        smtp_port: 465,
        smtp_user: "sender@example.com",
        smtp_password: "p@ssword",
        smtp_from: "sketch@example.com",
        smtp_secure: 1,
        google_oauth_client_id: null,
        google_oauth_client_secret: null,
        gemini_api_key: null,
      })
      .execute();

    const rows = await (db as Kysely<{ settings: SettingsRow }>).selectFrom("settings").selectAll().execute();

    expect(rows[0].smtp_host).toBe("mail.example.com");
    expect(rows[0].smtp_port).toBe(465);
    expect(rows[0].smtp_user).toBe("sender@example.com");
    expect(rows[0].smtp_from).toBe("sketch@example.com");
  });
});
