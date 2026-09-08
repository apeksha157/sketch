import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ensureWorkspace } from "../agent/workspace";
import { createAutomationDraft } from "../automation/persistence";
import { updateWebhookBinding, webhookBindingMetadata } from "../automation/webhook-bindings";
import { buildNativeWebhookUrl } from "../automation/webhook-endpoints";
import type { Config } from "../config";
import type { DB } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import { type OwnerRequest, exerciseBuilder, ownerJson } from "./builder";
import {
  BRIEF,
  BenchmarkBlockedError,
  type ClickUpProbe,
  createClickUpProbe,
  hashBytes,
  outputsMatch,
  prepareFixtures,
} from "./clickup";
import { type Assertion, type BenchmarkRun, type CaseResult, type Enrollment, verdictFor } from "./contracts";
import { executeCoreCase } from "./core";
import { captureExecutionEvidence } from "./evidence";
import { executeIntegrationCase } from "./integration";
import type { createBenchmarkModel } from "./model";
import { createProviderProbe } from "./provider";
import type { createBenchmarkRepository } from "./repository";
import { executeWorkspaceCase, isBenchmarkWorkspaceOutput, reconcileProviderResources } from "./workspace-execution";

export interface RunnerDeps {
  db: Kysely<DB>;
  config: Config;
  repository: ReturnType<typeof createBenchmarkRepository>;
  model: Pick<ReturnType<typeof createBenchmarkModel>, "manifest" | "answer" | "generate">;
  provider: () => Promise<IntegrationProvider | null>;
  ownerRequest: (enrollment: Enrollment) => Promise<OwnerRequest>;
  validateBinding?: (enrollment: Enrollment) => Promise<void>;
  providerProbe?: typeof createProviderProbe;
}

function check(item: CaseResult, id: string, label: string, passed: boolean, evidence: string) {
  item.assertions.push({ id, label, status: passed ? "passed" : "failed", evidence });
}

export function scopedWebhooksMatch(params: {
  endpoints: { status: string; source_binding: string | null; id: string }[];
  remote: { id: string; endpoint: string; list_id?: string | number | null; events: string[] }[];
  sourceIds: string[];
  event: string;
  accountId: string;
  callback: (id: string) => string;
}): boolean {
  const active = params.endpoints.filter((endpoint) => endpoint.status !== "revoked");
  if (active.length !== params.sourceIds.length) return false;
  if (
    params.remote.filter((hook) => params.endpoints.some((endpoint) => hook.endpoint === params.callback(endpoint.id)))
      .length !== params.sourceIds.length
  )
    return false;
  if (params.endpoints.some((endpoint) => endpoint.status === "revoked" && endpoint.source_binding !== null))
    return false;
  const scopes: string[] = [];
  for (const endpoint of active) {
    const binding = z
      .object({ accountId: z.string(), resourceId: z.string(), callbackUrl: z.string() })
      .safeParse(JSON.parse(endpoint.source_binding ?? "null"));
    if (!binding.success || endpoint.status !== "active_signed" || binding.data.accountId !== params.accountId)
      return false;
    const remote = params.remote.filter(
      (hook) => hook.id === binding.data.resourceId && hook.endpoint === params.callback(endpoint.id),
    );
    if (
      remote.length !== 1 ||
      remote[0]?.endpoint !== binding.data.callbackUrl ||
      remote[0].events.length !== 1 ||
      remote[0].events[0] !== params.event
    )
      return false;
    scopes.push(String(remote[0].list_id));
  }
  return scopes.sort().join(",") === [...params.sourceIds].sort().join(",");
}

async function observe(ms: number, signal: AbortSignal) {
  await delay(ms, undefined, { signal });
}

export function createBenchmarkRunner(deps: RunnerDeps) {
  const active = new Map<string, AbortController>();

  async function cleanup(
    run: BenchmarkRun,
    item: CaseResult,
    enrollment: Enrollment,
    save: () => Promise<void>,
    guard: () => Promise<void>,
  ) {
    item.stage = "cleaning";
    await captureExecutionEvidence(deps.db, item);
    if (item.conversationId) {
      const authored = await deps.db
        .selectFrom("scheduled_tasks")
        .select("id")
        .where("created_by", "=", enrollment.userId)
        .where("origin_conversation_id", "=", item.conversationId)
        .execute();
      for (const task of authored) {
        if (!item.resources.some((resource) => resource.kind === "automation" && resource.id === task.id)) {
          item.resources.push({
            kind: "automation",
            key: "unexpected-authored-automation",
            id: task.id,
            state: "created",
          });
          check(
            item,
            `unexpected_automation_${task.id}`,
            "No unexpected automations were created",
            false,
            "Found an additional automation with this exact benchmark conversation as its origin.",
          );
          item.verdict = "failed";
        }
      }
    }
    await save();
    const provider = enrollment.integration !== "none" ? await deps.provider().catch(() => null) : null;
    const probe =
      provider && enrollment.integration === "clickup"
        ? createClickUpProbe(
            provider,
            enrollment.email,
            enrollment.accountId,
            AbortSignal.timeout(120_000),
            fetch,
            guard,
          )
        : null;
    const workspaceProbe =
      provider && item.scenario.definition && enrollment.integration !== "none"
        ? (deps.providerProbe ?? createProviderProbe)({
            integration: enrollment.integration,
            provider,
            userId: enrollment.userId,
            email: enrollment.email,
            accountId: enrollment.accountId,
            signal: AbortSignal.timeout(120_000),
            guard,
          })
        : null;
    const rawRequest = await deps.ownerRequest(enrollment);
    const request: OwnerRequest = async (path, init) => {
      await guard();
      return rawRequest(path, init);
    };
    for (const resource of [...item.resources].reverse()) {
      if (resource.state === "deleted" || resource.state === "retained") continue;
      if (resource.kind === "provider_item" && !resource.id && workspaceProbe)
        await reconcileProviderResources(item, workspaceProbe, save);
      if (!resource.id && resource.kind === "list" && resource.parentId && resource.name && resource.marker && probe) {
        const candidates = (await probe.lists(resource.parentId)).filter((list) => list.name === resource.name);
        const matches: string[] = [];
        for (const candidate of candidates) {
          const detail = await probe.request<{ id: string; content?: string }>("GET", `/list/${candidate.id}`);
          if (detail.content === resource.marker) matches.push(detail.id);
        }
        if (matches.length === 1) {
          resource.id = matches[0] ?? null;
          await save();
        }
      }
      if (!resource.id && resource.kind === "attachment" && resource.name) {
        const workspace = await ensureWorkspace(deps.config, enrollment.userId);
        const files = await readdir(resolve(workspace, "attachments")).catch(() => []);
        const matches = files.filter((file) => /^\d+-/.test(file) && file.endsWith(`-${resource.name}`));
        if (
          matches.length === 1 &&
          hashBytes(await readFile(resolve(workspace, "attachments", matches[0] ?? ""))) === hashBytes(BRIEF)
        ) {
          resource.id = `attachments/${matches[0]}`;
          await save();
        }
      }
      if (!resource.id)
        throw new BenchmarkBlockedError(
          "An interrupted write could not be uniquely reconciled. Its exact marker is retained in the resource ledger for owner review; the write was not replayed.",
        );
      if (resource.kind === "automation") {
        const task = await deps.db
          .selectFrom("scheduled_tasks")
          .selectAll()
          .where("id", "=", resource.id)
          .where("created_by", "=", enrollment.userId)
          .executeTakeFirst();
        if (task) {
          const clientSessionId = `benchmark-cleanup-${run.id}`;
          const response = await ownerJson(request, `/api/scheduled-tasks/${resource.id}/lock`, "POST", {
            clientSessionId,
          });
          const { lock } = z.object({ lock: z.object({ generation: z.number() }) }).parse(response);
          const lease = { clientSessionId, generation: lock.generation };
          try {
            await ownerJson(request, `/api/scheduled-tasks/${resource.id}/pause`, "POST", lease);
            const running = await deps.db
              .selectFrom("automation_runs")
              .select("id")
              .where("task_id", "=", resource.id)
              .where("status", "=", "running")
              .execute();
            if (running.length)
              throw new BenchmarkBlockedError(
                "An automation execution is still running. Cleanup can be retried after it finishes.",
              );
            const endpoints = await deps.db
              .selectFrom("webhook_endpoints")
              .selectAll()
              .where("task_id", "=", resource.id)
              .execute();
            if (endpoints.length && !probe)
              throw new BenchmarkBlockedError("The connection is unavailable for webhook cleanup.");
            const remote = endpoints.length && probe ? await probe.webhooks(enrollment.teamId) : [];
            for (const endpoint of endpoints) {
              if (!probe) throw new BenchmarkBlockedError("The connection is unavailable for webhook cleanup.");
              const callback = buildNativeWebhookUrl(endpoint.id, {
                baseUrl: deps.config.BASE_URL,
                port: deps.config.PORT,
              });
              const binding = webhookBindingMetadata(endpoint);
              if (binding && binding.accountId !== enrollment.accountId)
                throw new BenchmarkBlockedError(
                  "The builder used a different connected account. Its webhook requires owner review.",
                );
              for (const hook of remote.filter((hook) => hook.endpoint === callback))
                await probe.request("DELETE", `/webhook/${hook.id}`);
              if ((await probe.webhooks(enrollment.teamId)).some((hook) => hook.endpoint === callback))
                throw new BenchmarkBlockedError("A remote webhook is still registered.");
              if (endpoint.source_binding)
                await updateWebhookBinding({
                  db: deps.db,
                  endpoint,
                  userId: enrollment.userId,
                  lease: { sessionId: clientSessionId, generation: lock.generation },
                  binding: null,
                  verificationJson: endpoint.verification_json ?? "{}",
                  encryptedSecret: null,
                  status: "revoked",
                });
            }
            await ownerJson(request, `/api/scheduled-tasks/${resource.id}`, "DELETE", lease);
          } finally {
            await request(`/api/scheduled-tasks/${resource.id}/lock`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(lease),
            })
              .then((response) => response.body?.cancel())
              .catch(() => undefined);
          }
        }
      } else if (resource.kind === "provider_item") {
        if (!workspaceProbe || !item.providerFixture || resource.parentId !== item.providerFixture.target.id)
          throw new BenchmarkBlockedError("The original integration is unavailable for fixture cleanup.");
        resource.state = await workspaceProbe.retire(item.providerFixture.target, resource.id);
        if (resource.state === "retained")
          resource.retentionReason =
            enrollment.integration === "github"
              ? "Fixture issue closed; retained in the dedicated GitHub repository."
              : "Fixture issue archived; retained in the dedicated Linear team.";
        await save();
        continue;
      } else if (resource.kind === "list") {
        if (!probe) throw new BenchmarkBlockedError("The connection is unavailable for fixture cleanup.");
        await probe.request("DELETE", `/list/${resource.id}`);
      } else {
        const workspace = await ensureWorkspace(deps.config, enrollment.userId);
        if (
          !(resource.kind === "workspace_file"
            ? isBenchmarkWorkspaceOutput(resource.id)
            : /^attachments\/[A-Za-z0-9._-]+$/.test(resource.id))
        )
          throw new Error("Invalid owned fixture path.");
        await rm(resolve(workspace, resource.id), { force: true });
      }
      resource.state = "deleted";
      await save();
    }
    item.cleanup = "complete";
    item.stage = "finished";
    await save();
  }

  async function executeCase(
    run: BenchmarkRun,
    item: CaseResult,
    enrollment: Enrollment,
    probe: ClickUpProbe | null,
    signal: AbortSignal,
    save: () => Promise<void>,
    guard: () => Promise<void>,
  ) {
    item.startedAt = new Date().toISOString();
    item.stage = "preparing";
    await save();
    const rawRequest = await deps.ownerRequest(enrollment);
    const request: OwnerRequest = async (path, init) => {
      await guard();
      return rawRequest(path, init);
    };
    const createDraft = async (id: string, conversationId: string) => {
      await guard();
      const user = await deps.db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", enrollment.userId)
        .executeTakeFirstOrThrow();
      await createAutomationDraft({
        db: deps.db,
        context: {
          id,
          platform: "slack",
          contextType: "dm",
          deliveryTarget: user.slack_user_id ?? user.id,
          threadTs: null,
          createdBy: user.id,
          originPlatform: "web",
          originConversationId: conversationId,
          originProviderThreadId: null,
          originMessageId: null,
        },
        timezone: user.timezone ?? "UTC",
        taskConversationAssociation: { conversationId, transcriptUserId: user.id, kind: "builder" },
      });
    };
    if (item.scenario.definition && !["core_file", "clickup_webhook"].includes(item.scenario.definition.operation)) {
      await executeWorkspaceCase({ deps, run, item, enrollment, request, signal, save, guard, createDraft });
      return;
    }
    if (run.suiteId === "automation_core" || item.scenario.definition?.operation === "core_file") {
      await executeCoreCase({ deps, run, item, enrollment, request, signal, save, createDraft });
      return;
    }
    if (!probe) throw new BenchmarkBlockedError("The integration is unavailable.");
    const fixtures = await prepareFixtures(
      probe,
      enrollment,
      `Bench ${run.id.slice(0, 4)} ${run.cases.indexOf(item) + 1}`,
      item.resources,
      save,
    );
    const prompt = item.scenario.prompt
      .replaceAll("{source}", fixtures.source.name)
      .replaceAll("{second}", fixtures.second.name)
      .replaceAll("{destination}", fixtures.destination.name);
    const attachments: unknown[] = [];
    if (item.scenario.family === "attachment" || item.scenario.family === "attach_existing") {
      const filename = `benchmark-brief-${randomUUID()}.txt`;
      const resource = {
        kind: "attachment" as const,
        key: "brief",
        id: null as string | null,
        state: "intent" as const,
        name: filename,
      };
      item.resources.push(resource);
      await save();
      const form = new FormData();
      form.append("file", new File([BRIEF], filename, { type: "text/plain" }));
      const response = await request("/api/web-chat/attachments", { method: "POST", body: form });
      if (!response.ok) throw new BenchmarkBlockedError("The brief could not be uploaded through Sketch.");
      const attachment = z
        .object({ path: z.string(), name: z.string(), mediaType: z.string() })
        .passthrough()
        .parse(await response.json());
      Object.assign(resource, { id: attachment.path, state: "created" });
      attachments.push(attachment);
      await save();
    }
    if (run.suiteId === "integrations" && !item.scenario.definition) {
      await executeIntegrationCase({
        run,
        item,
        probe,
        fixtures,
        request,
        model: deps.model,
        signal,
        save,
        attachments,
        prompt,
      });
      return;
    }
    item.stage = "building";
    await save();
    await exerciseBuilder({
      request,
      item,
      model: deps.model,
      manifest: run.model,
      prompt,
      facts: [
        prompt,
        "Use my ClickUp account for this workspace.",
        "Turn the automation on when it is ready.",
        "Use my normal timezone.",
        `Only create follow-up tasks in ${fixtures.destination.name}.`,
      ],
      attachments,
      signal,
      save,
      createDraft,
    });
    const taskId = item.automationId;
    if (!taskId) throw new Error("The builder did not create an automation.");
    const task = await deps.db
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", taskId)
      .where("created_by", "=", enrollment.userId)
      .executeTakeFirst();
    const steps = z
      .array(z.object({ agentModel: z.string().optional() }).passthrough())
      .safeParse(JSON.parse(task?.steps ?? "[]"));
    const configured =
      task?.status === "active" &&
      steps.success &&
      steps.data.every((step) => !step.agentModel || step.agentModel === run.model.modelId);
    check(
      item,
      "authoring",
      "Automation saved and enabled with the shared preset",
      configured,
      `Saved automation ${taskId}; status ${task?.status ?? "missing"}.`,
    );
    const endpoints = await deps.db.selectFrom("webhook_endpoints").selectAll().where("task_id", "=", taskId).execute();
    const sourceIds =
      item.scenario.family === "multiple_lists" ? [fixtures.source.id, fixtures.second.id] : [fixtures.source.id];
    const event = item.scenario.family === "completion" ? "taskStatusUpdated" : "taskCreated";
    const scoped = scopedWebhooksMatch({
      endpoints,
      remote: await probe.webhooks(enrollment.teamId),
      sourceIds,
      event,
      accountId: enrollment.accountId,
      callback: (id) => buildNativeWebhookUrl(id, { baseUrl: deps.config.BASE_URL, port: deps.config.PORT }),
    });
    check(
      item,
      "scoped_webhooks",
      "Only the requested lists and events are watched",
      scoped,
      `Independently compared ${endpoints.length} Sketch endpoint slots with ClickUp registrations for ${sourceIds.length} source lists.`,
    );
    await save();
    if (!configured || !scoped) {
      item.verdict = "failed";
      return;
    }
    if ((await probe.tasks(fixtures.destination.id)).length) {
      check(
        item,
        "provider_output",
        "No work created before a triggering event",
        false,
        "The destination was not empty before the first event.",
      );
      item.verdict = "failed";
      return;
    }
    item.stage = "exercising";
    await save();
    await probe.createTask(fixtures.decoy.id, "Unrelated launch task");
    if (item.scenario.family === "priority")
      for (const priority of [1, 3, 4, null])
        await probe.createTask(fixtures.source.id, `Excluded priority ${priority ?? "unset"}`, priority);
    if (item.scenario.family === "completion") {
      const list = await probe.request<{ statuses: { status: string; type: string }[] }>(
        "GET",
        `/list/${fixtures.source.id}`,
      );
      const completed = list.statuses.find((status) => status.type === "closed" || status.type === "done");
      const open = list.statuses.find((status) => status.type !== "closed" && status.type !== "done");
      if (!completed || !open)
        throw new BenchmarkBlockedError("The test list cannot exercise both completion and reopening transitions.");
      const negative = await probe.request<{ id: string }>("POST", `/list/${fixtures.source.id}/task`, {
        name: "Previously completed work being reopened",
        status: completed.status,
      });
      await probe.request("PUT", `/task/${negative.id}`, { status: open.status });
    }
    await observe(20_000, signal);
    check(
      item,
      "negative_events",
      "Unrelated events produce no follow-up",
      (await probe.tasks(fixtures.destination.id)).length === 0,
      "Observed the real destination for 20 seconds after an unrelated-list event and any applicable non-matching source event.",
    );
    const sourceTasks: { id: string; name: string }[] = [];
    for (const [index, sourceId] of sourceIds.entries()) {
      const source = await probe.createTask(
        sourceId,
        index === 0 ? "Prepare launch brief" : "Review customer feedback",
      );
      sourceTasks.push(source);
      if (item.scenario.family === "completion") {
        const list = await probe.request<{ statuses: { status: string; type: string }[] }>("GET", `/list/${sourceId}`);
        const completed = list.statuses.find((status) => status.type === "closed" || status.type === "done");
        if (!completed) throw new BenchmarkBlockedError("The test list has no completed status.");
        await probe.request("PUT", `/task/${source.id}`, { status: completed.status });
      }
    }
    const expected = sourceTasks.map((source) => `Review: ${source.name}`);
    const deadline = Date.now() + 90_000;
    let output = await probe.tasks(fixtures.destination.id);
    while (Date.now() < deadline && !outputsMatch(output, expected)) {
      await observe(3_000, signal);
      output = await probe.tasks(fixtures.destination.id);
    }
    await observe(20_000, signal);
    output = await probe.tasks(fixtures.destination.id);
    item.stage = "verifying";
    const deliveries = await deps.db
      .selectFrom("webhook_deliveries")
      .innerJoin("automation_runs", "automation_runs.id", "webhook_deliveries.run_id")
      .select(["webhook_deliveries.trigger_data", "automation_runs.status", "automation_runs.id"])
      .where("webhook_deliveries.task_id", "=", taskId)
      .execute();
    const matched = sourceTasks.every((source) =>
      deliveries.some((delivery) => {
        const payload = JSON.parse(delivery.trigger_data);
        return (payload?.data?.task_id ?? payload?.task_id) === source.id && delivery.status === "completed";
      }),
    );
    check(
      item,
      "positive_events",
      "Real source events reach successful executions",
      matched,
      `Correlated ${sourceTasks.length} real source tasks with ${deliveries.length} persisted delivery/run records. Positive event deadline: 90 seconds.`,
    );
    check(
      item,
      "provider_output",
      "Exactly one correctly named follow-up per source",
      outputsMatch(output, expected),
      `Expected ${expected.length} destination tasks; read back ${output.length} after a further 20-second duplicate observation window.`,
    );
    if (item.scenario.family === "attachment") {
      const matches = output.length === 1 && output[0] && (await probe.attachmentMatches(output[0].id));
      check(
        item,
        "attachment_bytes",
        "The correct file is attached to the follow-up",
        Boolean(matches),
        "Compared the downloaded attachment SHA-256 against the original brief; required exactly one attachment on the resulting task.",
      );
    }
    await ownerJson(request, `/api/scheduled-tasks/${taskId}/pause`, "POST", {});
    const beforePause = (
      await deps.db.selectFrom("automation_runs").select("id").where("task_id", "=", taskId).execute()
    ).map((row) => row.id);
    const pausedSource = await probe.createTask(fixtures.source.id, "Task created after pausing");
    if (item.scenario.family === "completion") {
      const list = await probe.request<{ statuses: { status: string; type: string }[] }>(
        "GET",
        `/list/${fixtures.source.id}`,
      );
      const status = list.statuses.find((entry) => entry.type === "closed" || entry.type === "done");
      if (status) await probe.request("PUT", `/task/${pausedSource.id}`, { status: status.status });
    }
    await observe(20_000, signal);
    const afterPause = await deps.db.selectFrom("automation_runs").select("id").where("task_id", "=", taskId).execute();
    check(
      item,
      "paused",
      "Pausing prevents new executions and outputs",
      afterPause.every((row) => beforePause.includes(row.id)) &&
        outputsMatch(await probe.tasks(fixtures.destination.id), expected),
      "Observed a real matching event for 20 seconds while paused; checked execution IDs and destination state.",
    );
    if ((await deps.model.manifest()).fingerprint !== run.model.fingerprint)
      throw new BenchmarkBlockedError("The shared model configuration changed; this attempt is not comparable.");
    item.verdict = verdictFor(item.scenario.family, item.assertions);
  }

  async function work(run: BenchmarkRun, enrollment: Enrollment, workerId: string, cleanupOnly: boolean) {
    const controller = new AbortController();
    active.set(run.id, controller);
    const deadline = setTimeout(() => controller.abort(), 90 * 60_000);
    const heartbeat = setInterval(() => {
      void deps.repository.heartbeat(run.id, workerId).catch(() => controller.abort());
      void deps.repository
        .get(run.id, enrollment.id)
        .then((current) => {
          if (!current || current.cancelRequested) controller.abort();
        })
        .catch(() => controller.abort());
    }, 10_000);
    heartbeat.unref();
    deadline.unref();
    run.status = "running";
    const save = () => deps.repository.save(run, workerId);
    const guard = () => deps.repository.assertWorker(run.id, workerId);
    try {
      const provider =
        cleanupOnly || run.workspaceVersion || run.suiteId === "automation_core" ? null : await deps.provider();
      if (!cleanupOnly && !run.workspaceVersion && !provider && run.suiteId !== "automation_core")
        throw new BenchmarkBlockedError("ClickUp is not connected.");
      const probe =
        provider && enrollment.integration === "clickup"
          ? createClickUpProbe(provider, enrollment.email, enrollment.accountId, controller.signal, fetch, guard)
          : null;
      if (!cleanupOnly && !run.workspaceVersion) {
        if (
          (run.sketchVersion && run.sketchVersion !== (process.env.SKETCH_VERSION ?? "development")) ||
          (run.agentRuntime && run.agentRuntime !== deps.config.AGENT_RUNTIME)
        )
          throw new BenchmarkBlockedError(
            "Sketch was updated after this batch was drafted. Create a repeat on the current release.",
          );
        if (run.enrollmentFingerprint && hashBytes(JSON.stringify(enrollment)) !== run.enrollmentFingerprint)
          throw new BenchmarkBlockedError("The test profile changed since this batch was drafted.");
        if (run.suiteId !== "automation_core") {
          if (!probe) throw new BenchmarkBlockedError("Select an integration test profile.");
          await probe.validate(enrollment);
        }
        if (run.suiteId === "automations" && !deps.config.BASE_URL?.startsWith("https://"))
          throw new BenchmarkBlockedError(
            "The test tenant needs a public HTTPS callback URL for real webhook delivery.",
          );
        if ((await deps.model.manifest()).fingerprint !== run.model.fingerprint)
          throw new BenchmarkBlockedError("Sketch model settings changed since this batch was drafted.");
      }
      const unavailableAccounts = new Set<string>();
      for (const item of run.cases) {
        const caseEnrollment = item.enrollment ?? enrollment;
        const accountKey = `${caseEnrollment.integration}:${caseEnrollment.accountId}`;
        const caseGuard = async () => {
          await guard();
          await deps.validateBinding?.(caseEnrollment);
        };
        if (!cleanupOnly && !controller.signal.aborted && !unavailableAccounts.has(accountKey)) {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12 * 60_000)]);
          try {
            const caseProvider =
              run.workspaceVersion && caseEnrollment.integration === "clickup" ? await deps.provider() : null;
            const caseProbe = caseProvider
              ? createClickUpProbe(
                  caseProvider,
                  caseEnrollment.email,
                  caseEnrollment.accountId,
                  signal,
                  fetch,
                  caseGuard,
                )
              : probe;
            await caseGuard();
            if ((await deps.model.manifest()).fingerprint !== run.model.fingerprint)
              throw new BenchmarkBlockedError("Sketch model settings changed. Create a repeat with the current model.");
            await executeCase(run, item, caseEnrollment, caseProbe, signal, save, caseGuard);
            if ((await deps.model.manifest()).fingerprint !== run.model.fingerprint)
              throw new BenchmarkBlockedError("Sketch model settings changed during this workflow.");
          } catch (error) {
            item.verdict = controller.signal.aborted
              ? "cancelled"
              : error instanceof BenchmarkBlockedError || !["building", "using_integration"].includes(item.stage)
                ? "blocked"
                : "failed";
            item.detail = error instanceof Error ? error.message : "The benchmark could not finish this case.";
            item.failure = {
              phase: item.stage,
              category: controller.signal.aborted
                ? "cancelled"
                : error instanceof BenchmarkBlockedError
                  ? "environment"
                  : ["building", "using_integration", "exercising", "verifying"].includes(item.stage)
                    ? "product"
                    : "harness",
              reason: item.detail,
            };
            if (item.failure.category === "product") item.verdict = "failed";
          }
        } else if (item.verdict === "pending") {
          item.verdict = unavailableAccounts.has(accountKey) ? "blocked" : cleanupOnly ? "unverified" : "cancelled";
          if (unavailableAccounts.has(accountKey))
            item.detail =
              "An earlier case needs cleanup on this account. Other integrations and core cases remain independent.";
        }
        try {
          await cleanup(run, item, caseEnrollment, save, guard);
        } catch (error) {
          item.cleanup = "needs_attention";
          item.detail = `${item.detail ? `${item.detail} ` : ""}Cleanup: ${error instanceof Error ? error.message : "needs attention"}`;
        }
        item.completedAt = new Date().toISOString();
        await save();
        if (item.cleanup === "needs_attention") {
          if (run.workspaceVersion) unavailableAccounts.add(accountKey);
          else controller.abort();
        }
      }
    } catch (error) {
      run.detail = error instanceof Error ? error.message : "Benchmark infrastructure is unavailable.";
      for (const item of run.cases)
        if (item.verdict === "pending") {
          item.verdict = "blocked";
          if (!item.resources.length) item.cleanup = "complete";
        }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      active.delete(run.id);
      run.status = "completed";
      await save();
      await deps.repository.release(run);
    }
  }
  return {
    start(run: BenchmarkRun, enrollment: Enrollment, workerId: string, cleanupOnly = false) {
      void work(run, enrollment, workerId, cleanupOnly).catch(() => undefined);
    },
    cancel(id: string) {
      active.get(id)?.abort();
    },
  };
}
