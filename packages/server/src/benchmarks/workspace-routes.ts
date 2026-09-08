import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config";
import { type CaseDefinition, type DesignConversation, caseInputSchema, integrationIdSchema } from "./cases";
import { BenchmarkBlockedError, hashBytes } from "./clickup";
import { BENCHMARK_VERSION, type BenchmarkRun, type Enrollment, goals, summarize } from "./contracts";
import type { createBenchmarkEnvironment } from "./environment";
import type { createBenchmarkModel } from "./model";
import type { createBenchmarkRepository } from "./repository";
import type { createBenchmarkRunner } from "./runner";
import type { createBenchmarkWorkspaceRepository } from "./workspace-repository";

export function benchmarkWorkspaceRoutes(deps: {
  config: Config;
  repository: ReturnType<typeof createBenchmarkRepository>;
  workspace: ReturnType<typeof createBenchmarkWorkspaceRepository>;
  environment: ReturnType<typeof createBenchmarkEnvironment>;
  model: ReturnType<typeof createBenchmarkModel>;
  runner: ReturnType<typeof createBenchmarkRunner>;
  executionAvailable: boolean;
}) {
  const routes = new Hono();
  const { environment, repository, workspace, model, runner } = deps;
  const starterMessage =
    "Create a concise starter benchmark suite for this connected workspace using its terminology, fields, and representative data. Propose three to five distinct and useful cases: an everyday lookup, a focused change, and a recurring workflow when supported. Make every title, request, and explanation sound like a real teammate describing the outcome they want in plain language. Keep technical verification details out of the user-facing copy. Keep every case isolated, reviewable, and limited to the selected test area.";
  function stableUuid(value: string) {
    const hex = createHash("sha256").update(value).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
  async function respond(design: DesignConversation, message: string, id: string, designerRequest = message) {
    if (design.messages.some((entry) => entry.id === id)) return design;
    if (design.messages.length >= 80)
      throw new BenchmarkBlockedError(
        "This conversation reached 40 exchanges. Start a new conversation to keep case design focused.",
      );
    const lease = await workspace.claimDesign(design.id, design.revision);
    try {
      const reply = await model.design(design, designerRequest, AbortSignal.timeout(100_000));
      return workspace.saveDesign(
        {
          ...design,
          cases: reply.cases,
          messages: [
            ...design.messages,
            { id, role: "user" as const, text: message, createdAt: new Date().toISOString() },
            { id: randomUUID(), role: "assistant" as const, text: reply.message, createdAt: new Date().toISOString() },
          ],
        },
        lease,
      );
    } finally {
      await workspace.releaseDesign(design.id, lease);
    }
  }
  routes.get("/environment", async (c) => {
    const state = await environment.overview();
    let modelInfo: Awaited<ReturnType<typeof model.manifest>> | null = null;
    let modelError: string | undefined;
    try {
      modelInfo = await model.manifest();
    } catch {
      modelError = "Choose an available model in the test tenant's settings.";
    }
    return c.json({
      ...state,
      protocolVersion: 2,
      executionAvailable: deps.executionAvailable,
      model: modelInfo,
      modelError,
    });
  });
  routes.get("/environment/targets", async (c) => {
    const integration = z.enum(["clickup", "github", "linear"]).parse(c.req.query("integration"));
    const accountId = z.string().min(1).max(256).parse(c.req.query("accountId"));
    return c.json(await environment.targets(integration, accountId));
  });
  routes.put("/environment/connections/:integration", async (c) => {
    const integration = z.enum(["clickup", "github", "linear"]).parse(c.req.param("integration"));
    const body = z
      .object({
        accountId: z.string().min(1).max(256),
        targetId: z.string().min(1).max(256),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(await environment.configure(integration, body.accountId, body.targetId, body.revision));
  });
  routes.get("/cases", async (c) => c.json({ cases: await workspace.cases() }));
  routes.post("/cases", async (c) =>
    c.json({ case: await workspace.saveCase(caseInputSchema.parse(await c.req.json())) }, 201),
  );
  routes.put("/cases/:id", async (c) => {
    const input = z
      .object({ revision: z.number().int().positive(), case: caseInputSchema })
      .strict()
      .parse(await c.req.json());
    return c.json({
      case: await workspace.saveCase(input.case, { id: c.req.param("id"), expectedRevision: input.revision }),
    });
  });
  routes.get("/designs", async (c) => c.json({ designs: await workspace.designs() }));
  routes.post("/designs", async (c) => {
    const input = z
      .object({
        integration: integrationIdSchema,
        useContext: z.boolean().default(true),
        starter: z.boolean().default(false),
      })
      .strict()
      .parse(await c.req.json());
    if (input.starter && input.integration === "none")
      throw new BenchmarkBlockedError("Core benchmarks use the reviewed cases already available in the workspace.");
    const context =
      input.integration !== "none" && input.useContext
        ? await environment.discover(input.integration)
        : { snapshot: null };
    const bindingFingerprint = "bindingFingerprint" in context ? context.bindingFingerprint : undefined;
    const id =
      input.starter && bindingFingerprint
        ? stableUuid(`benchmark-starter:plain-language-v2:${input.integration}:${bindingFingerprint}`)
        : randomUUID();
    const design: DesignConversation = {
      id,
      revision: 1,
      integration: input.integration,
      ...(input.starter ? { purpose: "starter" as const } : {}),
      ...context,
      messages: [],
      cases: [],
      createdAt: new Date().toISOString(),
    };
    const saved = await workspace.createDesign(design);
    if (!input.starter || saved.messages.length > 0) return c.json({ design: saved }, 201);
    try {
      return c.json(
        { design: await respond(saved, starterMessage, stableUuid(`benchmark-starter-message:${saved.id}`)) },
        201,
      );
    } catch (error) {
      const latest = await workspace.design(saved.id);
      if (error instanceof BenchmarkBlockedError && error.message.includes("agent is still responding") && latest)
        return c.json({ design: latest, generating: true }, 202);
      throw error;
    }
  });
  routes.get("/designs/:id", async (c) => {
    const design = await workspace.design(c.req.param("id"));
    return design ? c.json({ design }) : c.json({ error: "Case conversation not found." }, 404);
  });
  routes.post("/designs/:id/messages", async (c) => {
    const input = z
      .object({
        id: z.string().uuid(),
        revision: z.number().int().positive(),
        message: z.string().trim().min(1).max(6000),
        mode: z.enum(["refine", "bespoke"]).default("refine"),
      })
      .strict()
      .parse(await c.req.json());
    const design = await workspace.design(c.req.param("id"));
    if (!design) return c.json({ error: "Case conversation not found." }, 404);
    if (!design.messages.some((entry) => entry.id === input.id) && design.revision !== input.revision)
      throw new BenchmarkBlockedError("The suggestions changed. Refresh before generating custom cases.");
    const designerRequest =
      input.mode === "bespoke"
        ? `Replace the current proposal with one to three bespoke cases focused on the operator's request. Ground them in the connected integration and discovered test-area data. Include an integration-powered automation when the request calls for one. Do not retain generic starter cases unless they directly support this request. Keep all user-facing copy plain and outcome-focused.\n\nOperator request:\n${input.message}`
        : input.message;
    return c.json({ design: await respond(design, input.message, input.id, designerRequest) });
  });
  routes.post("/designs/:id/cases", async (c) => {
    const input = z
      .object({
        revision: z.number().int().positive(),
        indexes: z.array(z.number().int().min(0).max(11)).min(1).max(12),
      })
      .strict()
      .parse(await c.req.json());
    const design = await workspace.design(c.req.param("id"));
    if (!design) return c.json({ error: "Case conversation not found." }, 404);
    if (
      design.revision !== input.revision ||
      input.indexes.some((index) => !design.cases[index]) ||
      new Set(input.indexes).size !== input.indexes.length
    )
      throw new BenchmarkBlockedError("The proposal changed. Refresh before saving cases.");
    const saved = await workspace.saveProposal(design.id, input.revision, input.indexes);
    return c.json({ cases: saved }, 201);
  });
  routes.get("/batches", async (c) => {
    await repository.interruptStale();
    const encoded = c.req.query("cursor");
    const cursor = encoded
      ? z
          .object({ createdAt: z.string().max(40), id: z.string().uuid() })
          .strict()
          .parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
      : undefined;
    const filters = z
      .object({
        integration: integrationIdSchema.optional(),
        status: z.enum(["draft", "queued", "running", "completed", "interrupted"]).optional(),
        q: z.string().max(100).optional(),
      })
      .parse({ integration: c.req.query("integration"), status: c.req.query("status"), q: c.req.query("q") });
    const { runs, nextCursor } = await repository.listAll(cursor, 30, filters);
    return c.json({
      runs: runs.map((run) => ({
        ...run,
        cases: run.cases.map((item) => ({
          ...item,
          conversation: [],
          resources: [],
          assertions: [],
          events: [],
          executionEvidence: [],
          providerFixture: undefined,
        })),
        summary: summarize(run),
      })),
      nextCursor: nextCursor ? Buffer.from(JSON.stringify(nextCursor)).toString("base64url") : null,
    });
  });
  routes.post("/batches", async (c) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(160).optional(),
        caseIds: z.array(z.string().min(1).max(160)).min(1).max(40).optional(),
        sourceRunId: z.string().uuid().optional(),
      })
      .strict()
      .parse(await c.req.json());
    if (Boolean(input.caseIds) === Boolean(input.sourceRunId))
      throw new BenchmarkBlockedError("Select cases or an existing batch to repeat.");
    const source = input.sourceRunId ? await repository.getAny(input.sourceRunId) : null;
    if (input.sourceRunId && !source) return c.json({ error: "Batch not found." }, 404);
    if (source && !source.workspaceVersion)
      throw new BenchmarkBlockedError(
        "This is a legacy batch. Select the corresponding defined cases to run it in the shared workspace.",
      );
    const definitions = source
      ? source.cases.map((item) => item.scenario.definition).filter((entry): entry is CaseDefinition => Boolean(entry))
      : await Promise.all((input.caseIds ?? []).map((id) => workspace.case(id)));
    if (
      !definitions.length ||
      definitions.some((entry) => !entry) ||
      new Set(definitions.map((entry) => entry?.id)).size !== definitions.length
    )
      throw new BenchmarkBlockedError("Select distinct available test cases.");
    const bindings = new Map<string, Enrollment>();
    for (const definition of definitions)
      if (definition && !bindings.has(definition.integration))
        bindings.set(definition.integration, await environment.binding(definition.integration));
    const anchor =
      [...bindings.values()].find((entry) => entry.integration !== "none") ?? (await environment.binding("none"));
    const enrollment =
      (await repository.enrollmentFor(anchor.userId, anchor.accountId)) ??
      (await repository.enroll({ ...anchor, id: randomUUID() }));
    const manifest = await model.manifest();
    const run: BenchmarkRun = {
      id: randomUUID(),
      name: input.name ?? (source ? `Repeat: ${source.name ?? "benchmark batch"}` : "Benchmark batch"),
      enrollmentId: enrollment.id,
      workspaceVersion: 2,
      suiteId: definitions.every((entry) => entry?.integration === "none") ? "automation_core" : "integrations",
      version: BENCHMARK_VERSION,
      requestedBy: c.req.header("X-Benchmark-Actor-Email")?.slice(0, 320),
      sketchVersion: process.env.SKETCH_VERSION ?? "development",
      agentRuntime: deps.config.AGENT_RUNTIME,
      model: manifest,
      status: "draft",
      createdAt: new Date().toISOString(),
      cancelRequested: false,
      ...(source ? { sourceRunId: source.id } : {}),
      cases: definitions.flatMap((definition) => {
        if (!definition) return [];
        const binding = bindings.get(definition.integration);
        const family = definition.webhookFamily ?? "workspace_case";
        return [
          {
            enrollment: binding,
            scenario: {
              id: definition.id,
              family,
              variant: 0,
              title: definition.title,
              prompt: definition.webhookFamily
                ? (goals[definition.webhookFamily].requests[0] ?? "")
                : definition.prompt,
              version: `${BENCHMARK_VERSION}:${definition.revision}:${hashBytes(JSON.stringify(definition)).slice(0, 12)}`,
              definition,
            },
            verdict: "pending" as const,
            stage: "draft",
            assertions: [],
            conversation: [],
            clarifications: 0,
            technicalQuestions: 0,
            cleanup: "pending" as const,
            resources: [],
          },
        ];
      }),
    };
    await repository.insert(run);
    return c.json({ run }, 201);
  });
  routes.get("/batches/:id", async (c) => {
    await repository.interruptStale();
    const run = await repository.getAny(c.req.param("id"));
    return run ? c.json({ run, summary: summarize(run) }) : c.json({ error: "Batch not found." }, 404);
  });
  routes.post("/batches/:id/executions", async (c) => {
    const run = await repository.getAny(c.req.param("id"));
    if (!run) return c.json({ error: "Batch not found." }, 404);
    if (!run.workspaceVersion)
      throw new BenchmarkBlockedError("Select defined cases to run this legacy batch in the shared workspace.");
    if (!deps.executionAvailable)
      throw new BenchmarkBlockedError("The agent or scheduler is unavailable on this tenant.");
    if (
      run.sketchVersion !== (process.env.SKETCH_VERSION ?? "development") ||
      run.agentRuntime !== deps.config.AGENT_RUNTIME ||
      (await model.manifest()).fingerprint !== run.model.fingerprint
    )
      throw new BenchmarkBlockedError(
        "The tenant release or model changed. Create a repeat to use the current settings.",
      );
    for (const item of run.cases) if (item.enrollment) await environment.validate(item.enrollment);
    const enrollment = await repository.enrollmentById(run.enrollmentId);
    if (!enrollment) throw new BenchmarkBlockedError("The original benchmark identity is unavailable.");
    const workerId = await repository.claim(run.id, run.enrollmentId);
    runner.start(run, enrollment, workerId);
    return c.json({ runId: run.id }, 202);
  });
  routes.post("/batches/:id/cancellations", async (c) => {
    const run = await repository.getAny(c.req.param("id"));
    if (!run) return c.json({ error: "Batch not found." }, 404);
    await repository.cancel(run.id, run.enrollmentId);
    runner.cancel(run.id);
    return c.json({ status: "cancellation_requested" }, 202);
  });
  routes.post("/batches/:id/cleanup-attempts", async (c) => {
    const run = await repository.getAny(c.req.param("id"));
    if (!run) return c.json({ error: "Batch not found." }, 404);
    const enrollment = await repository.enrollmentById(run.enrollmentId);
    if (!enrollment) throw new BenchmarkBlockedError("The original benchmark identity is unavailable.");
    const workerId = await repository.claimCleanup(run.id, run.enrollmentId);
    const claimed = await repository.getAny(run.id);
    if (!claimed) throw new BenchmarkBlockedError("The batch is unavailable.");
    runner.start(claimed, enrollment, workerId, true);
    return c.json({ runId: run.id }, 202);
  });
  routes.post("/batches/:id/resource-resolutions", async (c) => {
    const run = await repository.getAny(c.req.param("id"));
    if (!run) return c.json({ error: "Batch not found." }, 404);
    const input = z
      .object({
        scenarioId: z.string().min(1).max(256),
        resourceKey: z.string().min(1).max(256),
        confirmedAbsent: z.literal(true),
      })
      .strict()
      .parse(await c.req.json());
    const actor = c.req.header("X-Benchmark-Actor-Email");
    if (!actor)
      throw new BenchmarkBlockedError("An authenticated Platform account is required for manual reconciliation.");
    await repository.resolveAbsentResource(
      run.id,
      run.enrollmentId,
      input.scenarioId,
      input.resourceKey,
      actor.slice(0, 320),
    );
    return c.json({ status: "manually_reconciled" });
  });
  return routes;
}
