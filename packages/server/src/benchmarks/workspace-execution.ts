import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ensureWorkspace } from "../agent/workspace";
import { type OwnerRequest, exerciseBuilder, exerciseDirectChat, ownerJson } from "./builder";
import { userRequest } from "./cases";
import { BenchmarkBlockedError } from "./clickup";
import type { BenchmarkRun, CaseResult, Enrollment, Resource } from "./contracts";
import { isMinuteSchedule } from "./core";
import { type ProviderItem, type ProviderProbe, createProviderProbe } from "./provider";
import type { RunnerDeps } from "./runner";

export function reportMatches(text: string, expected: ProviderItem[], candidates: ProviderItem[] = expected): boolean {
  try {
    const report = z
      .object({ count: z.number().int().nonnegative(), ids: z.array(z.union([z.string(), z.number()])).max(1000) })
      .strict()
      .parse(
        JSON.parse(
          text
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, ""),
        ),
      );
    const ids = report.ids.map(String);
    if (
      report.count === expected.length &&
      ids.length === expected.length &&
      new Set(ids).size === ids.length &&
      ids.sort().join("\n") ===
        expected
          .map((item) => item.id)
          .sort()
          .join("\n")
    )
      return true;
  } catch {}
  const answer = text.normalize("NFKC").toLocaleLowerCase();
  const expectedIds = new Set(expected.map((item) => item.id));
  const includes = (title: string) => answer.includes(title.normalize("NFKC").toLocaleLowerCase());
  return (
    expected.length > 0 &&
    expected.every((item) => includes(item.title)) &&
    candidates.filter((item) => !expectedIds.has(item.id)).every((item) => !includes(item.title))
  );
}

export function unchanged(before: ProviderItem[], after: ProviderItem[]): boolean {
  return (
    before.length === after.length &&
    before.every((item) =>
      after.some(
        (entry) =>
          entry.id === item.id && entry.title === item.title && entry.body === item.body && entry.state === item.state,
      ),
    )
  );
}

export function isBenchmarkWorkspaceOutput(value: string): boolean {
  return /^(?:benchmark-[a-f0-9-]+\.(?:txt|csv)|open-items-[a-f0-9]{8}\.txt)$/.test(value);
}

function assertion(item: CaseResult, id: string, label: string, passed: boolean, evidence: string) {
  item.assertions.push({ id, label, status: passed ? "passed" : "failed", evidence });
}

export async function executeWorkspaceCase(params: {
  deps: RunnerDeps;
  run: BenchmarkRun;
  item: CaseResult;
  enrollment: Enrollment;
  request: OwnerRequest;
  signal: AbortSignal;
  save: () => Promise<void>;
  guard: () => Promise<void>;
  createDraft: (id: string, conversationId: string) => Promise<void>;
}) {
  const { deps, item, run, enrollment, request, signal, save, guard } = params;
  const definition = item.scenario.definition;
  if (!definition || definition.integration === "none" || !enrollment.target)
    throw new BenchmarkBlockedError("The case needs a configured integration test area.");
  const provider = await deps.provider();
  if (!provider) throw new BenchmarkBlockedError("The integration is unavailable.");
  const probe = (deps.providerProbe ?? createProviderProbe)({
    integration: definition.integration,
    provider,
    userId: enrollment.userId,
    email: enrollment.email,
    accountId: enrollment.accountId,
    signal,
    guard,
  });
  const marker = `Sketch sample ${randomUUID().slice(0, 8)}`;
  let target = enrollment.target;
  if (definition.integration === "clickup") {
    const resource: Resource = {
      kind: "list",
      key: "case-area",
      id: null,
      state: "intent",
      name: marker,
      marker,
      parentId: target.id,
    };
    item.resources.push(resource);
    await save();
    target = await probe.prepareTarget(target, marker);
    resource.id = target.id;
    resource.state = "created";
    await save();
  }
  const initial = await probe.items(target);
  item.providerFixture = { target, marker, baselineIds: initial.map((entry) => entry.id), before: [] };
  await save();
  async function fixture(title: string, closed = false) {
    const resource: Resource = {
      kind: "provider_item",
      key: `fixture-${item.resources.length}`,
      id: null,
      state: "intent",
      parentId: target.id,
      name: title,
      marker,
    };
    item.resources.push(resource);
    await save();
    const created = await probe.create(target, title, marker, closed);
    resource.id = created.id;
    resource.state = "created";
    item.providerFixture?.before.push(created);
    await save();
    return created;
  }
  const sampleTitle = () => `${marker} ${randomUUID().slice(0, 8)}`;
  const source = await fixture(sampleTitle());
  if (["list", "schedule"].includes(definition.operation)) {
    for (let i = 1; i < definition.openCount; i++) await fixture(sampleTitle());
    for (let i = 0; i < definition.closedCount; i++) await fixture(sampleTitle(), true);
  }
  const control = await fixture(`control-${marker}`);
  const before = item.providerFixture.before;
  const expected = before.filter(
    (entry) =>
      entry.title.startsWith(marker) && (definition.selection === "all" || entry.state === definition.selection),
  );
  const expectedText = ["create", "rename"].includes(definition.operation)
    ? `${marker} ${definition.expectedText}`
    : definition.expectedText;
  const output = `open-items-${randomUUID().slice(0, 8)}.txt`;
  const boundPrompt = userRequest(definition)
    .replaceAll("{target}", target.name)
    .replaceAll("{marker}", marker)
    .replaceAll("{source}", source.title)
    .replaceAll("{expected}", expectedText)
    .replaceAll("{output}", output);
  const facts = [
    ...definition.facts,
    `Use my ${definition.integration} connection named ${enrollment.accountName ?? definition.integration}.`,
    `Use only the items created for this test in ${target.name}.`,
    "Keep using the test area and connection I already chose.",
  ];
  const controlComments = await probe.comments(target, control.id);
  const sourceComments = await probe.comments(target, source.id);
  if (definition.operation === "create") {
    item.resources.push({
      kind: "provider_item",
      key: "agent-created",
      id: null,
      state: "intent",
      parentId: target.id,
      name: expectedText,
      marker,
    });
    await save();
  }
  item.stage = definition.operation === "schedule" ? "building" : "using_integration";
  await save();
  let responseText = "";
  if (definition.operation === "schedule") {
    const workspace = await ensureWorkspace(deps.config, enrollment.userId);
    const file = resolve(workspace, output);
    if (await lstat(file).catch(() => null)) throw new BenchmarkBlockedError("The output fixture already exists.");
    item.resources.push({ kind: "workspace_file", key: "report", id: output, state: "created" });
    await save();
    await exerciseBuilder({
      request,
      item,
      model: deps.model,
      manifest: run.model,
      prompt: boundPrompt,
      facts: [...facts, "Enable it when ready.", "Use my normal timezone.", "Overwrite the report on each run."],
      attachments: [],
      signal,
      save,
      createDraft: params.createDraft,
    });
    const task = await deps.db
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", item.automationId ?? "")
      .where("created_by", "=", enrollment.userId)
      .executeTakeFirst();
    assertion(
      item,
      "authoring",
      "The scheduled automation was saved and enabled",
      Boolean(task && task.status === "active"),
      `Automation ${item.automationId ?? "missing"}; status ${task?.status ?? "missing"}.`,
    );
    assertion(
      item,
      "schedule",
      "The requested every-minute schedule was saved",
      Boolean(task && isMinuteSchedule(task.schedule_type, task.schedule_value, task.timezone)),
      `Saved schedule: ${task?.schedule_type ?? "missing"} ${task?.schedule_value ?? ""}.`,
    );
    if (item.assertions.some((check) => check.status === "failed")) {
      item.verdict = "failed";
      return;
    }
    const after = new Date().toISOString();
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    item.stage = "exercising";
    await save();
    let completed = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      await guard();
      const executions = await deps.db
        .selectFrom("automation_runs")
        .selectAll()
        .where("task_id", "=", item.automationId ?? "")
        .where("started_at", ">", after)
        .where("triggered_by_user_id", "is", null)
        .execute();
      const scheduled = executions.filter((execution) => {
        const trigger = JSON.parse(execution.trigger_data ?? "null");
        return typeof trigger?.scheduledAt === "string" && trigger.taskId === item.automationId;
      });
      if (scheduled.some((execution) => execution.status === "failed")) break;
      const info = await lstat(file).catch(() => null);
      if (scheduled.some((execution) => execution.status === "completed") && info?.isFile() && info.size <= 16_384) {
        responseText = await readFile(file, "utf8");
        completed = true;
        break;
      }
      await delay(2000, undefined, { signal });
    }
    assertion(
      item,
      "scheduled_execution",
      "A real scheduled execution produced the report",
      completed,
      "Observed scheduler executions and the workspace file for up to 120 seconds; no manual trigger was used.",
    );
    await ownerJson(request, `/api/scheduled-tasks/${item.automationId}/pause`, "POST", {});
    const pausedAt = new Date().toISOString();
    await delay(70_000, undefined, { signal });
    const unexpected = await deps.db
      .selectFrom("automation_runs")
      .select("id")
      .where("task_id", "=", item.automationId ?? "")
      .where("started_at", ">", pausedAt)
      .execute();
    assertion(
      item,
      "paused",
      "Pausing prevents the next scheduled execution",
      unexpected.length === 0,
      "Observed for 70 seconds after pause, covering the next minute tick.",
    );
  } else {
    responseText = await exerciseDirectChat({
      request,
      item,
      model: deps.model,
      manifest: run.model,
      prompt: boundPrompt,
      facts,
      attachments: [],
      signal,
      save,
    });
    assertion(
      item,
      "direct_agent",
      "The normal agent completed its conversation",
      true,
      "Consumed the normal authenticated chat stream and bounded clarification rounds.",
    );
  }
  item.stage = "verifying";
  await guard();
  const allAfter = await probe.items(target);
  const after = allAfter.filter(
    (entry) => before.some((previous) => previous.id === entry.id) || entry.title.startsWith(marker),
  );
  for (const created of after.filter(
    (entry) =>
      !item.providerFixture?.baselineIds.includes(entry.id) &&
      !item.resources.some((resource) => resource.kind === "provider_item" && resource.id === entry.id),
  )) {
    const intent = item.resources.find(
      (resource) => resource.kind === "provider_item" && resource.state === "intent" && resource.name === created.title,
    );
    if (intent) {
      intent.id = created.id;
      intent.state = "created";
    } else
      item.resources.push({
        kind: "provider_item",
        key: `observed-${created.id}`,
        id: created.id,
        state: "created",
        parentId: target.id,
        name: created.title,
        marker,
      });
  }
  if (
    definition.operation === "create" &&
    !after.some((entry) => !before.some((previous) => previous.id === entry.id) && entry.title === expectedText)
  ) {
    const intent = item.resources.find((resource) => resource.key === "agent-created");
    if (intent) {
      intent.id = "absent";
      intent.state = "deleted";
    }
  }
  await save();
  let correct = false;
  if (definition.operation === "list" || definition.operation === "schedule")
    correct = reportMatches(responseText, expected, before) && unchanged(before, after);
  if (definition.operation === "create") {
    const created = after.filter((entry) => !before.some((previous) => previous.id === entry.id));
    correct =
      created.length === 1 &&
      created[0]?.title === expectedText &&
      unchanged(
        before,
        after.filter((entry) => entry.id !== created[0]?.id),
      );
  }
  if (definition.operation === "rename")
    correct = unchanged(
      before.map((entry) => (entry.id === source.id ? { ...entry, title: expectedText } : entry)),
      after,
    );
  const actualComments = await probe.comments(target, source.id);
  if (definition.operation === "comment")
    correct =
      unchanged(before, after) &&
      actualComments.length === sourceComments.length + 1 &&
      actualComments
        .filter((entry) => !sourceComments.some((previous) => previous.id === entry.id))
        .every((entry) => entry.body.trim() === expectedText.trim());
  const untouchedComments = await probe.comments(target, control.id);
  const controlsIntact =
    JSON.stringify(controlComments) === JSON.stringify(untouchedComments) &&
    unchanged(
      initial,
      allAfter.filter((entry) => initial.some((previous) => previous.id === entry.id)),
    ) &&
    allAfter.every(
      (entry) =>
        initial.some((previous) => previous.id === entry.id) || after.some((fixture) => fixture.id === entry.id),
    );
  assertion(
    item,
    "provider_output",
    "Independent provider state matches the expected outcome",
    correct && controlsIntact,
    `Verified ${before.length} fixture IDs and the resulting state. Expected ${definition.selection} report IDs: ${expected.map((entry) => entry.id).join(", ")}. Control comments ${controlsIntact ? "unchanged" : "changed"}.`,
  );
  item.verdict = item.assertions.some((check) => check.status === "failed") ? "failed" : "passed";
}

export async function reconcileProviderResources(item: CaseResult, probe: ProviderProbe, save: () => Promise<void>) {
  const fixture = item.providerFixture;
  if (!fixture) return;
  const unresolved = item.resources.filter(
    (resource) => resource.kind === "provider_item" && resource.state === "intent" && !resource.id,
  );
  if (!unresolved.length) return;
  const items = await probe.items(fixture.target);
  for (const resource of unresolved) {
    const candidates = items.filter(
      (entry) => entry.title === resource.name && !fixture.baselineIds.includes(entry.id),
    );
    if (candidates.length === 1) {
      resource.id = candidates[0]?.id ?? null;
      resource.state = "created";
      await save();
    }
  }
}
