# Habuild ClickUp cutover runbook

The authorized read-only Habuild export from September 7 contains 43 ClickUp-related automations. Concrete paused replacement definitions are prepared for all 12 currently active records: four deterministic workflows and eight scheduled agents. The protected package contains the exact original export, original and replacement scripts, canonical Sketch save requests, owner/account bindings, expected revisions, hashes, and offline recipe checks. Customer scripts and field/people mappings remain outside Git in the protected `habuild-private` artifact directory linked in the implementation handoff.

## Prepared artifacts

- Inventory and per-definition hashes: [`reconciliation-manifest.json`](./reconciliation-manifest.json).
- Offline inventory checker: [`scripts/habuild-clickup-reconcile.mjs`](../../scripts/habuild-clickup-reconcile.mjs).
- Canonical schema/script validator: [`scripts/habuild-clickup-validate.ts`](../../scripts/habuild-clickup-validate.ts). It validates local bundles and adds their canonical `request`; it never contacts a service or executes a workflow script.
- Four workflow IDs/revisions: `6d02fee8-0f89-4e57-9a38-36cce2b4e8c4`/18, `54c1a727-960e-4ff7-9ad3-addc4a1a8763`/1, `24d58c62-212d-4fc9-b965-dce0e3b6c425`/0, `13098123-a67f-4fd4-873d-1663e8002d2c`/2. All eight scheduled-agent revisions are also recorded in the manifest.
- The six-list subtask workflow spans two ClickUp Spaces, verified through authorized API reads. Its replacement uses six disjoint list subscriptions under one automation: the existing `default` endpoint plus five stable `list-ID` slots. It does not broaden scope to a Workspace or Space. The other two event workflows each retain one default slot and their original requested scope.
- Slack remains the bug-report source. The script preserves input parsing and field mappings, resolves People fields to provider member IDs, applies custom fields through their native endpoint, uploads trusted local files, and retains the created task ID on partial failure. Subtask recipes preserve the configured lists, field offsets, template wait, and names, use native payloads and pagination, and avoid repeated no-op updates. The recording script maps native task/history IDs without adding unnecessary provider reads.
- All replacements are paused at cutover. `resumeAfterValidation` is false for the previously incomplete setup workflow; the other 11 may resume only after their production checks. Owners, stable step IDs, delivery targets, schedules and timezones are preserved. No production definitions or subscriptions were changed during preparation.

Validate the protected package before review:

```bash
pnpm exec tsx scripts/habuild-clickup-validate.ts /protected/habuild-private/replacements
node /protected/habuild-private/test-replacements.mjs
```

The offline recipe check exercised 14 synthetic cases against the exact replacement scripts. It covers member fallback, partial attachments, pagination, native payloads, due-date translation and duplicate prevention. This is not a claim of live task creation, upload, or signed delivery.

## Safe preflight

The utility accepts a scrubbed, read-only workflow snapshot and is dry-run only. It compares the exact IDs, expected revisions, and expected statuses in the manifest. It never connects to Sketch, Canvas, Habuild, ClickUp, PostgreSQL, or Slack and it has no apply mode.

```bash
node scripts/habuild-clickup-reconcile.mjs \
  --snapshot /path/to/scrubbed-habuild-workflow-snapshot.json \
  --backup-dir /path/to/protected-local-preflight-backups
```

Use `--expected-revision WORKFLOW_ID=REVISION` when an operator has re-read a revision and wants an additional command-line fence. The command exits non-zero for missing or drifted known records. Its optional local backup contains only IDs, revisions, statuses, and schedule columns; it is not a PostgreSQL backup.

## Required production-window gates

1. Re-read Habuild workflow definitions, revisions, status, owners, schedules, target hierarchy IDs, custom-field mappings, active/paused state, and current run watermarks. Re-read the eight scheduled agents and identify any additional active ClickUp records. Do not derive mappings from names when exact IDs are available.
2. Take a protected PostgreSQL logical backup and verify restore. Back up the Sketch configuration/key material, credential/config files, required workspace state, graphs/content/revisions, and the exact original service commit. Keep those backups outside the application workspace with access controls appropriate to production secrets.
3. Inventory exact old Canvas subscription IDs, callback scopes, owner/account bindings, admitted and queued deliveries, and any in-flight runs. A Canvas 410 does not delete a ClickUp subscription.
4. Pause the affected workflows and suspend old delivery. Drain admitted runs and capture the event-gap watermark. Paused native webhook deliveries are acknowledged and cancelled; they are not buffered for resume.
5. Apply only approved replacement definitions through the supported persistence path with an expected-revision check for every record. Preserve creator, owner, platform, destination, timezone, schedule, stable step IDs, idempotency behavior, missing-member fallback, and unrelated fields. Abort on revision drift rather than overwriting newer work.
6. For multi-list input, provision every intended endpoint while paused using `ManageScheduledTasks` action `ensureWebhookEndpoint`, the automation ID, and each recipe's stable `webhook_slot`. Repeating a slot retrieves the same endpoint. Register each returned callback with its exact list scope through `clickup_api`; never register per run. `get` exposes the complete `webhookEndpoints` array. For task-created or task-updated input, use the least intrusive native ClickUp webhook supported by the request. Discover the exact workspace and hierarchy IDs through the managed API, choose the smallest explicit event set and scope, create the paused Sketch endpoint once, reconcile uncertain POSTs by inventory, and store the secret only in encrypted server state. Do not register a webhook per run or use a broad wildcard by default.
7. Confirm the exact binding account, workspace, callback, events, scope, resource ID, encrypted signing secret, and active remote health. Resume one workflow at a time after registration is validated. A quiet webhook may be activated while awaiting its first delivery; do not create sacrificial customer data. Verify the first authentic delivery and dedupe identity when it arrives. A receipt does not make a rejected registration valid.
8. For the Slack bug-report workflow, create one ClickUp task, retain its returned task ID, upload trusted local file bytes through the managed multipart request, and report task success separately from attachment success. Reconcile an uncertain upload against that task; never create a replacement task automatically. Confirm custom fields, fallback behavior, and no duplicate task.
9. Clean up only exact superseded Canvas-managed ClickUp subscriptions with the original account and owner. Preserve cleanup metadata on failure or uncertainty. Do not reconnect valid OAuth accounts and do not touch the separate ClickUp Files connector.
10. Verify Canvas retirement across direct action, workflow, MCP, dispatcher/worker, Pipedream, and Trigger.dev paths using safe rejection probes. Verify that OAuth account discovery, account sharing, authorization, credential minting, and unrelated actions still work. Do not deploy or merge from this worktree.

## Rollback boundary

Migration 229 preserves existing callback IDs and delivery history while permitting multiple endpoint slots. SQLite rebuilds the endpoint and delivery tables inside the migration transaction; PostgreSQL replaces the unique constraint. Downgrade refuses while additional slots exist. Once additional subscriptions are provisioned, an older binary is not a safe code-only rollback: clean up all remote subscriptions and restore compatible definitions/storage from the protected backup first.

Keep workflows paused on any mismatch, uncertain provider write, revoked account, rate limit, partial attachment result, or unexpected revision. Fix forward with a new expected revision or restore the affected workflow from a compatible protected backup. Do not restore a legacy Canvas ClickUp action while retirement enforcement is active. Code rollback alone does not undo remote subscriptions, PAT revocation, or provider-side writes.
