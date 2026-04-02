/**
 * Tests for the outreach repository.
 *
 * Uses an in-memory SQLite database with all migrations applied via createTestDb().
 * Requires two users to exist (requester and recipient) before creating outreach rows.
 * Each test uses a fresh database for isolation.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createOutreachRepository } from "./outreach";
import { createUserRepository } from "./users";

let db: Kysely<DB>;
let repo: ReturnType<typeof createOutreachRepository>;
let requesterUserId: string;
let recipientUserId: string;

beforeEach(async () => {
  db = await createTestDb();
  repo = createOutreachRepository(db);

  const userRepo = createUserRepository(db);
  const requester = await userRepo.create({ name: "Rahul" });
  const recipient = await userRepo.create({ name: "Alice" });
  requesterUserId = requester.id;
  recipientUserId = recipient.id;
});

afterEach(async () => {
  await db.destroy();
});

const baseOutreach = () => ({
  requesterUserId,
  recipientUserId,
  message: "What is the current ad spend?",
  taskContext: "Preparing Q1 marketing report",
  platform: "slack" as const,
  channelId: "D_CHANNEL",
  messageRef: "1234567890.123456",
  requesterPlatform: "slack" as const,
  requesterChannel: "D_REQUESTER",
  requesterThreadTs: "9876543210.654321",
});

describe("create()", () => {
  it("inserts a row with status pending, non-null created_at, null response and responded_at", async () => {
    const msg = await repo.create(baseOutreach());

    expect(msg.status).toBe("pending");
    expect(msg.created_at).toBeDefined();
    expect(msg.created_at.length).toBeGreaterThan(0);
    expect(msg.response).toBeNull();
    expect(msg.responded_at).toBeNull();
  });

  it("returns a row with all provided fields correctly mapped", async () => {
    const msg = await repo.create(baseOutreach());

    expect(msg.requester_user_id).toBe(requesterUserId);
    expect(msg.recipient_user_id).toBe(recipientUserId);
    expect(msg.message).toBe("What is the current ad spend?");
    expect(msg.task_context).toBe("Preparing Q1 marketing report");
    expect(msg.platform).toBe("slack");
    expect(msg.channel_id).toBe("D_CHANNEL");
    expect(msg.message_ref).toBe("1234567890.123456");
    expect(msg.requester_platform).toBe("slack");
    expect(msg.requester_channel).toBe("D_REQUESTER");
    expect(msg.requester_thread_ts).toBe("9876543210.654321");
  });

  it("generates a unique UUID for each row", async () => {
    const msg1 = await repo.create(baseOutreach());
    const msg2 = await repo.create(baseOutreach());

    expect(msg1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(msg2.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(msg1.id).not.toBe(msg2.id);
  });

  it("stores optional fields as null when not provided", async () => {
    const msg = await repo.create({
      requesterUserId,
      recipientUserId,
      message: "Minimal outreach",
      platform: "slack",
      requesterPlatform: "slack",
      requesterChannel: "D_REQ",
    });

    expect(msg.task_context).toBeNull();
    expect(msg.channel_id).toBeNull();
    expect(msg.message_ref).toBeNull();
    expect(msg.requester_thread_ts).toBeNull();
  });
});

describe("findPendingForRecipient()", () => {
  it("returns only pending outreach where the user is the recipient, ordered by created_at asc", async () => {
    const userRepo = createUserRepository(db);
    const bob = await userRepo.create({ name: "Bob" });

    const msg1 = await repo.create({ ...baseOutreach(), message: "Question 1" });
    const msg2 = await repo.create({ ...baseOutreach(), message: "Question 2" });
    // Outreach for a different recipient — should not appear
    await repo.create({ ...baseOutreach(), recipientUserId: bob.id, message: "For Bob" });

    // Ensure msg1 has an earlier created_at
    await db
      .updateTable("outreach_messages")
      .set({ created_at: "2026-03-14T08:00:00.000Z" })
      .where("id", "=", msg1.id)
      .execute();
    await db
      .updateTable("outreach_messages")
      .set({ created_at: "2026-03-14T09:00:00.000Z" })
      .where("id", "=", msg2.id)
      .execute();

    const results = await repo.findPendingForRecipient(recipientUserId);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(msg1.id);
    expect(results[1].id).toBe(msg2.id);
    expect(results.every((r) => r.recipient_user_id === recipientUserId)).toBe(true);
    expect(results.every((r) => r.status === "pending")).toBe(true);
  });

  it("excludes responded and expired outreach", async () => {
    const pending = await repo.create(baseOutreach());
    const responded = await repo.create({ ...baseOutreach(), message: "Already answered" });
    const expired = await repo.create({ ...baseOutreach(), message: "Timed out" });

    await db.updateTable("outreach_messages").set({ status: "responded" }).where("id", "=", responded.id).execute();
    await db.updateTable("outreach_messages").set({ status: "expired" }).where("id", "=", expired.id).execute();

    const results = await repo.findPendingForRecipient(recipientUserId);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(pending.id);
  });

  it("returns an empty array when no pending outreach exists for the user", async () => {
    const results = await repo.findPendingForRecipient(recipientUserId);
    expect(results).toEqual([]);
  });
});

describe("findForRequester()", () => {
  it("returns both pending and responded outreach from the requester, ordered by created_at asc", async () => {
    const msg1 = await repo.create(baseOutreach());
    const msg2 = await repo.create({ ...baseOutreach(), message: "Second question" });

    await db
      .updateTable("outreach_messages")
      .set({ created_at: "2026-03-14T08:00:00.000Z" })
      .where("id", "=", msg1.id)
      .execute();
    await db
      .updateTable("outreach_messages")
      .set({ created_at: "2026-03-14T09:00:00.000Z", status: "responded", response: "The answer" })
      .where("id", "=", msg2.id)
      .execute();

    const results = await repo.findForRequester(requesterUserId);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(msg1.id);
    expect(results[1].id).toBe(msg2.id);
  });

  it("excludes expired outreach", async () => {
    const pending = await repo.create(baseOutreach());
    const expired = await repo.create({ ...baseOutreach(), message: "Expired one" });

    await db.updateTable("outreach_messages").set({ status: "expired" }).where("id", "=", expired.id).execute();

    const results = await repo.findForRequester(requesterUserId);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(pending.id);
  });

  it("returns an empty array when no pending or responded outreach exists for the requester", async () => {
    const results = await repo.findForRequester(requesterUserId);
    expect(results).toEqual([]);
  });
});

describe("markResponded()", () => {
  it("updates status to responded, sets response text, and sets responded_at", async () => {
    const msg = await repo.create(baseOutreach());
    const updated = await repo.markResponded(msg.id, "Their ad spend is up 40%");

    expect(updated).toBeDefined();
    expect(updated?.status).toBe("responded");
    expect(updated?.response).toBe("Their ad spend is up 40%");
    expect(updated?.responded_at).toBeDefined();
    expect(updated?.responded_at?.length).toBeGreaterThan(0);
  });

  it("does not update an already-responded row (WHERE status=pending filters it out)", async () => {
    const msg = await repo.create(baseOutreach());
    await repo.markResponded(msg.id, "First response");
    const second = await repo.markResponded(msg.id, "Second response attempt");

    // Row remains with the first response
    expect(second?.response).toBe("First response");
    expect(second?.status).toBe("responded");
  });

  it("returns undefined for a nonexistent id", async () => {
    const result = await repo.markResponded("nonexistent-id", "some response");
    expect(result).toBeUndefined();
  });
});

describe("findById()", () => {
  it("returns the row when it exists", async () => {
    const msg = await repo.create(baseOutreach());
    const found = await repo.findById(msg.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(msg.id);
    expect(found?.message).toBe("What is the current ad spend?");
  });

  it("returns undefined for an unknown id", async () => {
    const result = await repo.findById("nonexistent-id");
    expect(result).toBeUndefined();
  });
});

describe("expireOlderThan()", () => {
  it("marks pending outreach older than the cutoff as expired", async () => {
    const old = await repo.create(baseOutreach());
    const recent = await repo.create({ ...baseOutreach(), message: "Recent question" });

    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.updateTable("outreach_messages").set({ created_at: oldTime }).where("id", "=", old.id).execute();

    await repo.expireOlderThan(24);

    const oldRow = await repo.findById(old.id);
    const recentRow = await repo.findById(recent.id);

    expect(oldRow?.status).toBe("expired");
    expect(recentRow?.status).toBe("pending");
  });

  it("does not affect responded outreach even if it is old", async () => {
    const msg = await repo.create(baseOutreach());
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db
      .updateTable("outreach_messages")
      .set({ created_at: oldTime, status: "responded", response: "Already done" })
      .where("id", "=", msg.id)
      .execute();

    await repo.expireOlderThan(24);

    const row = await repo.findById(msg.id);
    expect(row?.status).toBe("responded");
  });
});
