/**
 * PR 3.1a lifecycle plumbing: the merge-pair identity must be unordered (A→B
 * and B→A are one proposal, A→C is a different one), the new machine states
 * must hold and release uniqueness slots correctly, and the widened decision
 * gates must accept exactly the statuses the adjudicator doctrine allows —
 * a veto_window row confirms, a pending_corroboration row can only be killed.
 */
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphVerdictApplyError, applyGraphVerdict } from "../../entities/verdict-apply";
import { createTestDb } from "../../test-utils";
import { createMigrator } from "../migrate";
import type { DB } from "../schema";
import { createGraphVerdictRepository, mergePairKey } from "./graph-verdicts";

const USER_ID = "lifecycle-user";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Lifecycle User" }).execute();
}

async function seedRun(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("graph_verdict_runs")
    .values({
      id,
      source: "test",
      proposed_by_user_id: USER_ID,
      token_id: null,
      note: null,
      verdicts_proposed: 1,
      verdicts_stored: 0,
      verdicts_bounced: 0,
    })
    .execute();
}

function mergeRow(input: {
  id: string;
  runId: string;
  subject: string;
  target: string;
  status: string;
  createdAt?: string;
}) {
  return {
    id: input.id,
    run_id: input.runId,
    action: "merge_into",
    subject_entity_id: input.subject,
    subject_container_id: null,
    subject_mention_name: null,
    subject_name: input.subject,
    subject_entity_type: "company",
    target_entity_id: input.target,
    resolved_target_entity_id: input.target,
    target_name: input.target,
    reason: "test merge",
    evidence_json: "{}",
    evidence_fingerprint: `fp-${input.id}`,
    validation_status: "ok",
    validation_reason: null,
    would_change_json: null,
    status: input.status,
    superseded_at: null,
    decided_at: null,
    decided_by_user_id: null,
    applied_ledger_ref: null,
    created_at: input.createdAt ?? "2026-09-01T00:00:00.000Z",
    updated_at: input.createdAt ?? "2026-09-01T00:00:00.000Z",
  };
}

async function insertMerge(
  db: Kysely<DB>,
  input: { id: string; runId: string; subject: string; target: string; status: string },
): Promise<void> {
  await db
    .insertInto("graph_verdicts")
    .values({
      ...mergeRow(input),
      veto_until: null,
      corroboration_json: null,
      retired_reason: null,
      dry_streak: 0,
      merge_pair_key: mergePairKey(input.subject, input.target),
    })
    .execute();
}

describe("graph verdict lifecycle (3.1a)", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
    await seedRun(db, "run-1");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("keys active merges by unordered pair: B→A collides with A→B, A→C coexists, retired frees the slot", async () => {
    await insertMerge(db, { id: "gv-ab", runId: "run-1", subject: "ent-a", target: "ent-b", status: "awaiting_human" });

    await expect(
      insertMerge(db, { id: "gv-ba", runId: "run-1", subject: "ent-b", target: "ent-a", status: "awaiting_human" }),
    ).rejects.toThrow(/unique/i);

    await insertMerge(db, {
      id: "gv-ac",
      runId: "run-1",
      subject: "ent-a",
      target: "ent-c",
      status: "pending_corroboration",
    });

    await expect(
      insertMerge(db, { id: "gv-ca", runId: "run-1", subject: "ent-c", target: "ent-a", status: "veto_window" }),
    ).rejects.toThrow(/unique/i);

    await db
      .updateTable("graph_verdicts")
      .set({ status: "retired", retired_reason: "dry_streak" })
      .where("id", "=", "gv-ab")
      .execute();
    await insertMerge(db, { id: "gv-ba-2", runId: "run-1", subject: "ent-b", target: "ent-a", status: "veto_window" });
  });

  it("gates decisions by status: veto_window confirms, pending_corroboration only rejects, neither applies", async () => {
    const repo = createGraphVerdictRepository(db);
    await insertMerge(db, { id: "gv-veto", runId: "run-1", subject: "ent-a", target: "ent-b", status: "veto_window" });
    await insertMerge(db, {
      id: "gv-pending",
      runId: "run-1",
      subject: "ent-c",
      target: "ent-d",
      status: "pending_corroboration",
    });

    await expect(applyGraphVerdict(db, { verdictId: "gv-veto", actorUserId: USER_ID })).rejects.toThrow(
      GraphVerdictApplyError,
    );

    expect(await repo.markApproved({ id: "gv-pending", actorUserId: USER_ID })).toBe(false);
    expect(await repo.markApproved({ id: "gv-veto", actorUserId: USER_ID })).toBe(true);
    expect(await repo.markRejected({ id: "gv-pending", actorUserId: USER_ID })).toBe(true);

    const rows = await db.selectFrom("graph_verdicts").select(["id", "status"]).execute();
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    expect(byId.get("gv-veto")).toBe("approved");
    expect(byId.get("gv-pending")).toBe("rejected");
  });

  it("migration 223 backfills pair keys and supersedes the older of an opposite-direction active pair", async () => {
    const raw = new Kysely<DB>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    try {
      const migrator = createMigrator(raw);
      const upTo = await migrator.migrateTo("222-webhook-verification");
      expect(upTo.error).toBeUndefined();
      await seedUser(raw);
      await seedRun(raw, "run-1");
      await raw
        .insertInto("graph_verdicts")
        .values([
          mergeRow({
            id: "gv-old",
            runId: "run-1",
            subject: "ent-a",
            target: "ent-b",
            status: "awaiting_human",
            createdAt: "2026-09-01T00:00:00.000Z",
          }),
          mergeRow({
            id: "gv-new",
            runId: "run-1",
            subject: "ent-b",
            target: "ent-a",
            status: "awaiting_human",
            createdAt: "2026-09-02T00:00:00.000Z",
          }),
        ] as never)
        .execute();

      const rest = await migrator.migrateTo("223-verdict-lifecycle");
      expect(rest.error).toBeUndefined();

      const rows = await sql<{
        id: string;
        merge_pair_key: string | null;
        superseded_at: string | null;
      }>`SELECT id, merge_pair_key, superseded_at FROM graph_verdicts ORDER BY id`.execute(raw);
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      expect(byId.get("gv-old")?.merge_pair_key).toBe("ent-a|ent-b");
      expect(byId.get("gv-new")?.merge_pair_key).toBe("ent-a|ent-b");
      expect(byId.get("gv-old")?.superseded_at).not.toBeNull();
      expect(byId.get("gv-new")?.superseded_at).toBeNull();
    } finally {
      await raw.destroy();
    }
  });
});
