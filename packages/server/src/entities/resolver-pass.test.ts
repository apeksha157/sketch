/**
 * 3.1c: the daily resolver pass. Three failure modes — a second claim of the
 * same day's run must not double-own it (unique run_key + stale-lease
 * takeover), an approved verdict whose subject drifted since proposal must
 * bounce to human re-adjudication instead of applying blind, and the
 * auto-approve gate must respect both the pass-freshness window and the
 * configured kind list.
 */
import type { Kysely } from "kysely";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAlias } from "../db/repositories/entity-alias-rows";
import { createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB } from "../db/schema";
import { handleProposeGraphVerdicts } from "../mcp/curation/propose-graph-verdicts";
import { createTestDb } from "../test-utils";
import { approveGatedKinds, createResolverPassService, runExecutorLeg } from "./resolver-pass";

const HUMAN_ID = "resolver-pass-human";
const EPOCH = "1970-01-01T00:00:00.000Z";
const logger = pino({ level: "silent" });

async function seedEntity(db: Kysely<DB>, id: string, name: string, aliases: string[] = []): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "person",
      aliases: aliases.length > 0 ? JSON.stringify(aliases) : null,
      status: "confirmed",
      hotness: 0,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    })
    .execute();
}

async function proposeRemoveAlias(
  db: Kysely<DB>,
  input: { userId: string; subjectEntityId: string; targetName: string },
): Promise<string> {
  const result = await handleProposeGraphVerdicts(
    {
      verdicts: [
        {
          action: "remove_alias",
          subjectEntityId: input.subjectEntityId,
          targetName: input.targetName,
          reason: "resolver pass test removal",
        },
      ],
    },
    db,
    { userId: input.userId, tokenId: "resolver-pass-test" },
  );
  const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { results?: Array<{ verdictId?: string }> };
  const verdictId = parsed.results?.[0]?.verdictId;
  if (!verdictId) throw new Error("proposal did not store a verdict");
  return verdictId;
}

describe("resolver pass (3.1c)", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insertInto("users").values({ id: HUMAN_ID, name: "Resolver Pass Human" }).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("takes over a stale-leased run for the day, completes it once, and no-ops the second call", async () => {
    const service = createResolverPassService({ db, logger });
    const staleHeartbeat = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const runKey = `resolver:${new Date().toISOString().slice(0, 10)}`;
    await db
      .insertInto("resolver_runs")
      .values({
        id: "stale-run",
        run_key: runKey,
        status: "running",
        lease_token: "dead-process",
        heartbeat_at: staleHeartbeat,
      })
      .execute();

    const first = await service.runOnce();
    expect(first.status).toBe("completed");
    expect(first.runKey).toBe(runKey);

    const rows = await db.selectFrom("resolver_runs").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("stale-run");
    expect(rows[0]?.lease_token).not.toBe("dead-process");
    expect(rows[0]?.summary_json).not.toBeNull();

    const second = await service.runOnce();
    expect(second.status).toBe("completed");
    await expect(
      db.selectFrom("resolver_runs").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
  });

  it("applies healthy approved verdicts and bounces drifted ones back to awaiting_human", async () => {
    await seedEntity(db, "healthy-subject", "Healthy Subject", ["Healthy Junk"]);
    await seedEntity(db, "drifted-subject", "Drifted Subject", ["Drifted Junk"]);
    const healthyId = await proposeRemoveAlias(db, {
      userId: HUMAN_ID,
      subjectEntityId: "healthy-subject",
      targetName: "Healthy Junk",
    });
    const driftedId = await proposeRemoveAlias(db, {
      userId: HUMAN_ID,
      subjectEntityId: "drifted-subject",
      targetName: "Drifted Junk",
    });
    const repo = createGraphVerdictRepository(db);
    expect(await repo.markApproved({ id: healthyId, actorUserId: HUMAN_ID })).toBe(true);
    expect(await repo.markApproved({ id: driftedId, actorUserId: HUMAN_ID })).toBe(true);
    await db.updateTable("entities").set({ name: "Renamed Subject" }).where("id", "=", "drifted-subject").execute();

    const executor = await runExecutorLeg(db, logger);
    expect(executor).toEqual({ applied: 1, bouncedDrift: 1, failed: 0 });
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", healthyId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "applied" });
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", driftedId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "awaiting_human" });
    await expect(
      db.selectFrom("entities").select("aliases").where("id", "=", "drifted-subject").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ aliases: JSON.stringify(["Drifted Junk"]) });
  });

  it("auto-approves only machine verdicts of gated kinds inside the freshness window", async () => {
    await seedEntity(db, "gated-subject", "Gated Subject", ["Gated Junk"]);
    await recordAlias(db, {
      entityId: "gated-subject",
      alias: "Gated Junk",
      provenance: "mint_model",
      createdBy: "mint_model-writer",
    });
    const machineVerdictId = await proposeRemoveAlias(db, {
      userId: MACHINE_PRINCIPAL_USER_ID,
      subjectEntityId: "gated-subject",
      targetName: "Gated Junk",
    });

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await expect(approveGatedKinds(db, { kinds: ["remove_alias"], since: future })).resolves.toEqual({ approved: [] });
    await expect(approveGatedKinds(db, { kinds: ["link_to", "dismiss"], since: EPOCH })).resolves.toEqual({
      approved: [],
    });
    await expect(approveGatedKinds(db, { kinds: ["remove_alias"], since: EPOCH })).resolves.toEqual({
      approved: [machineVerdictId],
    });
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", machineVerdictId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "approved" });
  });
});
