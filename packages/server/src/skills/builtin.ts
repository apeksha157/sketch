import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";

export const MANAGED_LINEAR_SKILL = `---
name: Linear
description: Use Linear through its managed GraphQL API for issue and project work.
category: engineering
provider-type: api:linear
requires-env:
  - LINEAR_API_KEY
---

# Linear API

Use Linear's GraphQL API at \`https://api.linear.app/graphql\` for Linear work. The runtime supplies \`LINEAR_API_KEY\` only when the current user owns the connection, has a user share, or has organization-wide access.

Authenticate with the raw API key in the \`Authorization\` header. Do not add \`Bearer\`, print the key, put it in a URL or command argument, or expose the process environment.

## Safe workflow

1. Read before writing. Use a small GraphQL query to inspect the target team, project, or issue before changing it.
2. Use JSON request bodies with \`query\` and \`variables\`; keep queries bounded and request only fields needed for the task.
3. Use \`viewer\`, \`teams\`, and \`projects\` to resolve identity and IDs. Use \`issues(filter: ...)\` or \`issue(id: ...)\` to locate an issue.
4. For writes, show the intended title, description, target team, and issue identifier before asking for normal user confirmation. Then use \`issueCreate\`, \`issueUpdate\`, or \`commentCreate\` mutations with variables.
5. Explain GraphQL errors plainly and retry only transient failures. Never log request headers or credential values.

Useful operations include \`query { viewer { id name email } }\`, bounded team/project lookups, issue searches filtered by team or identifier, \`issueCreate(input: { title, description, teamId })\`, \`issueUpdate(id: \"...\", input: { title, description })\`, and \`commentCreate(input: { issueId, body })\`.
`;

export const MANAGED_GITHUB_SKILL = `---
name: GitHub CLI
description: Use GitHub through the managed gh CLI for repository, issue, pull request, workflow, and release work.
category: engineering
provider-type: cli:github
requires-env:
  - GH_TOKEN
---

# GitHub CLI

Use the GitHub CLI executable \`gh\` for GitHub work. The Sketch runtime supplies authentication only when the current user owns the connection, has a user share, or has organization-wide access.

## Safe workflow

1. Start with discovery. Use \`gh repo list\`, \`gh repo view OWNER/REPO\`, or a read-only command to identify the repository before reading or changing it.
2. Prefer JSON output and \`--jq\` for stable, concise results. Use \`--paginate\` when the result can span pages.
3. Pass \`--repo OWNER/REPO\` explicitly whenever the working directory does not make the target unambiguous.
4. Read before writing. For issues, pull requests, workflows, and releases, show the proposed target and change, then ask for normal user confirmation before a write.
5. Use \`gh api\` only when a dedicated command does not expose the needed endpoint. Keep API paths explicit and never put tokens in arguments.

Useful read commands include \`gh repo view --repo OWNER/REPO --json nameWithOwner,defaultBranchRef\`, \`gh issue list --repo OWNER/REPO --json number,title,state --limit 20\`, \`gh pr list --repo OWNER/REPO --json number,title,state --limit 20\`, \`gh run list --repo OWNER/REPO --json databaseId,status,conclusion --limit 20\`, and \`gh release list --repo OWNER/REPO --limit 20\`.

Use \`gh issue create\`, \`gh pr create\`, \`gh workflow run\`, and \`gh release create\` only after the user has confirmed the intended write. Explain provider errors plainly and retry only when the error is transient.

Never use \`$CANVAS_CLI\`, Canvas MCP tools, raw HTTP authorization headers, raw tokens, token-printing commands, or commands that expose the process environment. Do not pass a token in a URL, shell argument, file, issue, pull request, or log. Keep generated files inside the Sketch workspace.
`;

export const MANAGED_CLICKUP_SKILL = `---
name: ClickUp
description: Use ClickUp through Sketch's managed ClickUp API tool with Canvas authorization.
category: productivity
managed-integration: clickup
---

# ClickUp API

Use the Sketch \`clickup_api\` tool for ClickUp work. The managed-integration gate must be available for this run. Canvas owns authorization and account selection and supplies a Canvas-minted, server-held OAuth credential for the request. Never ask for or use a PAT, raw token, Canvas CLI/MCP, token-bearing URL, shell command, or workspace file for ClickUp authentication. The separate ClickUp Files connector may use a PAT; it does not authorize this skill. Credentials and webhook signing secrets stay out of model output, files, environment, and logs.

Eligible existing Canvas OAuth connections are reused automatically after credential minting and read-only identity/Workspace validation. Do not ask users to reconnect just to adopt an existing grant. A timeout, 429, or \`SHARD_009\` Workspace response is inconclusive, not proof of revocation. Leave those connections and existing automations untouched; report the verification boundary without treating it as a healthy connection.

## Ordinary API work

Read before writing. Discover accessible Workspaces with \`GET /team\`, then spaces with \`GET /team/{team_id}/space\`, folders with \`GET /space/{space_id}/folder\`, and lists with \`GET /folder/{folder_id}/list\` or \`GET /space/{space_id}/list\`. Use \`GET /list/{list_id}/task\` or \`GET /task/{task_id}\` for bounded task reads. Resolve the user's meaning of "boards" from this hierarchy instead of inventing a board endpoint. Paginate as needed; use exact returned IDs, small query parameters and JSON bodies. Summarize the target and intended change before normal confirmation for writes. Ordinary reads and task updates do not need a webhook or automation.

## Native webhook automations

Keep these IDs distinct:

- \`accountId\`: the opaque Canvas ClickUp account ID. Pass the exact value returned by the managed integration; never substitute a ClickUp ID.
- \`team_id\`: ClickUp's Workspace ID, used in API paths such as \`/team/{team_id}/webhook\`.
- \`task_id\`: the Sketch automation ID passed to \`ManageScheduledTasks\`, not a ClickUp task ID. Binding metadata calls it \`taskId\`.
- \`webhookEndpointId\`: the opaque native Sketch endpoint ID returned with the automation's webhook URL. It is the optional binding argument to \`clickup_api\`, not an action or lifecycle command.

## Safe workflow

1. Gate and resolve. Use the existing \`getProviderConfig\` tool's \`managedAccounts\` to discover the exact opaque \`accountId\` and owner label. This is discovery metadata, not proof of Workspace access: read \`GET /team\` with the selected account before setup. Confirm the managed ClickUp capability; if several usable accounts exist, ask the user to choose. Only the automation owner in the matching authoring context may manage its webhook.
2. Set up the Sketch endpoint. Use \`ManageScheduledTasks\` to inspect or create the automation, pause it, and confirm \`type: "webhook"\`, \`schedule_type: "external"\`, and \`schedule_value: "webhook"\`. For agent steps that use ClickUp, set \`agentMode: "sketch"\` and \`agentSkills: ["clickup"]\`; light steps do not have this managed API. Use the returned \`webhookUrl\` and \`webhookEndpointId\`; the URL must be a public HTTPS URL from \`BASE_URL\`, and the ClickUp POST body \`endpoint\` must match it exactly. Never use localhost as the public callback.
3. Choose a narrow subscription. Resolve the ClickUp \`team_id\`, then choose explicit event names and at most one optional hierarchy scope (space, folder, list, or task). Prefer the smallest event set; never use \`*\`. Summarize the target and intended write, then obtain normal confirmation.
4. Inspect before creating. First GET inventory without \`webhookEndpointId\`; this is a safe read and does not mutate local state. For a previously attempted registration, inspect \`ManageScheduledTasks get\` for the persisted \`webhookBinding\` (original account, collection path, callback, requested events/location, and remote resource ID), then GET with that account and \`webhookEndpointId\` to reconcile. This bound GET requires an existing reservation and exactly one matching saved callback, Workspace, events, and location; stop on zero or multiple matches. A uniquely identified webhook with a different/malformed subscription or unusable secret stays pending with its cleanup ID, never active. An existing bound endpoint must not receive a second POST.
5. Register once during setup, never once per automation run. The adapter records the nonsecret binding before the outbound POST and captures the returned signing secret into encrypted server storage. Use the direct API request below, not an action field. If POST is uncertain, do not repeat it: GET with the same endpoint and account to reconcile. If ClickUp returns \`OAUTH_171\`, reconcile the existing configuration instead of posting again. If the result is missing or ambiguous, leave the binding paused and stop.
6. Verify before activation. Inspect safe metadata only. The native receiver verifies \`X-Signature\` as HMAC-SHA256 over the original request bytes before durable admission, hashes the event kind, webhook ID, and sorted history item IDs when present, otherwise the raw body, for durable dedupe. While paused it acknowledges verified deliveries with 2xx and cancels them without buffering for resume. Use \`ManageScheduledTasks\` with \`{ action: "get", task_id: "..." }\` to inspect \`webhookLastDelivery\` for this binding generation. A verified event received while paused is recorded as \`cancelled\`, not queued; its receipt proves arrival, not successful downstream execution. Verify one authentic representative ClickUp delivery; never fabricate verification.
7. Run carefully. Resume only after verification. Filter \`before\`/\`after\` changes, make writes no-ops when state already matches, make downstream effects idempotent, and prevent feedback loops from the automation's own ClickUp writes. Pause fences queued deliveries, not an automation run already admitted for execution. ClickUp may retry or duplicate delivery; this workflow makes no at-most-once or exactly-once promise.
8. Recover and clean up. PUT may change events or status while paused, but the callback URL cannot move and the location must stay unchanged; keep the returned secret server-side. Uncertain writes retain the previous encrypted secret but keep the endpoint unavailable until reconciled; a definite rejected request preserves the prior usable binding. Before trigger deletion, automation deletion, or ClickUp disconnect, pause and DELETE only the exact bound remote ID with the original \`accountId\`. Provider success or provider 404 clears the binding and revokes the endpoint. Failed or uncertain deletion keeps the binding and blocks trigger/automation removal; do not disconnect the account until cleanup succeeds. Account revocation outside this workflow is not fenced. An unrelated auth or mint 404 is not proof of deletion.

## Direct webhook requests

These are calls to the existing tool contract \`clickup_api(method, path, query?, body?, accountId?, webhookEndpointId?)\`.

GET inventory: \`method: "GET"\`, \`path: "/team/{team_id}/webhook"\`, exact \`accountId\`. Add \`webhookEndpointId\` only for paused reconciliation of an existing binding.

POST registration: \`method: "POST"\`, \`path: "/team/{team_id}/webhook"\`, body \`{ endpoint, events, optional one scope ID }\`, exact \`accountId\` and \`webhookEndpointId\`.

PUT update: \`method: "PUT"\`, \`path: "/webhook/{remote_webhook_id}"\`, body \`{ endpoint: same callback, events, status }\`, exact \`accountId\` and \`webhookEndpointId\`.

DELETE cleanup: \`method: "DELETE"\`, \`path: "/webhook/{remote_webhook_id}"\`, exact \`accountId\` and \`webhookEndpointId\`.

\`\`\`json
{"method":"GET","path":"/team/123/webhook","accountId":"canvas-clickup-account-id"}
{"method":"POST","path":"/team/123/webhook","body":{"endpoint":"https://sketch.example/api/webhooks/v1/sketch-webhook-endpoint-id","events":["taskStatusUpdated"],"list_id":123456},"accountId":"canvas-clickup-account-id","webhookEndpointId":"sketch-webhook-endpoint-id"}
{"method":"PUT","path":"/webhook/clickup-remote-webhook-id","body":{"endpoint":"https://sketch.example/api/webhooks/v1/sketch-webhook-endpoint-id","events":["taskStatusUpdated"],"status":"active"},"accountId":"canvas-clickup-account-id","webhookEndpointId":"sketch-webhook-endpoint-id"}
{"method":"DELETE","path":"/webhook/clickup-remote-webhook-id","accountId":"canvas-clickup-account-id","webhookEndpointId":"sketch-webhook-endpoint-id"}
\`\`\`

ClickUp's API budget is per token, including OAuth: 100 requests/minute on Free Forever, Unlimited, and Business; 1,000 on Business Plus; 10,000 on Enterprise. Share it across reads, enrichment, registration, reconciliation, and user work. On 429, stop and honor \`X-RateLimit-Reset\` (Unix seconds) or the returned cooldown; never blindly retry. A definite 401 may receive the runtime's single refresh attempt; a second 401 needs reconnect guidance. Do not invent webhook registration or monthly delivery quotas, and do not borrow ClickUp in-app Automation Actions limits for API webhooks.

Use health GETs when needed, not an automatic monitor. ClickUp treats responses over seven seconds as failures, retries temporarily failing events a limited number of times, does not replay exhausted events, has no documented health-change notification, immediately suspends on 401/410, and suspends after \`fail_count\` reaches 100. Re-enable only through the exact bound PUT after the endpoint is healthy.
`;

export async function ensureBuiltinManagedSkills(config: Pick<Config, "CLAUDE_CONFIG_DIR">): Promise<void> {
  const skills = [
    { id: "github", content: MANAGED_GITHUB_SKILL, marker: "provider-type: cli:github" },
    { id: "linear", content: MANAGED_LINEAR_SKILL, marker: "provider-type: api:linear" },
    { id: "clickup", content: MANAGED_CLICKUP_SKILL, marker: "managed-integration: clickup" },
  ];
  for (const skill of skills) {
    const skillPath = join(config.CLAUDE_CONFIG_DIR, "skills", skill.id, "SKILL.md");
    let existing: string | null = null;
    try {
      existing = await readFile(skillPath, "utf8");
    } catch {}
    if (existing?.includes(skill.marker) && existing.includes("requires-env:")) continue;
    await mkdir(join(config.CLAUDE_CONFIG_DIR, "skills", skill.id), { recursive: true });
    await writeFile(skillPath, skill.content, "utf8");
  }
}
