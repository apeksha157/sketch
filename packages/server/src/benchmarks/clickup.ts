import { createHash, randomUUID } from "node:crypto";
import type { IntegrationProvider } from "../integrations/types";
import type { Enrollment, EnrollmentInput, Resource } from "./contracts";

export interface ClickUpTask {
  id: string;
  name: string;
  status?: { status: string; type: string };
  attachments?: { title?: string; url?: string }[];
}
export interface ClickUpList {
  id: string;
  name: string;
  statuses?: { status: string; type: string }[];
}
export interface ClickUpWebhook {
  id: string;
  endpoint: string;
  list_id?: string | number | null;
  events: string[];
}
export const BRIEF = "Sketch benchmark fixture v1\nPlease review the follow-up and confirm the next steps.\n";
export const hashBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export class BenchmarkBlockedError extends Error {}

/** The verifier authenticates as the enrolled owner and has no access to model-authored scripts. */
export function createClickUpProbe(
  provider: IntegrationProvider,
  email: string,
  accountId: string,
  signal: AbortSignal,
  requestFetch: typeof fetch = fetch,
  guard: () => Promise<void> = async () => {},
) {
  let calls = 0;
  async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    signal.throwIfAborted();
    await guard();
    if (++calls > 800) throw new BenchmarkBlockedError("The provider call budget was reached.");
    if (!/^\/[a-zA-Z0-9/_-]+(?:\?[a-zA-Z0-9_=&-]+)?$/.test(path)) throw new Error("Invalid benchmark provider path.");
    if (!provider.getCanvasAccessToken)
      throw new BenchmarkBlockedError("Managed ClickUp authentication is unavailable.");
    const token = await provider.getCanvasAccessToken({ integration: "clickup", userEmail: email, accountId });
    await guard();
    const response = await requestFetch(`https://api.clickup.com/api/v2${path}`, {
      method,
      headers: { Authorization: token.accessToken, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      redirect: "error",
    });
    if (method === "DELETE" && response.status === 404) return {} as T;
    if (!response.ok)
      throw new BenchmarkBlockedError(`ClickUp returned HTTP ${response.status}. No uncertain write was retried.`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 1_000_000) throw new BenchmarkBlockedError("Provider response exceeded the benchmark limit.");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return (text ? JSON.parse(text) : {}) as T;
  }
  return {
    request,
    async locations() {
      const { teams } = await request<{ teams: { id: string; name: string }[] }>("GET", "/team");
      const result: { teamId: string; teamName: string; id: string; name: string }[] = [];
      for (const team of teams.slice(0, 20)) {
        const { spaces } = await request<{ spaces: { id: string; name: string }[] }>(
          "GET",
          `/team/${team.id}/space?archived=false`,
        );
        result.push(...spaces.map((space) => ({ ...space, teamId: team.id, teamName: team.name })));
      }
      return result;
    },
    async validate(input: EnrollmentInput) {
      const locations = await this.locations();
      if (
        ![input.spaceId, input.secondSpaceId].every((id) =>
          locations.some((space) => space.id === id && space.teamId === input.teamId),
        )
      )
        throw new BenchmarkBlockedError("Choose accessible test Spaces in the same ClickUp workspace.");
    },
    async lists(spaceId: string) {
      return (await request<{ lists: ClickUpList[] }>("GET", `/space/${spaceId}/list?archived=false`)).lists;
    },
    async createList(spaceId: string, name: string, content: string): Promise<ClickUpList> {
      return request("POST", `/space/${spaceId}/list`, { name, content });
    },
    async tasks(listId: string): Promise<ClickUpTask[]> {
      const tasks: ClickUpTask[] = [];
      for (let page = 0; page < 20; page++) {
        const result = await request<{ tasks: ClickUpTask[]; last_page?: boolean }>(
          "GET",
          `/list/${listId}/task?include_closed=true&page=${page}`,
        );
        tasks.push(...result.tasks);
        if (result.last_page === true || result.tasks.length === 0) return tasks;
      }
      throw new BenchmarkBlockedError("Could not establish a complete provider result within the pagination budget.");
    },
    createTask(listId: string, name: string, priority: number | null = 2): Promise<ClickUpTask> {
      return request("POST", `/list/${listId}/task`, {
        name,
        priority,
        description: "Synthetic Sketch benchmark fixture.",
      });
    },
    async webhooks(teamId: string) {
      return (await request<{ webhooks: ClickUpWebhook[] }>("GET", `/team/${teamId}/webhook`)).webhooks;
    },
    async attachmentMatches(taskId: string): Promise<boolean> {
      const task = await request<ClickUpTask>("GET", `/task/${taskId}`);
      const attachments = task.attachments ?? [];
      if (attachments.length !== 1) return false;
      const url = new URL(attachments[0]?.url ?? "https://invalid.invalid");
      const allowed =
        url.hostname === "attachments.clickup.com" ||
        url.hostname.endsWith(".attachments.clickup.com") ||
        url.hostname.endsWith(".clickup-attachments.com");
      if (url.protocol !== "https:" || !allowed || url.port || url.username || url.password)
        throw new BenchmarkBlockedError("Attachment download host is unsupported; file contents remain unverified.");
      const response = await requestFetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
      });
      if (!response.ok || !response.body)
        throw new BenchmarkBlockedError("Attachment bytes could not be independently downloaded.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 1_000_000) throw new BenchmarkBlockedError("Attachment exceeded the verification byte limit.");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      return hashBytes(Buffer.concat(chunks)) === hashBytes(BRIEF);
    },
  };
}

export type ClickUpProbe = ReturnType<typeof createClickUpProbe>;

export interface Fixtures {
  source: ClickUpList;
  second: ClickUpList;
  destination: ClickUpList;
  decoy: ClickUpList;
}

export async function prepareFixtures(
  probe: ClickUpProbe,
  enrollment: Enrollment,
  prefix: string,
  resources: Resource[],
  save: () => Promise<void>,
): Promise<Fixtures> {
  const result: Partial<Fixtures> = {};
  for (const key of ["source", "second", "destination", "decoy"] as const) {
    const parentId = key === "second" ? enrollment.secondSpaceId : enrollment.spaceId;
    const name = `${prefix} ${key === "source" ? "Support" : key === "second" ? "Operations" : key === "destination" ? "Reviews" : "Unrelated"}`;
    const marker = `Sketch benchmark owned fixture ${randomUUID()}`;
    const resource: Resource = { kind: "list", key, id: null, state: "intent", parentId, name, marker };
    resources.push(resource);
    await save();
    const list = await probe.createList(parentId, name, marker);
    resource.id = list.id;
    resource.state = "created";
    result[key] = list;
    await save();
  }
  if (!result.source || !result.second || !result.destination || !result.decoy)
    throw new Error("Fixture creation was incomplete.");
  return { source: result.source, second: result.second, destination: result.destination, decoy: result.decoy };
}

/** Counts the complete destination, so duplicates and unrelated outputs cannot hide behind a matching task. */
export function outputsMatch(tasks: ClickUpTask[], expectedNames: string[]): boolean {
  const normalize = (name: string) => name.replace(/^Review:\s*/, "Review: ").trim();
  return (
    tasks.length === expectedNames.length &&
    tasks
      .map((task) => normalize(task.name))
      .sort()
      .every((name, index) => name === expectedNames.map(normalize).sort()[index])
  );
}
