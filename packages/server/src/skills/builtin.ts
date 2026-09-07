import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";

export const MANAGED_LINEAR_SKILL = `---
name: Linear
description: Use Linear through the Sketch Linear GraphQL tool with Canvas OAuth.
category: engineering
canvas-account: linear
---

# Linear

Use the Sketch \`linear_api\` tool for Linear work. The request executes inside the trusted Sketch process against Linear's GraphQL API. Canvas is the OAuth vault and returns only a short-lived access token; Sketch never receives or stores a refresh token. Select an opaque Canvas account when more than one usable account is available.

## Safe workflow

1. Read before writing. Resolve the target team, project, or issue with a bounded \`linear_api\` query before changing it.
2. For writes, show the intended title, description, target team, and issue identifier before asking for normal user confirmation.
3. If account resolution is ambiguous, ask the user to choose the Canvas account; never fall back to another owner or workspace.
4. Keep queries and variables bounded. Explain provider errors plainly. The tool refreshes once on a definite 401 and never retries 403, 429, network, or GraphQL errors. Never log headers, access tokens, refresh tokens, or connector configuration.
`;

export const MANAGED_GITHUB_SKILL = `---
name: GitHub CLI
description: Use GitHub through Sketch's managed local GitHub CLI tool with Canvas OAuth.
category: engineering
canvas-account: github
---

# GitHub CLI

Use the Sketch \`github_cli\` tool for GitHub work. Sketch executes \`gh\` locally; Canvas is only the OAuth vault and account-selection authority. Trusted Sketch server code receives the access token, injects it only into the \`gh\` child process as \`GH_TOKEN\`, and never exposes it to the agent. Refresh tokens remain in Canvas.

## Safe workflow

1. Start with discovery. Use \`repo view OWNER/REPO\`, \`issue list\`, \`pr list\`, or another read-only command to identify the target before reading it.
2. Prefer JSON output and \`--jq\` for stable, concise results. Keep result sizes bounded.
3. Pass \`--repo OWNER/REPO\` explicitly whenever the target is not unambiguous.
4. Read before writing. For issues, pull requests, workflows, and releases, show the intended target and change before asking for normal user confirmation.
5. The local runner rejects authentication/configuration commands, credential flags, arbitrary hosts, and environment inspection.
6. If more than one usable account exists, pass the selected opaque Canvas account ID or ask the user to choose one.

Never use raw HTTP authorization headers, raw tokens, token-printing commands, or commands that expose the process environment.
`;

export const MANAGED_CLICKUP_SKILL = `---
name: ClickUp
description: Use ClickUp through Sketch's managed ClickUp API tool with Canvas authorization.
category: productivity
managed-integration: clickup
---

# ClickUp API

Use the Sketch \`clickup_api\` tool for ClickUp work, or the \`clickup\` capability from a deterministic action script. The managed-integration gate must be available for this run. Canvas owns authorization and account selection and supplies a Canvas-minted, server-held OAuth credential for the request. Never ask for or use a PAT, raw token, Canvas CLI/MCP, token-bearing URL, shell command, or workspace file for ClickUp authentication. The separate ClickUp Files connector may use a PAT; it does not authorize this skill. Credentials and webhook signing secrets stay out of model output, files, environment, and logs.

Eligible existing Canvas OAuth connections are reused automatically after credential minting and read-only identity/Workspace validation. Do not ask users to reconnect just to adopt an existing grant. A timeout, 429, or \`SHARD_009\` Workspace response is inconclusive, not proof of revocation. Leave those connections and existing automations untouched; report the verification boundary without treating it as a healthy connection.

## Ordinary API work

Read before writing. Discover accessible Workspaces with \`GET /team\`, then spaces with \`GET /team/{team_id}/space\`, folders with \`GET /space/{space_id}/folder\`, and lists with \`GET /folder/{folder_id}/list\` or \`GET /space/{space_id}/list\`. Use \`GET /list/{list_id}/task\` or \`GET /task/{task_id}\` for bounded task reads. Resolve the user's meaning of "boards" from this hierarchy instead of inventing a board endpoint. The managed transport accepts an ordinary API recipe: \`method\`, provider-relative \`path\`, bounded \`query\`, JSON \`body\`, exact opaque \`accountId\`, and optional trusted local \`files\` for the task-attachment endpoint. It is intentionally not a fixed operation catalog; use the current ClickUp API documentation and the same transport for an endpoint not shown here. Paginate as needed; use exact returned IDs, small query parameters and JSON bodies. Summarize the target and intended change before normal confirmation for writes. Ordinary reads and task updates do not need a webhook or automation.

For a task with local attachments, create the task once, retain the returned task ID, then call \`POST /task/{task_id}/attachment\` with \`files: [{ path, filename?, contentType? }]\`. Pass server-provided trusted local paths only; do not read, base64-encode, URL-fetch, or put bytes in a script or prompt. If an upload fails after task creation, report the task ID and attachment state and reconcile that task before retrying. Never create a second task to compensate for an uncertain upload. Direct task attachments do not emit ClickUp \`taskUpdated\`; do not invent an attachment-added event. Use a comment attachment, File custom field, or explicit bounded polling only when that is the actual requested provider behavior.

For event-driven action steps, Sketch supplies a trigger envelope: unwrap \`input.data\` when \`input.source === "webhook"\`, then read the provider event and \`history_items\`. A "marked complete" rule checks an actual status transition in the event's before/after values, using statuses discovered for the selected list. Re-reading the task verifies access and scope; its current status alone cannot prove that this event completed it. Ignore unrelated changes, transitions out of completion, and incomplete event data.

For follow-up creation, carry a stable source-task marker into the destination. Search all destination pages, including closed tasks, before creating; if a safety bound is reached, report incomplete reconciliation instead of treating absence on the first page as proof. Keep the source event identity and returned destination task ID in step outputs. Before attaching on a retry, inspect that destination's attachments and reconcile the expected filename and size with the saved upload result. If already present, return a no-op; if ambiguous, report the existing task and uncertain attachment state. Never blindly re-upload after finding an existing follow-up. For uncertain creation, inspect the marker before another POST. These are API recipe responsibilities, not a fixed workflow catalog.

For deterministic steps, declare \`actionCapabilities: { sketchTools: ["clickup"], usesIntegrationActions: false }\`. Ordinary provider HTTP errors and uncertain uploads can be caught by the script to preserve partial success; uncaught errors fail the step. Authorization, invalid arguments, file containment, and cancellation failures remain fatal.

## Native webhook automations

Keep these IDs distinct:

- \`accountId\`: the opaque Canvas ClickUp account ID. Pass the exact value returned by the managed integration; never substitute a ClickUp ID.
- \`team_id\`: ClickUp's Workspace ID, used in API paths such as \`/team/{team_id}/webhook\`.
- \`task_id\`: the Sketch automation ID passed to \`ManageScheduledTasks\`, not a ClickUp task ID. Binding metadata calls it \`taskId\`.
- \`webhookEndpointId\`: the opaque native Sketch endpoint ID returned with the automation's webhook URL. It is the optional binding argument to \`clickup_api\`, not an action or lifecycle command.

For multiple disjoint targets, keep one automation and use one native endpoint per provider subscription. Use the original \`default\` slot for the first target. Call \`ManageScheduledTasks\` with \`{ action: "ensureWebhookEndpoint", task_id, webhook_slot: "list-EXACT_ID" }\` for each additional list while paused. Slots are stable and idempotent: retry with the same slot instead of making another endpoint. Register each returned callback separately with the exact account, event set, and list scope through \`clickup_api\`. Do not broaden disjoint list targets to a Workspace subscription when they span Spaces. There are at most 32 slots per automation; ask about a different design if the request exceeds that bound.

\`ManageScheduledTasks get\` exposes \`webhookEndpoints\`, including each slot's callback, binding, readiness, and last delivery. Every intended slot must have a validated registration before resume. Retired slots are excluded only after their remote binding is deleted; use \`retireWebhookEndpoint\` for an unused slot. If named slots already cover every requested target and the default is unused, retire the default slot with the same tool once another source is connected. Preserve working subscriptions; an unused slot is not a reason to delete and recreate them. Re-read metadata after setup and report completion only when every intended source is ready. Pause applies to the whole automation; cleanup, trigger replacement, and deletion must cover every remote binding. Each endpoint verifies its own signature and deduplicates its own deliveries. Choose disjoint scopes: overlapping subscriptions can deliver the same event more than once across endpoints, so preserve downstream idempotency.

## Safe workflow

1. Gate and resolve. Use the existing \`getProviderConfig\` tool's \`managedAccounts\` to discover the exact opaque \`accountId\` and owner label. This is discovery metadata, not proof of Workspace access: read \`GET /team\` with the selected account before setup. Confirm the managed ClickUp capability; reuse the account already pinned to this automation; if several usable accounts still match the requested target, ask the user to choose. Only the automation owner in the matching authoring context may manage its webhook.
2. Set up the Sketch endpoint. Use \`ManageScheduledTasks\` to inspect or create the automation, pause it, and confirm \`type: "webhook"\`, \`schedule_type: "external"\`, and \`schedule_value: "webhook"\`. For agent steps that use ClickUp, set \`agentMode: "sketch"\` and \`agentSkills: ["clickup"]\`; light steps do not have this managed API. Use the returned \`webhookUrl\` and \`webhookEndpointId\`; the URL must be a public HTTPS URL from \`BASE_URL\`, and the ClickUp POST body \`endpoint\` must match it exactly. Never use localhost as the public callback.
3. Choose a narrow subscription. Resolve the ClickUp \`team_id\`, then choose explicit event names and at most one optional hierarchy scope (space, folder, list, or task). Prefer the smallest event set; do not use \`*\` unless the user explicitly requires a workspace-wide subscription and the provider contract makes that the only correct choice. Summarize the target and intended write, then obtain normal confirmation.
4. Inspect before creating. First GET inventory without \`webhookEndpointId\`; this is a safe read and does not mutate local state. For a previously attempted registration, inspect \`ManageScheduledTasks get\` for the persisted \`webhookBinding\` (original account, collection path, callback, requested events/location, and remote resource ID), then GET with that account and \`webhookEndpointId\` to reconcile. This bound GET requires an existing reservation and exactly one matching saved callback, Workspace, events, and location; stop on zero or multiple matches. A uniquely identified webhook with a different/malformed subscription or unusable secret stays pending with its cleanup ID, never active. An existing bound endpoint must not receive a second POST.
5. Register once during setup, never once per automation run. The adapter records the nonsecret binding before the outbound POST and captures the returned signing secret into encrypted server storage. Use the direct API request below, not an action field. If POST is uncertain, do not repeat it: GET with the same endpoint and account to reconcile. If ClickUp returns \`OAUTH_171\`, reconcile the existing configuration instead of posting again. If the result is missing or ambiguous, leave the binding paused and stop.
6. Validate registration before activation. An exact matching account, Workspace, callback, subscription, active remote health, and encrypted signing secret make the binding ready. A valid quiet webhook can be resumed while awaiting its first delivery; never create a sacrificial customer task or require a first event to activate it. A signed event cannot make a rejected or uncertain registration ready. Inspect safe metadata only. The native receiver verifies \`X-Signature\` as HMAC-SHA256 over the original request bytes before durable admission, hashes the event kind, webhook ID, and sorted history item IDs when present, otherwise the raw body, for durable dedupe. While paused it acknowledges verified deliveries with 2xx and cancels them without buffering for resume. Use \`ManageScheduledTasks\` with \`{ action: "get", task_id: "..." }\` to inspect \`webhookLastDelivery\` for this binding generation. A verified event received while paused is recorded as \`cancelled\`, not queued; its receipt proves arrival, not successful downstream execution. Report delivery as awaiting first delivery until an authentic event arrives; verify that event when available and never fabricate verification.
7. Run carefully. Resume only after registration is validated. Filter \`before\`/\`after\` changes, make writes no-ops when state already matches, make downstream effects idempotent, and prevent feedback loops from the automation's own ClickUp writes. Pause fences queued deliveries, not an automation run already admitted for execution. ClickUp may retry or duplicate delivery; this workflow makes no at-most-once or exactly-once promise.
8. Recover and clean up. PUT may change events or status while paused, but the callback URL cannot move and the location must stay unchanged; keep the returned secret server-side. Uncertain writes retain the previous encrypted secret but keep the endpoint unavailable until reconciled; a definite rejected request preserves the prior usable binding. Before trigger deletion, automation deletion, or ClickUp disconnect, pause and DELETE only the exact bound remote ID with the original \`accountId\`. Provider success or provider 404 clears the binding and revokes the endpoint. Failed or uncertain deletion keeps the binding and blocks trigger/automation removal; do not disconnect the account until cleanup succeeds. Account revocation outside this workflow is not fenced. An unrelated auth or mint 404 is not proof of deletion.

## Direct webhook requests

These are calls to the existing flexible tool contract \`clickup_api(method, path, query?, body?, accountId?, webhookEndpointId?, files?)\`. The action-script equivalent is \`ctx.tools.clickup({ method, path, query, body, accountId, files })\`; it requires the exact admitted account ID and never exposes the credential. \`files\` is accepted only for a task attachment request and contains trusted local file descriptors, not bytes.

GET inventory: \`method: "GET"\`, \`path: "/team/{team_id}/webhook"\`, exact \`accountId\`. Add \`webhookEndpointId\` only for paused reconciliation of an existing binding.

POST registration: \`method: "POST"\`, \`path: "/team/{team_id}/webhook"\`, body \`{ endpoint, events, optional one scope ID }\`, exact \`accountId\` and \`webhookEndpointId\`. A validated registration returns an active_signed binding and permits activation; delivery verification is reported separately as awaiting_first_delivery. A rejected or uncertain registration stays pending until explicit reconciliation succeeds.

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
    { id: "github", content: MANAGED_GITHUB_SKILL, marker: "canvas-account: github" },
    { id: "linear", content: MANAGED_LINEAR_SKILL, marker: "canvas-account: linear" },
    { id: "clickup", content: MANAGED_CLICKUP_SKILL, marker: "managed-integration: clickup" },
  ];
  for (const skill of skills) {
    const skillPath = join(config.CLAUDE_CONFIG_DIR, "skills", skill.id, "SKILL.md");
    let existing: string | null = null;
    try {
      existing = await readFile(skillPath, "utf8");
    } catch {
      existing = null;
    }
    if (existing?.includes(skill.marker)) continue;
    await mkdir(join(config.CLAUDE_CONFIG_DIR, "skills", skill.id), { recursive: true });
    await writeFile(skillPath, skill.content, "utf8");
  }
}
