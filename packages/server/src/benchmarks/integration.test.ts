import { describe, expect, it } from "vitest";
import type { IntegrationProvider } from "../integrations/types";
import { type ClickUpTask, createClickUpProbe } from "./clickup";
import { BENCHMARK_VERSION, type BenchmarkRun, type CaseResult, goals } from "./contracts";
import { executeIntegrationCase } from "./integration";

async function readCase(withReadEvidence: boolean) {
  const tasks: ClickUpTask[] = [];
  const provider: IntegrationProvider = {
    type: "canvas",
    listApps: async () => ({ apps: [], pageInfo: { hasMore: false, endCursor: null } }),
    initiateConnection: async () => ({ redirectUrl: "https://example.com" }),
    listConnections: async () => [],
    removeConnection: async () => {},
    isBrokerCapable: () => false,
    getBrokerSpec: () => null,
    getCanvasAccessToken: async () => ({ accessToken: "fixture-only" }),
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const task = {
        id: String(tasks.length + 1),
        name: body.name,
        status: { status: body.status ?? "open", type: body.status === "closed" ? "closed" : "open" },
      };
      tasks.push(task);
      return Response.json(task);
    }
    if (url.pathname.endsWith("/list/source"))
      return Response.json({ statuses: [{ status: "closed", type: "closed" }] });
    return Response.json({ tasks: url.pathname.endsWith("/list/source/task") ? tasks : [], last_page: true });
  };
  const item: CaseResult = {
    scenario: {
      id: "read-case",
      family: "read_count",
      variant: 0,
      title: goals.read_count.title,
      prompt: "Count my open tasks.",
      version: BENCHMARK_VERSION,
    },
    verdict: "pending",
    stage: "draft",
    assertions: [],
    conversation: [],
    clarifications: 0,
    technicalQuestions: 0,
    cleanup: "pending",
    resources: [],
  };
  const manifest = { provider: "openrouter", modelId: "@preset/luna", fingerprint: "frozen" };
  const run: BenchmarkRun = {
    id: "run",
    enrollmentId: "profile",
    suiteId: "integrations",
    version: BENCHMARK_VERSION,
    status: "running",
    createdAt: new Date().toISOString(),
    model: manifest,
    cases: [item],
    cancelRequested: false,
  };
  await executeIntegrationCase({
    run,
    item,
    probe: createClickUpProbe(provider, "owner@example.com", "account", AbortSignal.timeout(10_000), transport),
    fixtures: {
      source: { id: "source", name: "Support" },
      second: { id: "second", name: "Operations" },
      destination: { id: "destination", name: "Reviews" },
      decoy: { id: "decoy", name: "Other" },
    },
    request: async () =>
      new Response(
        [
          ...(withReadEvidence
            ? [
                `data: ${JSON.stringify({ type: "data-benchmark-read", data: { taskIds: tasks.filter((task) => task.status?.type === "open").map((task) => task.id) } })}`,
              ]
            : []),
          `data: ${JSON.stringify({ type: "text-delta", delta: String(item.expectedOpenCount) })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
      ),
    model: {
      manifest: async () => manifest,
      generate: async () => [],
      answer: async () => ({ text: null, technical: false }),
    },
    signal: AbortSignal.timeout(10_000),
    save: async () => {},
    attachments: [],
    prompt: "Count my open tasks.",
  });
  return item;
}

describe("direct integration oracle calibration", () => {
  it("fails a correct guessed answer with no evaluated integration read", async () => {
    expect((await readCase(false)).verdict).toBe("failed");
  });
  it("accepts the same answer when completed reads cover the hidden fixture tasks", async () => {
    const result = await readCase(true);
    expect(result.verdict).toBe("passed");
    expect(result.providerReadTaskIds).toHaveLength(result.expectedOpenCount ?? 0);
  });
});
