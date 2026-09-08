import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import type { CaseResult } from "./contracts";

export async function captureExecutionEvidence(db: Kysely<DB>, item: CaseResult) {
  if (!item.automationId) return;
  const runs = await db
    .selectFrom("automation_runs")
    .selectAll()
    .where("task_id", "=", item.automationId)
    .orderBy("started_at")
    .limit(30)
    .execute();
  item.executionEvidence = runs.map((run) => {
    const outputs: Record<
      string,
      {
        status?: string;
        duration_ms?: number;
        error?: { message?: string };
        agentTrace?: { stopReason?: string | null; turns?: number | null };
      }
    > = JSON.parse(run.step_outputs ?? "{}");
    return {
      id: run.id,
      status: run.status,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      steps: Object.entries(outputs)
        .slice(0, 100)
        .map(([id, step]) => ({
          id,
          status: step.status ?? "unknown",
          durationMs: step.duration_ms ?? 0,
          ...(step.error
            ? { error: "This execution step failed. Open the automation conversation for its full diagnostic." }
            : {}),
          stopReason: step.agentTrace?.stopReason,
          turns: step.agentTrace?.turns,
        })),
    };
  });
  const failed = item.executionEvidence.flatMap((run) =>
    run.steps.filter((step) => step.status === "failed").map((step) => ({ run, step })),
  );
  if (failed.length && item.verdict !== "passed")
    item.failure ??= {
      phase: "execution",
      category: "product",
      reason: `${failed.length} automation steps failed. First failure: ${failed[0]?.step.id} in execution ${failed[0]?.run.id}.`,
    };
}
