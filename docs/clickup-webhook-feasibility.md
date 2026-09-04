# ClickUp API webhooks: feasibility and skill contract

Date: 2026-09-03

Status: Skill-led implementation with local automated verification. No live ClickUp registration, activation, disconnect, or delivery verification was performed.

## Decision and scope

API-created ClickUp webhooks are a good fit for event-driven Sketch automations. The agent uses the existing managed `clickup_api` adapter with one optional opaque `webhookEndpointId` binding argument. The adapter stays thin and disposable until SKE-461.

This slice deliberately does not add a webhook-specific tool, a Canvas receiver, an experimental flag, a general provider-API overhaul, the SKE-458 resolver, or B3 pinned scripts. The native Sketch endpoint is the callback. Canvas remains the authorization/account-selection authority and supplies Canvas-minted, server-held OAuth credentials; raw tokens and ClickUp signing secrets do not enter model context, files, environment, or logs.

## Identity and admission gates

Keep these identifiers separate:

| Identifier | Meaning | Where it is used |
| --- | --- | --- |
| Canvas `accountId` | Opaque managed ClickUp account ID | `clickup_api` `accountId`; never replace it with a ClickUp ID |
| ClickUp `team_id` | ClickUp Workspace ID | `/team/{team_id}/webhook` |
| Sketch `taskId` | Sketch automation ID | `ManageScheduledTasks` and local ownership |
| Sketch `webhookEndpointId` | Opaque native Sketch endpoint ID | `clickup_api` binding; it is not an action or lifecycle command |
| ClickUp remote webhook ID | Provider registration ID | Exact `/webhook/{webhook_id}` PUT/DELETE path |

Webhook lifecycle calls are owner-only, must come from the matching automation authoring context, and require the automation to be paused. The automation must use `type: "webhook"`, `schedule_type: "external"`, and `schedule_value: "webhook"`. The managed ClickUp capability and exact opaque Canvas account must be available; multiple usable accounts require an explicit user choice.

Eligible existing Canvas-owned OAuth grants are reused silently: preserve the exact opaque account, credential owner, access/sharing fields, and Workspace permissions; mint in the acting user's Canvas context, then validate `/user` and a nonempty `/team` response. Every eligible account is checked, without selecting an arbitrary account or writing an adoption marker. Transient failures and `SHARD_009` stay inconclusive and untouched, not marked healthy or prompted to reconnect. Personal API tokens and existing automation definitions are not converted or rebound. Probes reuse a 60-second, actor/account/token-scoped in-memory result; discovery still checks current access each time, and probe requests share known token cooldowns with ordinary API work. ClickUp validation timeouts do not hide otherwise available GitHub/Linear capabilities.

The callback comes from the automation's returned `webhookUrl` and `webhookEndpointId`. `BASE_URL` must produce a public HTTPS URL. The ClickUp POST body's `endpoint` must equal that returned URL byte-for-byte. A localhost URL is not a public callback.

The existing `getProviderConfig` tool exposes only safe `managedAccounts` identity/owner labels for the same server-selected actor as credential minting. Resolve that actor as a complete identity: an explicit owner with a missing email must not inherit the viewer's email or credentials. Account discovery is not a health verdict; validate the selected account with a ClickUp Workspace read. No new account-discovery tool, raw credentials, or guessed IDs are needed.

## Official ClickUp API facts

All paths are relative to `https://api.clickup.com/api/v2`; ClickUp calls the Workspace path parameter `team_id`.

| Operation | Endpoint | Contract |
| --- | --- | --- |
| Inventory | `GET /team/{team_id}/webhook` ([reference](https://developer.clickup.com/reference/getwebhooks)) | Lists API webhooks created by the authenticated user in that Workspace |
| Register | `POST /team/{team_id}/webhook` ([reference](https://developer.clickup.com/reference/createwebhook)) | Requires `endpoint` and explicit `events`; accepts one location filter |
| Update | `PUT /webhook/{webhook_id}` ([reference](https://developer.clickup.com/reference/updatewebhook)) | Changes events/status; keep the callback URL unchanged for a Sketch binding |
| Remove | `DELETE /webhook/{webhook_id}` ([reference](https://developer.clickup.com/reference/deletewebhook)) | Stops the exact provider registration |

ClickUp API webhooks are tied to the user whose auth token created them. If that user is disabled or loses access to the relevant hierarchy, the registration can remain while it stops triggering. Only one location per hierarchy level can be supplied, and the lowest supplied level wins; a space plus list means the list scope, not the union. ([Webhook guide](https://developer.clickup.com/docs/webhooks))

Create, get, and update responses can contain the webhook signing `secret`. The adapter captures it into encrypted server storage and returns safe metadata only. `OAUTH_171` means a webhook already exists with the same configuration and location; it is a reconciliation signal, not a complete idempotency guarantee. ([Common errors](https://developer.clickup.com/docs/common_errors))

## Ordered workflow

1. Setup the automation. Use `ManageScheduledTasks` in the matching authoring context to inspect or create the Sketch automation, pause it, and confirm the native webhook trigger fields. Record the returned callback URL and opaque endpoint ID.
2. Select the subscription. Resolve the exact ClickUp Workspace ID, choose the narrowest useful explicit event names, and supply at most one optional space, folder, list, or task scope. For a status workflow, prefer `taskStatusUpdated` rather than an overlapping broad event set. The adapter requires explicit events, not a wildcard, so recovery can verify the subscription without maintaining a provider event catalog. Summarize the target and intended write before normal confirmation.
3. Inspect first. A GET without `webhookEndpointId` is a safe provider inventory/health read and does not mutate local state. After a registration attempt, a GET with the exact `accountId` and endpoint ID explicitly reconciles an existing reservation and one unique matching saved callback. `ManageScheduledTasks get` exposes safe `webhookBinding` metadata so cleanup does not depend on conversation memory. Zero or ambiguous matches stop the workflow. An already-bound endpoint cannot be POST-created twice.
4. Register once. Before the outbound POST, the server persists the provider, account, collection path (Workspace), callback, normalized requested events/location, and eventually remote resource ID on the existing owned endpoint. There is no separate subscription table or lifecycle tool. Then POST with the exact callback and account. Capture the returned secret server-side and encrypted. If the POST outcome is unknown, never repeat it; GET with the same endpoint and account. Recovery requires matching events and effective location as well as the callback and Workspace. A unique but different subscription retains only a pending cleanup binding, not readiness. If the registration is missing or ambiguous, keep the binding paused and stop.
5. Verify before activation. The native receiver verifies `X-Signature` as hexadecimal HMAC-SHA256 over the original request bytes before durable admission. ([Signature guide](https://developer.clickup.com/docs/webhooksignature)) Sketch hashes the event kind, webhook ID and sorted history item IDs, or falls back to the raw-body hash, for durable identity. While paused, acknowledge with 2xx and cancel/ignore the delivery rather than buffering it. Inspect `webhookLastDelivery` from `ManageScheduledTasks get`: it contains only the delivery/event IDs, receipt time, status, and endpoint generation. It never includes the payload or secret, and stale generations cannot count as proof. A paused receipt is `cancelled`; it proves authenticated arrival, not downstream execution. Confirm one authentic representative ClickUp delivery before claiming the integration works; never fabricate verification.
6. Run narrowly. Resume only after verification. Filter `before`/`after` changes, make already-satisfied writes no-ops, make downstream effects idempotent, and prevent feedback from the automation's own ClickUp writes. ClickUp documents overlapping emissions: task creation also sends `taskStatusUpdated`, and status changes also send `taskUpdated`. ([Task payloads](https://developer.clickup.com/docs/webhooktaskpayloads)) This contract makes no at-most-once or exactly-once side-effect promise.
7. Update safely. While paused, PUT may change events or status, but the callback and location cannot move. Use the exact bound remote ID, original account, and required same callback. Store any returned secret server-side; never surface it to the agent. Unknown outcomes retain the previous ciphertext in an unavailable endpoint for reconciliation; known rejected requests restore the prior binding. Activation and ingress share strict verification parsing and secret decryption checks.
8. Clean up before removal. Before deleting the trigger or automation, or disconnecting ClickUp, pause and DELETE only the exact bound remote ID with the original account. Provider success or a provider 404 clears the binding and revokes the endpoint. Failed or uncertain deletion keeps the binding and blocks trigger/automation removal. Cleanup before account disconnection is a skill-level ordering rule; this slice does not add an account-disconnect lifecycle engine or claim to fence external revocation. An unrelated authentication or credential-mint 404 is not proof that the provider registration was deleted.

## Existing `clickup_api` request shapes

These examples use placeholders, not credentials or signing secrets, and map directly to `clickup_api(method, path, query?, body?, accountId?, webhookEndpointId?)`:

```json
{"method":"GET","path":"/team/123/webhook","accountId":"canvas-clickup-account-id"}
{"method":"POST","path":"/team/123/webhook","body":{"endpoint":"https://sketch.example/api/webhooks/v1/sketch-webhook-endpoint-id","events":["taskStatusUpdated"],"list_id":123456},"accountId":"canvas-clickup-account-id","webhookEndpointId":"sketch-webhook-endpoint-id"}
{"method":"PUT","path":"/webhook/clickup-remote-webhook-id","body":{"endpoint":"https://sketch.example/api/webhooks/v1/sketch-webhook-endpoint-id","events":["taskStatusUpdated"],"status":"active"},"accountId":"canvas-clickup-account-id","webhookEndpointId":"sketch-webhook-endpoint-id"}
{"method":"DELETE","path":"/webhook/clickup-remote-webhook-id","accountId":"canvas-clickup-account-id","webhookEndpointId":"sketch-webhook-endpoint-id"}
```

The ClickUp update reference currently renders `events` as a string in its form/schema while its prose describes an array. Examples follow the prose and the adapter passes the bounded JSON body through. Mocked local tests do not resolve this provider documentation discrepancy: verify PUT against the real provider before claiming that path works end-to-end. ([Update reference](https://developer.clickup.com/reference/updatewebhook), [official OpenAPI v2](https://developer.clickup.com/openapi/clickup-api-v2-reference.json))

## Rate and recovery guidance

ClickUp's API limit is per token and applies to OAuth and personal tokens: 100 requests/minute on Free Forever, Unlimited, and Business; 1,000 on Business Plus; and 10,000 on Enterprise. Registration, inventory, reconciliation, enrichment, health reads, and ordinary user work share the same budget. A 429 exposes `X-RateLimit-Reset` as a Unix timestamp; stop until the reset/cooldown rather than blindly retrying. ([Rate limits](https://developer.clickup.com/docs/rate-limits))

Do not claim a numeric API-webhook registration cap, monthly API-webhook delivery allowance, per-delivery charge, or unlimited capacity from the reviewed ClickUp material. Do not borrow ClickUp in-app Automation Actions limits for Public API webhooks; ClickUp documents API webhooks and Automation webhooks as separate products. ([Product distinction](https://help.clickup.com/hc/en-us/articles/35313844961943-Integrate-ClickUp-using-Automation-webhooks), [Automation limits](https://help.clickup.com/hc/en-us/articles/23477062949911-Automations-feature-availability-and-limits))

ClickUp treats responses taking more than seven seconds as failures, retries a failing event a limited number of times, and does not replay exhausted events. The current health page says up to five attempts per event; do not build an exact-delivery guarantee on that wording. There is no documented health-change notification. HTTP 401 and 410 suspend immediately; `fail_count` reaching 100 suspends the webhook. Re-enable only with the exact bound PUT after the endpoint is healthy. ([Webhook health](https://developer.clickup.com/docs/webhookhealth))

## Storage and rollback

Migration 222 adds verification metadata, an encrypted signing secret, and a nonsecret source binding to the existing `webhook_endpoints` table. There is no per-provider subscription table or second delivery queue. `active_signed` endpoints require signature verification; pending, corrupt, or partially cleared bindings fail closed. Deletion clears the secret and source binding but retains the verification requirement, so reusing the endpoint cannot silently make it unsigned.

Downgrading migration 222 is blocked while any signed endpoint metadata remains. Clean up the remote registration with the original account, delete its Sketch automation, then downgrade. Never remove migration markers to run an old build against signed endpoints. Failed remote cleanup retains its local binding for explicit recovery.

Execution fencing follows the existing scheduler: committing the automation-run record under a task-row lock is the in-flight boundary. Pause/edit cancels stale queued deliveries, but does not retroactively stop a run already admitted for execution. Both receiver paths lock and recheck task/endpoint state before durable admission; unsigned requests retain their existing idempotency-header behavior. This change does not add an in-flight cancellation engine. ClickUp workflow agent steps use `agentMode: "sketch"` with `agentSkills: ["clickup"]`, so their existing capability gate is rechecked for execution.

## Future alignment boundary

Keep the ClickUp binding vocabulary and failure semantics compatible with the Linear SKE-455–477 provider-API project: opaque managed account identity, provider/resource binding, safe reconciliation, server-owned secrets, and explicit health/recovery boundaries may later become shared provider infrastructure. That project is an alignment boundary for future design, not a reason to expand this slice or create new tickets.

The current implementation remains the smallest disposable ClickUp adapter until SKE-461. SKE-458 resolver work and B3 pinned scripts stay outside this change. A future provider abstraction must preserve the direct request contract, exact account pinning, paused lifecycle gate, no-repeat-on-unknown-create rule, and cleanup-before-disconnect invariant.
