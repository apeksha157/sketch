import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb } from "../test-utils";
import { type CaseDefinition, type CaseInput, type DesignConversation, curatedCases } from "./cases";
import type { BenchmarkRun } from "./contracts";
import { createBenchmarkEnvironment } from "./environment";
import { createBenchmarkRepository } from "./repository";
import { testBenchmarkConnection, testBenchmarkProvider } from "./test-fixtures";
import { createBenchmarkWorkspaceRepository } from "./workspace-repository";
import { benchmarkWorkspaceRoutes } from "./workspace-routes";

function caseInput(id: string): CaseInput {
  const definition = curatedCases.find((entry) => entry.id === id);
  if (!definition) throw new Error("Missing test definition");
  const { id: _id, revision, source, updatedAt, designId, ...input } = definition;
  return input;
}

describe("benchmark workspace API", () => {
  let db: Kysely<DB>;
  let connected = true;
  const manifest = { provider: "test", modelId: "test-model", fingerprint: "test-manifest" };
  const start = vi.fn();
  const designModel = vi.fn(async (conversation: DesignConversation, message: string) => ({
    message: `Refined: ${message}`,
    cases: [
      {
        ...caseInput(conversation.integration === "none" ? "core-note" : `${conversation.integration}-list-open`),
        title: message,
      },
    ],
  }));
  beforeEach(async () => {
    db = await createTestDb();
    connected = true;
    start.mockClear();
    designModel.mockClear();
    const user = await createUserRepository(db).create({
      name: "Shared",
      email: "shared@example.com",
      authRole: "admin",
    });
    await db
      .updateTable("benchmark_environment")
      .set({
        user_id: user.id,
        bindings_json: JSON.stringify(
          Object.fromEntries(
            ["clickup", "github", "linear"].map((integration) => [
              integration,
              {
                accountId: `${integration}-account`,
                target: {
                  id: integration === "github" ? "owner/repo" : "target",
                  name: `${integration} test area`,
                  teamId: "1",
                },
              },
            ]),
          ),
        ),
      })
      .execute();
  });
  afterEach(async () => {
    await db.destroy();
  });
  function app() {
    const provider = testBenchmarkProvider(async () =>
      connected
        ? [testBenchmarkConnection("github"), testBenchmarkConnection("linear"), testBenchmarkConnection("clickup")]
        : [],
    );
    const routes = benchmarkWorkspaceRoutes({
      config: createTestConfig({ BENCHMARKS_ENABLED: true }),
      repository: createBenchmarkRepository(db),
      workspace: createBenchmarkWorkspaceRepository(db),
      environment: createBenchmarkEnvironment(db, async () => provider),
      model: {
        manifest: async () => manifest,
        answer: async () => ({ text: null, technical: false }),
        generate: async () => [],
        design: designModel,
      },
      runner: { start, cancel: () => {} },
      executionAvailable: true,
    });
    routes.onError((error, c) => c.json({ error: error.message }, error instanceof z.ZodError ? 400 : 409));
    return routes;
  }
  function post(path: string, body: unknown) {
    return app().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("exposes defined GitHub, Linear, ClickUp and core cases with executable contracts", async () => {
    const response = await app().request("/cases");
    const data: { cases: CaseDefinition[] } = await response.json();
    expect(data.cases.filter((entry) => entry.integration === "github")).toHaveLength(7);
    expect(data.cases.filter((entry) => entry.integration === "linear")).toHaveLength(7);
    expect(data.cases.filter((entry) => entry.integration === "clickup")).toHaveLength(12);
    expect(data.cases.filter((entry) => entry.integration === "none")).toHaveLength(4);
  });
  it("freezes a one-case or mixed batch without requiring a profile header", async () => {
    const response = await post("/batches", {
      name: "Mixed regression",
      caseIds: ["core-note", "github-rename", "linear-comment"],
    });
    expect(response.status).toBe(201);
    const { run }: { run: BenchmarkRun } = await response.json();
    expect(run.cases.map((entry) => entry.enrollment?.integration)).toEqual(["none", "github", "linear"]);
    expect(run.cases.every((entry) => Boolean(entry.enrollment?.bindingFingerprint))).toBe(true);
    expect(run.status).toBe("draft");
    expect(start).not.toHaveBeenCalled();
    expect((await post("/batches", { caseIds: ["core-note"] })).status).toBe(201);
  });
  it("retains a real multi-turn design conversation and handles retried messages", async () => {
    const created = await post("/designs", { integration: "github", useContext: false });
    const { design }: { design: DesignConversation } = await created.json();
    const messageId = randomUUID();
    const first = await post(`/designs/${design.id}/messages`, {
      id: messageId,
      revision: 1,
      message: "Find open issues",
    });
    expect(first.status).toBe(200);
    const data: { design: DesignConversation } = await first.json();
    expect(data.design.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(data.design.revision).toBe(2);
    expect(
      (await post(`/designs/${design.id}/messages`, { id: messageId, revision: 1, message: "Find open issues" }))
        .status,
    ).toBe(200);
    expect(designModel).toHaveBeenCalledTimes(1);
    const second = await post(`/designs/${design.id}/messages`, {
      id: randomUUID(),
      revision: 2,
      message: "Add a difficult edge case",
    });
    expect(second.status).toBe(200);
    expect(designModel.mock.calls[1]?.[0].messages).toHaveLength(2);
    expect(
      (await post(`/designs/${design.id}/messages`, { id: randomUUID(), revision: 1, message: "Stale edit" })).status,
    ).toBe(409);
    const saved = await post(`/designs/${design.id}/cases`, { revision: 3, indexes: [0] });
    expect(saved.status).toBe(201);
    const proposed: { cases: CaseDefinition[] } = await saved.json();
    expect(proposed.cases[0]).toMatchObject({
      source: "generated",
      title: "Add a difficult edge case",
      designId: design.id,
    });
    expect((await post("/batches", { caseIds: proposed.cases.map((entry) => entry.id) })).status).toBe(201);
  });
  it("grounds bespoke requests without replacing the operator's saved wording", async () => {
    const created = await post("/designs", { integration: "clickup", useContext: false });
    const { design }: { design: DesignConversation } = await created.json();
    const message = "Make a creative automation that keeps my task report current.";
    const response = await post(`/designs/${design.id}/messages`, {
      id: randomUUID(),
      revision: design.revision,
      message,
      mode: "bespoke",
    });
    expect(response.status).toBe(200);
    const result: { design: DesignConversation } = await response.json();
    expect(result.design.messages.find((entry) => entry.role === "user")?.text).toBe(message);
    expect(designModel.mock.calls[0]?.[1]).toContain("one to three bespoke cases");
    expect(designModel.mock.calls[0]?.[1]).toContain(`Operator request:\n${message}`);
  });
  it("keeps frozen manual definitions when the library changes", async () => {
    const saved = await post("/cases", { ...caseInput("core-note"), title: "Manual regression" });
    const { case: definition }: { case: CaseDefinition } = await saved.json();
    const { run }: { run: BenchmarkRun } = await (await post("/batches", { caseIds: [definition.id] })).json();
    await createBenchmarkWorkspaceRepository(db).saveCase(
      { ...caseInput("core-note"), title: "Changed definition" },
      { id: definition.id, expectedRevision: 1 },
    );
    const { run: repeated }: { run: BenchmarkRun } = await (await post("/batches", { sourceRunId: run.id })).json();
    expect(repeated.cases[0]?.scenario.definition?.title).toBe("Manual regression");
    expect(repeated.cases[0]?.scenario.definition?.revision).toBe(1);
  });
  it("paginates across suites and applies filters before pagination", async () => {
    const { run }: { run: BenchmarkRun } = await (await post("/batches", { caseIds: ["github-list-open"] })).json();
    const repository = createBenchmarkRepository(db);
    for (let index = 0; index < 35; index++)
      await repository.insert({
        ...run,
        id: randomUUID(),
        name: `Older ${index}`,
        createdAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    const first = await (await app().request("/batches")).json();
    expect(first.runs).toHaveLength(30);
    expect(first.nextCursor).toBeTruthy();
    const second = await (await app().request(`/batches?cursor=${first.nextCursor}`)).json();
    expect(second.runs).toHaveLength(6);
    expect(new Set([...first.runs, ...second.runs].map((entry: BenchmarkRun) => entry.id)).size).toBe(36);
    expect((await (await app().request("/batches?integration=linear")).json()).runs).toHaveLength(0);
    expect((await (await app().request("/batches?q=Older%2034")).json()).runs).toHaveLength(1);
    connected = false;
    expect((await app().request(`/batches/${run.id}`)).status).toBe(200);
  });
  it("blocks disconnected execution without starting it, while core still drafts", async () => {
    const { run }: { run: BenchmarkRun } = await (await post("/batches", { caseIds: ["github-list-open"] })).json();
    connected = false;
    expect((await post(`/batches/${run.id}/executions`, {})).status).toBe(409);
    expect(start).not.toHaveBeenCalled();
    expect((await post("/batches", { caseIds: ["core-note"] })).status).toBe(201);
  });
});
