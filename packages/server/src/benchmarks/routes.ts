import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { SESSION_COOKIE } from "../api/auth";
import { signJwt } from "../auth/jwt";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { benchmarkSuites } from "./catalogue";
import { BenchmarkBlockedError, hashBytes } from "./clickup";
import { BENCHMARK_VERSION, type BenchmarkRun, batchSizeSchema, suiteIdSchema, summarize } from "./contracts";
import { createBenchmarkModel } from "./model";
import { createBenchmarkRepository } from "./repository";
import { type RunnerDeps, createBenchmarkRunner } from "./runner";
import { createSetupLink } from "./setup";

export function benchmarkRoutes(
  deps: Pick<RunnerDeps, "db" | "config" | "provider"> & {
    request: (path: string, init?: RequestInit) => Promise<Response>;
    executionAvailable: boolean;
  },
) {
  const routes = new Hono();
  const settings = createSettingsRepository(deps.db, deps.config.ENCRYPTION_KEY);
  const users = createUserRepository(deps.db);
  const repository = createBenchmarkRepository(deps.db);
  const model = createBenchmarkModel(settings);
  const runner = createBenchmarkRunner({
    ...deps,
    repository,
    model,
    ownerRequest: async (enrollment) => {
      const current = await repository.enrollmentFor(enrollment.userId, enrollment.accountId);
      if (!current || JSON.stringify(current) !== JSON.stringify(enrollment))
        throw new BenchmarkBlockedError("Benchmark enrollment changed.");
      const user = await users.findById(enrollment.userId);
      const row = await settings.get();
      if (!user || user.email !== enrollment.email || !row?.jwt_secret)
        throw new BenchmarkBlockedError("The enrolled user is unavailable.");
      const token = await signJwt(user.id, user.auth_role === "admin" ? "admin" : "member", row.jwt_secret);
      return (path, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Cookie", `${SESSION_COOKIE}=${token}`);
        return deps.request(path, { ...init, headers });
      };
    },
  });

  routes.use("*", async (c, next) => {
    const expected = deps.config.SYSTEM_SECRET;
    const supplied = c.req.header("Authorization")?.replace(/^Bearer /, "");
    if (
      !expected ||
      !supplied ||
      Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    )
      return c.json({ error: "Unauthorized" }, 401);
    if (!deps.config.BENCHMARKS_ENABLED)
      return c.json({ error: "Benchmarks are not enabled on this tenant.", code: "BENCHMARKS_DISABLED" }, 503);
    await next();
  });
  routes.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "Invalid benchmark request." }, 400);
    return c.json(
      {
        error:
          error instanceof BenchmarkBlockedError
            ? error.message
            : "The benchmark request could not be completed. Check enrollment and whether another batch is active.",
      },
      409,
    );
  });
  async function enrolled(profileId: string | undefined) {
    if (!profileId) throw new BenchmarkBlockedError("Select a test profile for this batch.");
    const enrollment = await repository.enrollmentById(z.string().uuid().parse(profileId));
    if (!enrollment?.sharedWithBenchmarkTeam)
      throw new BenchmarkBlockedError("Connect or enroll a test profile from Benchmarks first.");
    return enrollment;
  }
  routes.get("/", async (c) => {
    await repository.interruptStale();
    const profiles = (await repository.enrollments()).filter((profile) => profile.sharedWithBenchmarkTeam);
    const selected = c.req.header("X-Benchmark-Enrollment-Id");
    const enrollment = selected ? (profiles.find((profile) => profile.id === selected) ?? null) : (profiles[0] ?? null);
    return c.json({
      protocolVersion: 1,
      suites: benchmarkSuites,
      model: await model.manifest(),
      connections: [],
      profiles,
      enrollment,
      runs: enrollment
        ? (await repository.list(enrollment.id)).map((run) => ({
            ...run,
            cases: run.cases.map((item) => ({ ...item, conversation: [], resources: [], assertions: [] })),
            summary: summarize(run),
          }))
        : [],
      executionAvailable: deps.executionAvailable,
    });
  });
  routes.post("/connection-links", async (c) => c.json(await createSetupLink(deps.db, deps.config), 201));
  routes.post("/runs", async (c) => {
    const enrollment = await enrolled(c.req.header("X-Benchmark-Enrollment-Id"));
    const input = z
      .object({
        suiteId: suiteIdSchema,
        integration: z.enum(["clickup", "none"]),
        count: batchSizeSchema,
        sourceRunId: z.string().uuid().optional(),
      })
      .strict()
      .parse(await c.req.json());
    if (input.suiteId !== "automation_core" && enrollment.integration !== "clickup")
      throw new BenchmarkBlockedError("Select a ClickUp test profile for this suite.");
    if ((input.suiteId === "automation_core") !== (input.integration === "none"))
      throw new BenchmarkBlockedError("The integration does not match this suite.");
    const manifest = await model.manifest();
    const source = input.sourceRunId ? await repository.get(input.sourceRunId, enrollment.id) : null;
    if (
      input.sourceRunId &&
      (!source ||
        source.version !== BENCHMARK_VERSION ||
        source.suiteId !== input.suiteId ||
        source.cases.length !== input.count)
    )
      throw new BenchmarkBlockedError("The selected frozen batch is unavailable or uses an unsupported suite version.");
    const scenarios = source
      ? source.cases.map((item) => item.scenario)
      : await model.generate(input.count, manifest, AbortSignal.timeout(100_000), input.suiteId);
    const run: BenchmarkRun = {
      id: randomUUID(),
      enrollmentId: enrollment.id,
      requestedBy: c.req.header("X-Benchmark-Actor-Email")?.slice(0, 320),
      suiteId: input.suiteId,
      sketchVersion: process.env.SKETCH_VERSION ?? "development",
      agentRuntime: deps.config.AGENT_RUNTIME,
      enrollmentFingerprint: hashBytes(JSON.stringify(enrollment)),
      version: BENCHMARK_VERSION,
      status: "draft",
      createdAt: new Date().toISOString(),
      model: manifest,
      cases: scenarios.map((scenario) => ({
        scenario,
        ...(scenario.family === "read_count"
          ? {
              expectedOpenCount:
                source?.cases.find((item) => item.scenario.id === scenario.id)?.expectedOpenCount ?? randomInt(2, 9),
            }
          : {}),
        verdict: "pending",
        stage: "draft",
        assertions: [],
        conversation: [],
        clarifications: 0,
        technicalQuestions: 0,
        cleanup: "pending",
        resources: [],
      })),
      cancelRequested: false,
      ...(source ? { sourceRunId: source.id } : {}),
    };
    await repository.insert(run);
    return c.json({ run }, 201);
  });
  routes.get("/runs/:id", async (c) => {
    const enrollment = await enrolled(c.req.header("X-Benchmark-Enrollment-Id"));
    await repository.interruptStale();
    const run = await repository.get(c.req.param("id"), enrollment.id);
    return run ? c.json({ run, summary: summarize(run) }) : c.json({ error: "Batch not found." }, 404);
  });
  routes.post("/runs/:id/executions", async (c) => {
    const enrollment = await enrolled(c.req.header("X-Benchmark-Enrollment-Id"));
    const run = await repository.get(c.req.param("id"), enrollment.id);
    if (!run) return c.json({ error: "Batch not found." }, 404);
    if (!deps.executionAvailable)
      throw new BenchmarkBlockedError("The builder or scheduler is unavailable on this tenant.");
    const workerId = await repository.claim(run.id, enrollment.id);
    runner.start(run, enrollment, workerId);
    return c.json({ runId: run.id }, 202);
  });
  routes.post("/runs/:id/cancellations", async (c) => {
    const enrollment = await enrolled(c.req.header("X-Benchmark-Enrollment-Id"));
    if (!(await repository.get(c.req.param("id"), enrollment.id))) return c.json({ error: "Batch not found." }, 404);
    await repository.cancel(c.req.param("id"), enrollment.id);
    runner.cancel(c.req.param("id"));
    return c.json({ status: "cancellation_requested" }, 202);
  });
  routes.post("/runs/:id/resource-resolutions", async (c) => {
    const enrollment = await enrolled(c.req.header("X-Benchmark-Enrollment-Id"));
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
      c.req.param("id"),
      enrollment.id,
      input.scenarioId,
      input.resourceKey,
      actor.slice(0, 320),
    );
    return c.json({
      status: "manually_reconciled",
      message: "Manual confirmation recorded. Retry cleanup to release the remaining resources.",
    });
  });
  routes.post("/runs/:id/cleanup-attempts", async (c) => {
    const enrollment = await enrolled(c.req.header("X-Benchmark-Enrollment-Id"));
    await repository.interruptStale();
    const run = await repository.get(c.req.param("id"), enrollment.id);
    if (!run) return c.json({ error: "Batch not found." }, 404);
    const workerId = await repository.claimCleanup(run.id, enrollment.id);
    runner.start(run, enrollment, workerId, true);
    return c.json({ runId: run.id }, 202);
  });
  return routes;
}
