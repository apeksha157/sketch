import type { IntegrationProvider } from "../integrations/types";
import type { DiscoverySnapshot, ProviderIntegration } from "./cases";
import { BenchmarkBlockedError } from "./clickup";

export interface BenchmarkTarget {
  id: string;
  name: string;
  teamId?: string;
}
export interface ProviderItem {
  id: string;
  title: string;
  body: string;
  state: "open" | "closed";
}
export interface ProviderComment {
  id: string;
  body: string;
}
export interface ProviderProbe {
  integration: ProviderIntegration;
  targets(): Promise<{ targets: BenchmarkTarget[]; complete: boolean }>;
  discover(target: BenchmarkTarget): Promise<DiscoverySnapshot>;
  prepareTarget(target: BenchmarkTarget, marker: string): Promise<BenchmarkTarget>;
  items(target: BenchmarkTarget): Promise<ProviderItem[]>;
  create(target: BenchmarkTarget, title: string, body: string, closed?: boolean): Promise<ProviderItem>;
  rename(target: BenchmarkTarget, id: string, title: string): Promise<void>;
  comments(target: BenchmarkTarget, id: string): Promise<ProviderComment[]>;
  comment(target: BenchmarkTarget, id: string, body: string): Promise<void>;
  retire(target: BenchmarkTarget, id: string): Promise<"deleted" | "retained">;
  removeTarget(target: BenchmarkTarget): Promise<void>;
}

export function createProviderProbe(params: {
  integration: ProviderIntegration;
  provider: IntegrationProvider;
  userId: string;
  email: string;
  accountId: string;
  signal: AbortSignal;
  guard?: () => Promise<void>;
  requestFetch?: typeof fetch;
}): ProviderProbe {
  const { integration, provider, signal } = params;
  const send = params.requestFetch ?? fetch;
  const guard = params.guard ?? (async () => {});
  let calls = 0;
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    signal.throwIfAborted();
    await guard();
    if (++calls > 300)
      throw new BenchmarkBlockedError("The integration API budget was reached. No uncertain write was retried.");
    const context = provider.providerId ? { workspaceId: provider.providerId, userId: params.userId } : undefined;
    const auth = { userEmail: params.email, accountId: params.accountId, workspaceContext: context };
    const token =
      integration === "github" && provider.getGithubAccessToken
        ? await provider.getGithubAccessToken(auth)
        : await provider.getCanvasAccessToken?.({ ...auth, integration });
    if (!token?.accessToken) throw new BenchmarkBlockedError(`${integration} managed authorization is unavailable.`);
    await guard();
    const origin =
      integration === "github"
        ? "https://api.github.com"
        : integration === "linear"
          ? "https://api.linear.app"
          : "https://api.clickup.com/api/v2";
    const response = await send(`${origin}${path}`, {
      method,
      headers: {
        Authorization: integration === "clickup" ? token.accessToken : `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
        ...(integration === "github"
          ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      redirect: "error",
    });
    if (method === "DELETE" && response.status === 404) {
      await response.body?.cancel();
      return {} as T;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BenchmarkBlockedError(
        `${integration} returned HTTP ${response.status}. Check the connection and test-area permissions. No uncertain write was retried.`,
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 2_000_000)
            throw new BenchmarkBlockedError("The integration response exceeded the discovery budget.");
          chunks.push(next.value);
        }
    } finally {
      await reader?.cancel();
    }
    try {
      const text = Buffer.concat(chunks).toString("utf8");
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new BenchmarkBlockedError("The integration returned an unreadable response.");
    }
  }
  async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const value = await request<{ data?: T; errors?: unknown[] }>("POST", "/graphql", { query, variables });
    if (value.errors?.length || !value.data)
      throw new BenchmarkBlockedError(
        "Linear could not complete the benchmark API action. Check permissions and target availability.",
      );
    return value.data;
  }
  const part = (value: string) => encodeURIComponent(value);
  const repoPath = (target: BenchmarkTarget) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.id))
      throw new BenchmarkBlockedError("Select a valid GitHub repository.");
    return `/repos/${target.id}`;
  };
  const linearFields = "id identifier title description state { id name type }";
  type LinearIssue = { id: string; title: string; description?: string | null; state: { type: string } };
  type GitHubIssue = { number: number; title: string; body?: string | null; state: string; pull_request?: unknown };
  type ClickUpItem = { id: string; name: string; description?: string; status: { status: string; type: string } };
  const linearItem = (item: LinearIssue): ProviderItem => ({
    id: item.id,
    title: item.title,
    body: item.description ?? "",
    state: ["completed", "canceled"].includes(item.state.type) ? "closed" : "open",
  });
  const githubItem = (item: GitHubIssue): ProviderItem => ({
    id: String(item.number),
    title: item.title,
    body: item.body ?? "",
    state: item.state === "closed" ? "closed" : "open",
  });
  const clickupItem = (item: ClickUpItem): ProviderItem => ({
    id: item.id,
    title: item.name,
    body: item.description ?? "",
    state: ["closed", "done"].includes(item.status.type) ? "closed" : "open",
  });

  async function targets(): Promise<{ targets: BenchmarkTarget[]; complete: boolean }> {
    const result: BenchmarkTarget[] = [];
    if (integration === "github") {
      for (let page = 1; page <= 5; page++) {
        const repos = await request<{ full_name: string; archived: boolean; has_issues: boolean }[]>(
          "GET",
          `/user/repos?per_page=100&page=${page}&sort=full_name`,
        );
        result.push(
          ...repos
            .filter((repo) => !repo.archived && repo.has_issues)
            .map((repo) => ({ id: repo.full_name, name: repo.full_name })),
        );
        if (repos.length < 100) return { targets: result, complete: true };
      }
      return { targets: result, complete: false };
    }
    if (integration === "linear") {
      const data = await graphql<{
        teams: { nodes: { id: string; name: string; key: string }[]; pageInfo: { hasNextPage: boolean } };
      }>("query { teams(first: 100) { nodes { id name key } pageInfo { hasNextPage } } }");
      return {
        targets: data.teams.nodes.map((team) => ({ id: team.id, name: `${team.key} · ${team.name}` })),
        complete: !data.teams.pageInfo.hasNextPage,
      };
    }
    const data = await request<{ teams: { id: string; name: string }[] }>("GET", "/team");
    for (const team of data.teams.slice(0, 20)) {
      const { spaces } = await request<{ spaces: { id: string; name: string }[] }>(
        "GET",
        `/team/${part(team.id)}/space?archived=false`,
      );
      result.push(...spaces.map((space) => ({ id: space.id, name: `${team.name} / ${space.name}`, teamId: team.id })));
    }
    return { targets: result, complete: data.teams.length <= 20 };
  }
  async function readItems(
    target: BenchmarkTarget,
    pageLimit = 10,
  ): Promise<{ items: ProviderItem[]; complete: boolean }> {
    const items: ProviderItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < pageLimit; page++) {
      if (integration === "github") {
        const values = await request<GitHubIssue[]>(
          "GET",
          `${repoPath(target)}/issues?state=all&per_page=100&page=${page + 1}&sort=created&direction=desc`,
        );
        items.push(...values.filter((item) => !item.pull_request).map(githubItem));
        if (values.length < 100) return { items, complete: true };
      } else if (integration === "linear") {
        const data: { issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
          await graphql(
            `query($team: ID!, $after: String) { issues(first: 100, after: $after, filter: { team: { id: { eq: $team } } }) { nodes { ${linearFields} } pageInfo { hasNextPage endCursor } } }`,
            { team: target.id, after: cursor },
          );
        items.push(...data.issues.nodes.map(linearItem));
        if (!data.issues.pageInfo.hasNextPage) return { items, complete: true };
        cursor = data.issues.pageInfo.endCursor;
        if (!cursor) throw new BenchmarkBlockedError("Linear returned incomplete pagination metadata.");
      } else {
        const data = await request<{ tasks: ClickUpItem[]; last_page?: boolean }>(
          "GET",
          `/list/${part(target.id)}/task?include_closed=true&subtasks=true&page=${page}`,
        );
        items.push(...data.tasks.map(clickupItem));
        if (data.last_page === true || data.tasks.length === 0) return { items, complete: true };
      }
    }
    return { items, complete: false };
  }
  async function items(target: BenchmarkTarget): Promise<ProviderItem[]> {
    const result = await readItems(target);
    if (!result.complete)
      throw new BenchmarkBlockedError(
        "The test area exceeds the complete-read budget. Choose a smaller dedicated area; incomplete results cannot pass.",
      );
    return result.items;
  }
  async function discover(target: BenchmarkTarget): Promise<DiscoverySnapshot> {
    let result: { items: ProviderItem[]; complete: boolean };
    let fields: string[];
    if (integration === "clickup") {
      const root = await request<{ lists: { id: string; name: string }[] }>(
        "GET",
        `/space/${part(target.id)}/list?archived=false`,
      );
      const { folders } = await request<{ folders: { lists: { id: string; name: string }[] }[] }>(
        "GET",
        `/space/${part(target.id)}/folder?archived=false`,
      );
      const lists = [...root.lists, ...folders.flatMap((folder) => folder.lists ?? [])];
      result = lists[0] ? await readItems(lists[0], 1) : { items: [], complete: true };
      result.complete = result.complete && lists.length <= 1;
      fields = ["title", "description", "status", ...lists.slice(0, 12).map((list) => `List: ${list.name}`)];
    } else {
      result = await readItems(target, 1);
      fields = [
        "title",
        "description",
        "state",
        ...(integration === "github" ? ["issue number", "comments"] : ["issue ID", "comments"]),
      ];
      if (integration === "linear") {
        const data = await graphql<{ team: { states: { nodes: { name: string; type: string }[] } } }>(
          "query($id: String!) { team(id: $id) { states { nodes { name type } } } }",
          { id: target.id },
        );
        fields.push(...data.team.states.nodes.map((state) => `State: ${state.name} (${state.type})`));
      }
    }
    return {
      integration,
      target,
      capturedAt: new Date().toISOString(),
      complete: result.complete && result.items.length <= 30,
      notes: [
        "Read-only sample for case design. Execution creates isolated marked fixtures; this is not a full account export.",
      ],
      items: result.items
        .slice(0, 30)
        .map((item) => ({ title: item.title.slice(0, 160), state: item.state, description: item.body.slice(0, 300) })),
      fields,
    };
  }
  async function create(target: BenchmarkTarget, title: string, body: string, closed = false): Promise<ProviderItem> {
    if (integration === "github") {
      const item = await request<GitHubIssue>("POST", `${repoPath(target)}/issues`, { title, body });
      if (closed)
        return githubItem(
          await request<GitHubIssue>("PATCH", `${repoPath(target)}/issues/${item.number}`, { state: "closed" }),
        );
      return githubItem(item);
    }
    if (integration === "linear") {
      const data = await graphql<{ team: { states: { nodes: { id: string; type: string }[] } } }>(
        "query($id: String!) { team(id: $id) { states { nodes { id type } } } }",
        { id: target.id },
      );
      const state = data.team.states.nodes.find((entry) =>
        closed ? entry.type === "completed" : ["unstarted", "backlog"].includes(entry.type),
      );
      if (!state)
        throw new BenchmarkBlockedError("The Linear team needs open and completed states for fixture verification.");
      const created = await graphql<{ issueCreate: { success: boolean; issue: LinearIssue } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${linearFields} } } }`,
        { input: { teamId: target.id, title, description: body, stateId: state.id } },
      );
      if (!created.issueCreate.success) throw new BenchmarkBlockedError("Linear did not confirm fixture creation.");
      return linearItem(created.issueCreate.issue);
    }
    const list = await request<{ statuses: { status: string; type: string }[] }>("GET", `/list/${part(target.id)}`);
    const state = list.statuses.find((entry) =>
      closed ? ["closed", "done"].includes(entry.type) : !["closed", "done"].includes(entry.type),
    );
    if (!state)
      throw new BenchmarkBlockedError("The ClickUp list needs open and completed statuses for fixture verification.");
    return clickupItem(
      await request<ClickUpItem>("POST", `/list/${part(target.id)}/task`, {
        name: title,
        description: body,
        status: state.status,
      }),
    );
  }
  async function comments(target: BenchmarkTarget, id: string): Promise<ProviderComment[]> {
    if (integration === "github") {
      const result = await request<{ id: number; body: string }[]>(
        "GET",
        `${repoPath(target)}/issues/${part(id)}/comments?per_page=100`,
      );
      if (result.length === 100) throw new BenchmarkBlockedError("The comment verification budget was reached.");
      return result.map((comment) => ({ id: String(comment.id), body: comment.body }));
    }
    if (integration === "linear") {
      const data = await graphql<{
        issue: { comments: { nodes: ProviderComment[]; pageInfo: { hasNextPage: boolean } } };
      }>(
        "query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id body } pageInfo { hasNextPage } } } }",
        { id },
      );
      if (data.issue.comments.pageInfo.hasNextPage)
        throw new BenchmarkBlockedError("The comment verification budget was reached.");
      return data.issue.comments.nodes;
    }
    const data = await request<{ comments: { id: string; comment_text: string }[] }>(
      "GET",
      `/task/${part(id)}/comment`,
    );
    if (data.comments.length >= 25) throw new BenchmarkBlockedError("The comment verification budget was reached.");
    return data.comments.map((comment) => ({ id: String(comment.id), body: comment.comment_text }));
  }
  return {
    integration,
    targets,
    discover,
    items,
    create,
    comments,
    async prepareTarget(target, marker) {
      if (integration !== "clickup") return target;
      const list = await request<{ id: string; name: string }>("POST", `/space/${part(target.id)}/list`, {
        name: marker,
        content: marker,
      });
      return { id: list.id, name: list.name, teamId: target.teamId };
    },
    async rename(target, id, title) {
      if (integration === "github") await request("PATCH", `${repoPath(target)}/issues/${part(id)}`, { title });
      else if (integration === "linear") {
        const data = await graphql<{ issueUpdate: { success: boolean } }>(
          "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
          { id, input: { title } },
        );
        if (!data.issueUpdate.success) throw new BenchmarkBlockedError("Linear did not confirm the update.");
      } else await request("PUT", `/task/${part(id)}`, { name: title });
    },
    async comment(target, id, body) {
      if (integration === "github") await request("POST", `${repoPath(target)}/issues/${part(id)}/comments`, { body });
      else if (integration === "linear") {
        const data = await graphql<{ commentCreate: { success: boolean } }>(
          "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
          { input: { issueId: id, body } },
        );
        if (!data.commentCreate.success) throw new BenchmarkBlockedError("Linear did not confirm the comment.");
      } else await request("POST", `/task/${part(id)}/comment`, { comment_text: body, notify_all: false });
    },
    async retire(target, id) {
      if (integration === "github") {
        const result = await request<GitHubIssue>("PATCH", `${repoPath(target)}/issues/${part(id)}`, {
          state: "closed",
        });
        if (result.state !== "closed") throw new BenchmarkBlockedError("GitHub fixture closure was not confirmed.");
        return "retained";
      }
      if (integration === "linear") {
        const data = await graphql<{ issueArchive: { success: boolean } }>(
          "mutation($id: String!) { issueArchive(id: $id) { success } }",
          { id },
        );
        if (!data.issueArchive.success) throw new BenchmarkBlockedError("Linear fixture archival was not confirmed.");
        return "retained";
      }
      await request("DELETE", `/task/${part(id)}`);
      return "deleted";
    },
    async removeTarget(target) {
      if (integration !== "clickup") throw new Error("Only benchmark-created ClickUp lists can be removed.");
      await request("DELETE", `/list/${part(target.id)}`);
    },
  };
}
