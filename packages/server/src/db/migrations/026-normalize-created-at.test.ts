import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up as up025 } from "./025-agent-usage";
import { up as up026 } from "./026-normalize-created-at";

type AgentRunRow = { id: string; created_at: string };
type InsertAgentRun = { id: string; trace_id: string; platform: string; context_type: string; created_at?: string };

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("026-normalize-created-at migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await up025(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("converts CURRENT_TIMESTAMP format to ISO 8601", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values([
        { id: "r1", trace_id: "t1", platform: "slack", context_type: "dm", created_at: "2026-03-30 10:15:23" },
        { id: "r2", trace_id: "t2", platform: "slack", context_type: "dm", created_at: "2026-03-30 14:30:00" },
      ])
      .execute();

    await up026(db);

    const rows = await (db as Kysely<{ agent_runs: AgentRunRow }>)
      .selectFrom("agent_runs")
      .select(["id", "created_at"])
      .orderBy("id")
      .execute();

    expect(rows[0].created_at).toBe("2026-03-30T10:15:23.000Z");
    expect(rows[1].created_at).toBe("2026-03-30T14:30:00.000Z");
  });

  it("leaves existing ISO format rows unchanged", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({
        id: "r3",
        trace_id: "t3",
        platform: "slack",
        context_type: "dm",
        created_at: "2026-03-10T10:00:00.000Z",
      })
      .execute();

    await up026(db);

    const rows = await (db as Kysely<{ agent_runs: AgentRunRow }>)
      .selectFrom("agent_runs")
      .select(["id", "created_at"])
      .execute();

    expect(rows[0].created_at).toBe("2026-03-10T10:00:00.000Z");
  });

  it("handles mixed formats in the same table", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values([
        { id: "r4", trace_id: "t4", platform: "slack", context_type: "dm", created_at: "2026-03-30 10:15:23" },
        { id: "r5", trace_id: "t5", platform: "slack", context_type: "dm", created_at: "2026-03-10T10:00:00.000Z" },
      ])
      .execute();

    await up026(db);

    const rows = await (db as Kysely<{ agent_runs: AgentRunRow }>)
      .selectFrom("agent_runs")
      .select(["id", "created_at"])
      .orderBy("id")
      .execute();

    expect(rows[0].created_at).toBe("2026-03-30T10:15:23.000Z");
    expect(rows[1].created_at).toBe("2026-03-10T10:00:00.000Z");
  });

  it("normalized timestamps compare correctly with ISO period bounds", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({
        id: "r6",
        trace_id: "t6",
        platform: "slack",
        context_type: "dm",
        created_at: "2026-03-30 10:15:23",
      })
      .execute();

    await up026(db);

    // Weekly period [2026-03-30T00:00:00.000Z, 2026-04-06T00:00:00.000Z)
    const result = await sql<{ count: number }>`
      SELECT COUNT(*) as count FROM agent_runs
      WHERE created_at >= '2026-03-30T00:00:00.000Z'
        AND created_at < '2026-04-06T00:00:00.000Z'
    `.execute(db);

    expect(result.rows[0].count).toBe(1);
  });
});
