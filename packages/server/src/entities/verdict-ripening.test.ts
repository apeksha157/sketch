/**
 * §6 ripening: a re-proposal of a waiting merge pair must corroborate the
 * existing verdict (same row, frozen fingerprint) instead of superseding it,
 * machine merges must enter the lifecycle by signal count while human
 * proposals stay in the human queue, and the append/aging paths must be
 * idempotent — replayed evidence adds nothing, quiet rows retire and revive
 * only on genuinely new evidence.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type StoreGraphVerdictInput,
  createGraphVerdictRepository,
  parseCorroboration,
} from "../db/repositories/graph-verdicts";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { agePendingVerdicts, corroborateVerdictsFromFiles } from "./verdict-ripening";

const HUMAN_ID = "ripening-human";

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: HUMAN_ID, name: "Ripening Human" }).execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "ripening-connector",
      connector_type: "slack",
      auth_type: "api_key",
      credentials: "{}",
      created_by: HUMAN_ID,
    })
    .execute();
}

async function seedRun(db: Kysely<DB>, id: string, userId: string): Promise<void> {
  await db
    .insertInto("graph_verdict_runs")
    .values({
      id,
      source: "test",
      proposed_by_user_id: userId,
      token_id: null,
      note: null,
      verdicts_proposed: 1,
      verdicts_stored: 0,
      verdicts_bounced: 0,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string, source: string, threadId: string | null): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "ripening-connector",
      provider_file_id: id,
      file_name: `${id}.txt`,
      content_category: "document",
      source,
      thread_id: threadId,
      synced_at: "2026-09-01T00:00:00.000Z",
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name: id,
      source_type: "company",
      aliases: "[]",
      status: "confirmed",
      hotness: 0,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    })
    .execute();
}

function mergeInput(runId: string, subject: string, target: string, fileIds: string[]): StoreGraphVerdictInput {
  return {
    runId,
    action: "merge_into",
    subjectEntityId: subject,
    subjectName: subject,
    subjectEntityType: "company",
    targetEntityId: target,
    resolvedTargetEntityId: target,
    targetName: target,
    reason: "test merge",
    evidenceJson: JSON.stringify({ fileIds, reviewIds: [], notes: [] }),
    evidenceFingerprint: `fp-${subject}-${target}-${fileIds.join(",")}`,
    validationStatus: "ok",
    validationReason: null,
    wouldChangeJson: null,
    status: "awaiting_human",
  };
}

describe("verdict ripening (3.1b)", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
    await seedFile(db, "f-slack-1", "slack", "th-slack");
    await seedFile(db, "f-slack-2", "slack", "th-slack");
    await seedFile(db, "f-gmail-1", "gmail", "th-mail");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("machine re-proposal of a waiting pair corroborates the existing row and ripens on an independent cluster", async () => {
    const repo = createGraphVerdictRepository(db);
    await seedRun(db, "run-m1", MACHINE_PRINCIPAL_USER_ID);
    const first = await repo.storeVerdicts([mergeInput("run-m1", "ent-a", "ent-b", ["f-slack-1"])]);
    expect(first.dispositions).toEqual(["inserted"]);
    expect(first.rows[0]?.status).toBe("pending_corroboration");

    await seedRun(db, "run-m2", MACHINE_PRINCIPAL_USER_ID);
    const sameCluster = await repo.storeVerdicts([mergeInput("run-m2", "ent-b", "ent-a", ["f-slack-2"])]);
    expect(sameCluster.dispositions).toEqual(["corroborated"]);
    expect(sameCluster.ids[0]).toBe(first.ids[0]);

    await seedRun(db, "run-m3", MACHINE_PRINCIPAL_USER_ID);
    const independent = await repo.storeVerdicts([mergeInput("run-m3", "ent-a", "ent-b", ["f-gmail-1"])]);
    expect(independent.dispositions).toEqual(["ripened"]);
    expect(independent.ids[0]).toBe(first.ids[0]);

    const rows = await db.selectFrom("graph_verdicts").selectAll().where("action", "=", "merge_into").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("veto_window");
    expect(rows[0]?.veto_until).not.toBeNull();
    expect(rows[0]?.evidence_fingerprint).toBe("fp-ent-a-ent-b-f-slack-1");
    const entries = parseCorroboration(rows[0]?.corroboration_json ?? null);
    expect(entries.map((entry) => entry.fileId).sort()).toEqual(["f-gmail-1", "f-slack-2"]);
    expect(entries.every((entry) => entry.supportsEntityId === "ent-b" || entry.supportsEntityId === "ent-a")).toBe(
      true,
    );
  });

  it("files by proposer and signal count, bounces a retired pair without new evidence, revives it with some", async () => {
    const repo = createGraphVerdictRepository(db);
    await seedRun(db, "run-h1", HUMAN_ID);
    const human = await repo.storeVerdicts([mergeInput("run-h1", "ent-c", "ent-d", ["f-slack-1"])]);
    expect(human.rows[0]?.status).toBe("awaiting_human");

    await seedRun(db, "run-m4", MACHINE_PRINCIPAL_USER_ID);
    const twoSignals = await repo.storeVerdicts([mergeInput("run-m4", "ent-e", "ent-f", ["f-slack-1", "f-gmail-1"])]);
    expect(twoSignals.rows[0]?.status).toBe("veto_window");

    await db
      .updateTable("graph_verdicts")
      .set({ status: "retired", retired_reason: "dry_streak" })
      .where("id", "=", twoSignals.ids[0] ?? "")
      .execute();

    await seedRun(db, "run-m5", MACHINE_PRINCIPAL_USER_ID);
    const stale = await repo.storeVerdicts([mergeInput("run-m5", "ent-e", "ent-f", ["f-slack-1"])]);
    expect(stale.dispositions).toEqual(["bounced"]);
    expect(stale.rows[0]?.validationReason).toBe("retired_no_new_evidence");

    await seedRun(db, "run-m6", MACHINE_PRINCIPAL_USER_ID);
    const revived = await repo.storeVerdicts([mergeInput("run-m6", "ent-f", "ent-e", ["f-slack-2"])]);
    expect(revived.dispositions).toEqual(["revived"]);
    expect(revived.ids[0]).toBe(twoSignals.ids[0]);
    const row = await db
      .selectFrom("graph_verdicts")
      .selectAll()
      .where("id", "=", twoSignals.ids[0] ?? "")
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending_corroboration");
    expect(row.retired_reason).toBeNull();
    expect(row.dry_streak).toBe(0);
  });

  it("post-sync co-occurrence appends idempotently and quiet rows age to retirement while fresh ones are spared", async () => {
    const repo = createGraphVerdictRepository(db);
    await seedEntity(db, "ent-a");
    await seedEntity(db, "ent-b");
    await seedRun(db, "run-m7", MACHINE_PRINCIPAL_USER_ID);
    const stored = await repo.storeVerdicts([mergeInput("run-m7", "ent-a", "ent-b", ["f-slack-1"])]);
    await seedRun(db, "run-m8", MACHINE_PRINCIPAL_USER_ID);
    await repo.storeVerdicts([mergeInput("run-m8", "ent-x", "ent-y", ["f-slack-1"])]);

    await seedFile(db, "f-wa-1", "whatsapp", "th-wa");
    for (const [id, entityId] of [
      ["m-1", "ent-a"],
      ["m-2", "ent-b"],
    ] as const) {
      await db
        .insertInto("entity_mentions")
        .values({
          id,
          entity_id: entityId,
          indexed_file_id: "f-wa-1",
          source: "llm_extraction",
          relation: "mentioned",
          confidence: "INFERRED",
          mentioned_at: "2026-09-01T00:00:00.000Z",
        })
        .execute();
    }

    const first = await corroborateVerdictsFromFiles(db, ["f-wa-1"]);
    expect(first.appended).toBe(1);
    expect(first.ripened).toBe(1);
    const replay = await corroborateVerdictsFromFiles(db, ["f-wa-1"]);
    expect(replay.appended).toBe(0);
    expect(replay.ripened).toBe(0);

    const ripenedRow = await db
      .selectFrom("graph_verdicts")
      .select(["status"])
      .where("id", "=", stored.ids[0] ?? "")
      .executeTakeFirstOrThrow();
    expect(ripenedRow.status).toBe("veto_window");

    for (let pass = 0; pass < 3; pass += 1) {
      await agePendingVerdicts(db, { since: "2099-01-01T00:00:00.000Z" });
    }
    const aged = await db
      .selectFrom("graph_verdicts")
      .select(["subject_entity_id", "status", "dry_streak", "retired_reason"])
      .where("subject_entity_id", "=", "ent-x")
      .executeTakeFirstOrThrow();
    expect(aged.status).toBe("retired");
    expect(aged.retired_reason).toBe("dry_streak");
    expect(aged.dry_streak).toBe(3);

    await seedRun(db, "run-m9", MACHINE_PRINCIPAL_USER_ID);
    await repo.storeVerdicts([mergeInput("run-m9", "ent-p", "ent-q", ["f-slack-1"])]);
    await seedRun(db, "run-m10", MACHINE_PRINCIPAL_USER_ID);
    await repo.storeVerdicts([mergeInput("run-m10", "ent-q", "ent-p", ["f-slack-2"])]);
    const spared = await agePendingVerdicts(db, { since: "2000-01-01T00:00:00.000Z" });
    expect(spared.skippedFresh).toBe(1);
    expect(spared.bumped).toBe(0);
  });
});
