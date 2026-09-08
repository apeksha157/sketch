import { randomUUID } from "node:crypto";
import { readFile, lstat as stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Cron } from "croner";
import { ensureWorkspace } from "../agent/workspace";
import { type OwnerRequest, exerciseBuilder, ownerJson } from "./builder";
import { BenchmarkBlockedError } from "./clickup";
import { type BenchmarkRun, type CaseResult, type Enrollment, verdictFor } from "./contracts";
import type { RunnerDeps } from "./runner";

export const coreContent: Record<string, string> = {
  core_note: "Time for a break.",
  core_calculation: "20",
  core_checklist: "Review inbox\nPlan next step",
  core_csv: "item,count\nreviews,3",
};

export function isMinuteSchedule(type: string, value: string, timezone: string): boolean {
  if (type === "interval") return value === "60";
  if (type !== "cron") return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length === 6 && fields.shift() !== "0") return false;
  if (fields.length !== 5 || !fields.every((field) => field === "*" || field === "*/1")) return false;
  try {
    const cron = new Cron(value, { paused: true, timezone });
    try {
      return ["2026-01-12T00:00:00Z", "2026-07-19T12:00:00Z"].every((time) => {
        const start = new Date(time);
        const runs = cron.nextRuns(3, start);
        return (
          runs.length === 3 && runs.every((date, index) => date.getTime() - start.getTime() === (index + 1) * 60_000)
        );
      });
    } finally {
      cron.stop();
    }
  } catch {
    return false;
  }
}

export async function executeCoreCase(params: {
  deps: RunnerDeps;
  run: BenchmarkRun;
  item: CaseResult;
  enrollment: Enrollment;
  request: OwnerRequest;
  signal: AbortSignal;
  save: () => Promise<void>;
  createDraft: (id: string, conversationId: string) => Promise<void>;
}) {
  const { deps, run, item, enrollment, request, signal, save } = params;
  const workspace = await ensureWorkspace(deps.config, enrollment.userId);
  const filename = `benchmark-${randomUUID()}.${item.scenario.family === "core_csv" ? "csv" : "txt"}`;
  const file = resolve(workspace, filename);
  const expected = item.scenario.definition?.expectedText ?? coreContent[item.scenario.family];
  if (!expected) throw new BenchmarkBlockedError("This core workflow has no independent verifier.");
  if (await stat(file).catch(() => null))
    throw new BenchmarkBlockedError("A fixture filename unexpectedly already exists.");
  item.resources.push({ kind: "workspace_file", key: "result", id: filename, state: "created" });
  await save();
  item.stage = "building";
  await exerciseBuilder({
    request,
    item,
    model: deps.model,
    manifest: run.model,
    prompt: item.scenario.prompt.replaceAll("{file}", filename).replaceAll("{output}", filename),
    facts: [
      ...(item.scenario.definition?.facts ?? []),
      "Enable it when ready.",
      "Use my normal timezone.",
      "Save the file in my workspace.",
      "Overwrite that same file on each run.",
    ],
    attachments: [],
    signal,
    save,
    createDraft: params.createDraft,
  });
  const taskId = item.automationId;
  if (!taskId) throw new Error("No automation was saved.");
  const task = await deps.db
    .selectFrom("scheduled_tasks")
    .selectAll()
    .where("id", "=", taskId)
    .where("created_by", "=", enrollment.userId)
    .executeTakeFirstOrThrow();
  function check(id: string, label: string, passed: boolean, evidence: string) {
    item.assertions.push({ id, label, status: passed ? "passed" : "failed", evidence });
  }
  const steps: { agentModel?: string }[] = JSON.parse(task.steps ?? "[]");
  check(
    "authoring",
    "Automation saved and enabled with the shared preset",
    task.status === "active" && steps.every((step) => !step.agentModel || step.agentModel === run.model.modelId),
    `Saved automation ${taskId}; status ${task.status}.`,
  );
  check(
    "schedule",
    "The requested one-minute schedule was saved",
    isMinuteSchedule(task.schedule_type, task.schedule_value, task.timezone),
    `Persisted ${task.schedule_type} schedule ${task.schedule_value} in ${task.timezone}. Checked recurrence independently.`,
  );
  if (item.assertions.some((check) => check.status === "failed")) {
    item.verdict = "failed";
    return;
  }
  async function fileMatches() {
    const info = await stat(file).catch(() => null);
    return Boolean(
      info?.isFile() && info.size < 4096 && (await readFile(file, "utf8")).replaceAll("\r\n", "\n").trim() === expected,
    );
  }
  async function scheduledAfter(after: string) {
    const rows = await deps.db
      .selectFrom("automation_runs")
      .selectAll()
      .where("task_id", "=", taskId ?? "")
      .where("started_at", ">", after)
      .where("triggered_by_user_id", "is", null)
      .execute();
    return rows.filter((row) => {
      const trigger = JSON.parse(row.trigger_data ?? "null");
      return row.status === "completed" && typeof trigger?.scheduledAt === "string" && trigger.taskId === taskId;
    });
  }
  async function removeOutput() {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async function awaitTick() {
    const after = new Date().toISOString();
    await removeOutput();
    const deadline = Date.now() + 95_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const rows = await scheduledAfter(after);
      if (rows.length && (await fileMatches())) return rows.map((row) => row.id);
      await delay(2000, undefined, { signal });
    }
    return [];
  }
  item.stage = "exercising";
  await save();
  const runs = await awaitTick();
  check(
    "scheduled_execution",
    "A real schedule tick completes the automation",
    runs.length > 0,
    `Observed ${runs.length} completed scheduled executions within 95 seconds; no manual trigger was used.`,
  );
  check(
    "file_output",
    "The saved file contains the requested result",
    await fileMatches(),
    "Read the actual workspace file, bounded to 4KB, and compared its text with the independent expected value.",
  );
  await ownerJson(request, `/api/scheduled-tasks/${taskId}/pause`, "POST", {});
  if (
    (
      await deps.db
        .selectFrom("automation_runs")
        .select("id")
        .where("task_id", "=", taskId)
        .where("status", "=", "running")
        .execute()
    ).length
  )
    throw new BenchmarkBlockedError("An execution is still running; pause behavior cannot yet be verified.");
  await removeOutput();
  const pausedAt = new Date().toISOString();
  await delay(70_000, undefined, { signal });
  check(
    "paused",
    "Pausing prevents the next scheduled output",
    !(await stat(file).catch(() => null)) &&
      (
        await deps.db
          .selectFrom("automation_runs")
          .select("id")
          .where("task_id", "=", taskId)
          .where("started_at", ">", pausedAt)
          .execute()
      ).length === 0,
    "Observed for 70 seconds while paused, covering the next one-minute tick.",
  );
  await ownerJson(request, `/api/scheduled-tasks/${taskId}/resume`, "POST", {});
  const resumed = await awaitTick();
  check(
    "resumed",
    "Resuming restores scheduled execution",
    resumed.length > 0 && (await fileMatches()),
    `Observed ${resumed.length} new successful scheduled executions after resuming, with the correct file recreated.`,
  );
  item.verdict = verdictFor(item.scenario.definition ? "core_note" : item.scenario.family, item.assertions);
}
