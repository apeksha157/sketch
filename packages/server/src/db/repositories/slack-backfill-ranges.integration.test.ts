import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createConversationRepository } from "./conversations";
import { createSlackBackfillRangeRepository } from "./slack-backfill-ranges";

const NOW = "2026-09-11T00:00:00.000Z";

async function seedFetchedRange(
  db: Kysely<DB>,
  input: { channelId: string; kind: "initial" | "gap"; rangeKey: string; lowerTs: string },
): Promise<string> {
  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "slack",
    kind: "channel",
    providerConversationId: input.channelId,
  });
  const ranges = createSlackBackfillRangeRepository(db);
  const { row } = await ranges.ensureRange({
    channelId: input.channelId,
    conversationId: conversation.id,
    kind: input.kind,
    rangeKey: input.rangeKey,
    lowerTs: input.lowerTs,
    upperTs: "1789084800.000000",
  });
  await ranges.setPhase(row.id, "fetched", NOW);
  return row.id;
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>, shared = false): void {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      if (shared) await sql`BEGIN`.execute(db);
    }, 30_000);

    afterEach(async () => {
      if (shared) await sql`ROLLBACK`.execute(db);
      else await db.destroy();
    });

    it("holds back a newer range while an older incomplete range on the same channel exists", async () => {
      const channelId = `C${randomUUID().slice(0, 8)}`;
      const older = await seedFetchedRange(db, {
        channelId,
        kind: "initial",
        rangeKey: "initial",
        lowerTs: "1757548800.000000",
      });
      const newer = await seedFetchedRange(db, {
        channelId,
        kind: "gap",
        rangeKey: "gap-1",
        lowerTs: "1787548800.000000",
      });
      const ranges = createSlackBackfillRangeRepository(db);
      await ranges.touchGraph(older, NOW);

      const first = await ranges.findNextGraphCandidate({ excludedConversationIds: [] });
      expect(first?.id).toEqual(older);

      await ranges.completeGraph(older, NOW);
      const second = await ranges.findNextGraphCandidate({ excludedConversationIds: [] });
      expect(second?.id).toEqual(newer);
    });

    it("serves a never-served range before an already-served one", async () => {
      const servedChannel = `C${randomUUID().slice(0, 8)}`;
      const freshChannel = `C${randomUUID().slice(0, 8)}`;
      const served = await seedFetchedRange(db, {
        channelId: servedChannel,
        kind: "initial",
        rangeKey: "initial",
        lowerTs: "1757548800.000000",
      });
      const fresh = await seedFetchedRange(db, {
        channelId: freshChannel,
        kind: "initial",
        rangeKey: "initial",
        lowerTs: "1757548800.000000",
      });
      const ranges = createSlackBackfillRangeRepository(db);
      await ranges.touchGraph(served, NOW);

      const candidate = await ranges.findNextGraphCandidate({ excludedConversationIds: [] });
      expect(candidate?.id).toEqual(fresh);
    });
  });
}

runSuite("Slack backfill range graph candidate SQLite", createTestDb);
runSuite("Slack backfill range graph candidate Postgres", getSharedPgDb, true);
