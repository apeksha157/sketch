/**
 * Cross-dialect coverage for automation run summaries on Postgres (PGlite).
 *
 * The automations list, workflow list and workflow detail requests resolve the
 * newest run per task for every task in the tenant, so the shape of this query
 * decides whether those pages load: a per-row correlated `max()` subquery made
 * the summary quadratic in the busiest task's history (85s per automations-list
 * request on production data) while the grouped join stays flat. This mirrors
 * the SQLite repository tests against Postgres, including a single task with a
 * long run history — run history has no retention cap.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createAutomationRunsRepository } from "./automation-runs";
import { createScheduledTaskRepository } from "./scheduled-tasks";

const LONG_HISTORY_TASK = "pg-runs-task-long";
const SINGLE_RUN_TASK = "pg-runs-task-single";
const EMPTY_TASK = "pg-runs-task-empty";

function run(startedAt: string, status: string, index: number, taskId?: string) {
  return {
    id: `pg-run-${taskId ?? LONG_HISTORY_TASK}-${index}`,
    task_id: taskId ?? LONG_HISTORY_TASK,
    trigger_data: null,
    status,
    step_outputs: "{}",
    error_message: null,
    started_at: startedAt,
    completed_at: status === "running" ? null : startedAt,
    triggered_by_user_id: null,
  };
}

describe("automation run summaries on shared Postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    const tasks = createScheduledTaskRepository(db);
    for (const id of [LONG_HISTORY_TASK, SINGLE_RUN_TASK, EMPTY_TASK]) {
      await tasks.add({
        id,
        platform: "slack",
        context_type: "dm",
        delivery_target: "U123",
        thread_ts: null,
        prompt: "do something",
        schedule_type: "interval",
        schedule_value: "3600",
        timezone: "UTC",
        session_mode: "fresh",
        created_by: "U123",
        status: "active",
        next_run_at: null,
      });
    }
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("returns counts and newest run status per task from a long single-task history", async () => {
    const runs = createAutomationRunsRepository(db);
    const history = Array.from({ length: 900 }, (_, index) =>
      run(new Date(Date.UTC(2026, 3, 10, 0, 0, index)).toISOString(), index === 899 ? "failed" : "completed", index),
    );
    for (let offset = 0; offset < history.length; offset += 300) {
      await db
        .insertInto("automation_runs")
        .values(history.slice(offset, offset + 300))
        .execute();
    }
    await db
      .insertInto("automation_runs")
      .values(run("2026-04-10T09:00:00.000Z", "running", 0, SINGLE_RUN_TASK))
      .execute();

    const result = await runs.getRunSummaries([LONG_HISTORY_TASK, SINGLE_RUN_TASK, EMPTY_TASK]);

    expect(result.get(LONG_HISTORY_TASK)).toEqual({ runCount: 900, lastRunStatus: "failed" });
    expect(result.get(SINGLE_RUN_TASK)).toEqual({ runCount: 1, lastRunStatus: "running" });
    expect(result.has(EMPTY_TASK)).toBe(false);
  });

  it("keeps a last run status when several runs share the newest started_at", async () => {
    const runs = createAutomationRunsRepository(db);
    await db
      .insertInto("automation_runs")
      .values([
        run("2026-04-10T10:00:00.000Z", "completed", 0, SINGLE_RUN_TASK),
        run("2026-04-10T12:00:00.000Z", "running", 1, SINGLE_RUN_TASK),
        run("2026-04-10T12:00:00.000Z", "failed", 2, SINGLE_RUN_TASK),
      ])
      .execute();

    const result = await runs.getRunSummaries([SINGLE_RUN_TASK]);

    expect(result.get(SINGLE_RUN_TASK)?.runCount).toBe(3);
    expect(["failed", "running"]).toContain(result.get(SINGLE_RUN_TASK)?.lastRunStatus);
  });
});
