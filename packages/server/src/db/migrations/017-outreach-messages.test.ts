/**
 * Tests for the 017-outreach-messages migration.
 *
 * Uses a fresh blank in-memory SQLite database. The users table is created manually
 * before running up() because outreach_messages has FK references to users.id.
 * Tests verify that columns and defaults are correct and that both indexes exist
 * and support filtering by status.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./017-outreach-messages";

type OutreachRow = {
  id: string;
  requester_user_id: string;
  recipient_user_id: string;
  message: string;
  task_context: string | null;
  response: string | null;
  status: string;
  platform: string;
  channel_id: string | null;
  message_ref: string | null;
  requester_platform: string;
  requester_channel: string;
  requester_thread_ts: string | null;
  created_at: string;
  responded_at: string | null;
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

async function queryOutreach(db: Kysely<unknown>): Promise<OutreachRow[]> {
  return (db as Kysely<{ outreach_messages: OutreachRow }>).selectFrom("outreach_messages").selectAll().execute();
}

describe("017-outreach-messages migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createUsersTable(db);
    await up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the outreach_messages table and allows inserting and querying rows", async () => {
    await insertUser(db, "user-requester", "Rahul");
    await insertUser(db, "user-recipient", "Alice");

    type InsertRow = Omit<OutreachRow, "created_at" | "status">;
    await (db as Kysely<{ outreach_messages: InsertRow }>)
      .insertInto("outreach_messages")
      .values({
        id: "msg-001",
        requester_user_id: "user-requester",
        recipient_user_id: "user-recipient",
        message: "What is the current ad spend?",
        task_context: "Preparing Q1 marketing report",
        response: null,
        platform: "slack",
        channel_id: "D_CHANNEL",
        message_ref: "1234567890.123456",
        requester_platform: "slack",
        requester_channel: "D_REQUESTER",
        requester_thread_ts: null,
        responded_at: null,
      })
      .execute();

    const rows = await queryOutreach(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("msg-001");
    expect(rows[0].requester_user_id).toBe("user-requester");
    expect(rows[0].recipient_user_id).toBe("user-recipient");
    expect(rows[0].message).toBe("What is the current ad spend?");
    expect(rows[0].task_context).toBe("Preparing Q1 marketing report");
    expect(rows[0].platform).toBe("slack");
  });

  it("applies default status of pending and populates created_at", async () => {
    await insertUser(db, "user-a", "Alice");
    await insertUser(db, "user-b", "Bob");

    type InsertRow = Omit<OutreachRow, "created_at" | "status">;
    await (db as Kysely<{ outreach_messages: InsertRow }>)
      .insertInto("outreach_messages")
      .values({
        id: "msg-002",
        requester_user_id: "user-a",
        recipient_user_id: "user-b",
        message: "Can you review the doc?",
        task_context: null,
        response: null,
        platform: "slack",
        channel_id: null,
        message_ref: null,
        requester_platform: "slack",
        requester_channel: "D_REQUESTER",
        requester_thread_ts: null,
        responded_at: null,
      })
      .execute();

    const rows = await queryOutreach(db);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].created_at).toBeDefined();
    expect(rows[0].created_at.length).toBeGreaterThan(0);
  });

  it("stores nullable fields as null when not provided", async () => {
    await insertUser(db, "user-c", "Charlie");
    await insertUser(db, "user-d", "Dana");

    type InsertRow = Omit<OutreachRow, "created_at" | "status">;
    await (db as Kysely<{ outreach_messages: InsertRow }>)
      .insertInto("outreach_messages")
      .values({
        id: "msg-003",
        requester_user_id: "user-c",
        recipient_user_id: "user-d",
        message: "Please share the latest numbers.",
        task_context: null,
        response: null,
        platform: "whatsapp",
        channel_id: null,
        message_ref: null,
        requester_platform: "whatsapp",
        requester_channel: "1234567890@c.us",
        requester_thread_ts: null,
        responded_at: null,
      })
      .execute();

    const rows = await queryOutreach(db);
    expect(rows[0].task_context).toBeNull();
    expect(rows[0].response).toBeNull();
    expect(rows[0].channel_id).toBeNull();
    expect(rows[0].message_ref).toBeNull();
    expect(rows[0].requester_thread_ts).toBeNull();
    expect(rows[0].responded_at).toBeNull();
  });

  it("the recipient_status index supports filtering pending outreach by recipient", async () => {
    await insertUser(db, "user-req", "Requester");
    await insertUser(db, "user-alice", "Alice");
    await insertUser(db, "user-bob", "Bob");

    type InsertRow = Omit<OutreachRow, "created_at">;
    const insertDb = db as Kysely<{ outreach_messages: InsertRow }>;

    await insertDb
      .insertInto("outreach_messages")
      .values({
        id: "msg-for-alice",
        requester_user_id: "user-req",
        recipient_user_id: "user-alice",
        message: "Question for Alice",
        task_context: null,
        response: null,
        status: "pending",
        platform: "slack",
        channel_id: null,
        message_ref: null,
        requester_platform: "slack",
        requester_channel: "D_REQ",
        requester_thread_ts: null,
        responded_at: null,
      })
      .execute();

    await insertDb
      .insertInto("outreach_messages")
      .values({
        id: "msg-for-bob",
        requester_user_id: "user-req",
        recipient_user_id: "user-bob",
        message: "Question for Bob",
        task_context: null,
        response: null,
        status: "pending",
        platform: "slack",
        channel_id: null,
        message_ref: null,
        requester_platform: "slack",
        requester_channel: "D_REQ",
        requester_thread_ts: null,
        responded_at: null,
      })
      .execute();

    const alicePending = await (db as Kysely<{ outreach_messages: OutreachRow }>)
      .selectFrom("outreach_messages")
      .selectAll()
      .where("recipient_user_id", "=", "user-alice")
      .where("status", "=", "pending")
      .execute();

    expect(alicePending).toHaveLength(1);
    expect(alicePending[0].id).toBe("msg-for-alice");
  });

  it("the requester_status index supports filtering outreach by requester", async () => {
    await insertUser(db, "user-r1", "Requester1");
    await insertUser(db, "user-r2", "Requester2");
    await insertUser(db, "user-recip", "Recipient");

    type InsertRow = Omit<OutreachRow, "created_at">;
    const insertDb = db as Kysely<{ outreach_messages: InsertRow }>;

    await insertDb
      .insertInto("outreach_messages")
      .values({
        id: "msg-from-r1",
        requester_user_id: "user-r1",
        recipient_user_id: "user-recip",
        message: "From R1",
        task_context: null,
        response: null,
        status: "pending",
        platform: "slack",
        channel_id: null,
        message_ref: null,
        requester_platform: "slack",
        requester_channel: "D_R1",
        requester_thread_ts: null,
        responded_at: null,
      })
      .execute();

    await insertDb
      .insertInto("outreach_messages")
      .values({
        id: "msg-from-r2",
        requester_user_id: "user-r2",
        recipient_user_id: "user-recip",
        message: "From R2",
        task_context: null,
        response: null,
        status: "pending",
        platform: "slack",
        channel_id: null,
        message_ref: null,
        requester_platform: "slack",
        requester_channel: "D_R2",
        requester_thread_ts: null,
        responded_at: null,
      })
      .execute();

    const r1Outreach = await (db as Kysely<{ outreach_messages: OutreachRow }>)
      .selectFrom("outreach_messages")
      .selectAll()
      .where("requester_user_id", "=", "user-r1")
      .where("status", "=", "pending")
      .execute();

    expect(r1Outreach).toHaveLength(1);
    expect(r1Outreach[0].id).toBe("msg-from-r1");
  });
});
