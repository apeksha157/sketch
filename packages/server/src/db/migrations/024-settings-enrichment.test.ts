/**
 * Tests for the 024-settings-enrichment migration.
 *
 * Uses a fresh blank in-memory SQLite database. The settings table is created manually
 * (matching migrations 004 + 007 + 022) before running up(). Tests verify that the
 * enrichment_enabled column is added with a default of 1 (enabled) for existing rows,
 * that the value can be set to 0, and that down() removes the column.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./024-settings-enrichment";

type SettingsRow = {
  id: string;
  org_name: string | null;
  bot_name: string | null;
  created_at: string;
  updated_at: string;
  enrichment_enabled: number;
};

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createSettingsTable(db: Kysely<unknown>): Promise<void> {
  // Matches 004-settings baseline plus enough columns to be realistic
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
}

describe("024-settings-enrichment migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createSettingsTable(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("adds the enrichment_enabled column with default 1 for existing rows", async () => {
    // Insert a row before migration to verify existing rows get the default
    await (
      db as Kysely<{
        settings: { id: string; org_name: string | null; bot_name: string | null };
      }>
    )
      .insertInto("settings")
      .values({ id: "default", org_name: "Acme Corp", bot_name: "Sketch" })
      .execute();

    await up(db);

    const rows = await (db as Kysely<{ settings: SettingsRow }>).selectFrom("settings").selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].enrichment_enabled).toBe(1);
  });

  it("new rows default enrichment_enabled to 1", async () => {
    await up(db);

    await (
      db as Kysely<{
        settings: { id: string; org_name: string | null };
      }>
    )
      .insertInto("settings")
      .values({ id: "default", org_name: null })
      .execute();

    const rows = await (db as Kysely<{ settings: SettingsRow }>).selectFrom("settings").selectAll().execute();

    expect(rows[0].enrichment_enabled).toBe(1);
  });

  it("allows setting enrichment_enabled to 0 (disabled)", async () => {
    await up(db);

    await (db as Kysely<{ settings: { id: string; enrichment_enabled: number } }>)
      .insertInto("settings")
      .values({ id: "default", enrichment_enabled: 0 })
      .execute();

    const rows = await (db as Kysely<{ settings: SettingsRow }>).selectFrom("settings").selectAll().execute();

    expect(rows[0].enrichment_enabled).toBe(0);
  });

  it("down() removes the enrichment_enabled column", async () => {
    await up(db);
    await down(db);

    await (
      db as Kysely<{
        settings: { id: string; org_name: string | null };
      }>
    )
      .insertInto("settings")
      .values({ id: "default", org_name: null })
      .execute();

    const rawDb = db as Kysely<{ settings: Record<string, unknown> }>;
    const rows = await rawDb.selectFrom("settings").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect("enrichment_enabled" in rows[0]).toBe(false);
  });
});
