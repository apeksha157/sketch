# Habuild ClickUp cutover runbook

This package is the reviewable Sketch-side preflight for the Habuild ClickUp retirement. It does not contain customer-specific scripts, list mappings, custom-field mappings, ClickUp task IDs, remote subscription IDs, or guessed schedules. The replacement definitions must be supplied from an authorized Habuild export after the current definitions and revisions have been re-read.

## Current artifact

- Inventory: [`reconciliation-manifest.json`](./reconciliation-manifest.json)
- Offline checker: [`scripts/habuild-clickup-reconcile.mjs`](../../scripts/habuild-clickup-reconcile.mjs)
- Known workflow records: `6d02fee8-0f89-4e57-9a38-36cce2b4e8c4` revision 18, `54c1a727-960e-4ff7-9ad3-addc4a1a8763` revision 1, `24d58c62-212d-4fc9-b965-dce0e3b6c425` revision 0, and `13098123-a67f-4fd4-873d-1663e8002d2c` revision 2.
- Scheduled agent IDs are recorded in the manifest. Their revisions and exact ClickUp targets remain inputs to the authorized audit.

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
6. For task-created or task-updated input, use the least intrusive native ClickUp webhook supported by the request. Discover the exact workspace and hierarchy IDs through the managed API, choose the smallest explicit event set and scope, create the paused Sketch endpoint once, reconcile uncertain POSTs by inventory, and store the secret only in encrypted server state. Do not register a webhook per run or use a broad wildcard by default.
7. Verify an authentic signed delivery for the current endpoint generation while the workflow is paused. Confirm the binding account, workspace, callback, event, resource ID, receipt, and dedupe identity. Resume one workflow at a time only after registration, signed receipt, and remote health are separately confirmed.
8. For the Slack bug-report workflow, create one ClickUp task, retain its returned task ID, upload trusted local file bytes through the managed multipart request, and report task success separately from attachment success. Reconcile an uncertain upload against that task; never create a replacement task automatically. Confirm custom fields, fallback behavior, and no duplicate task.
9. Clean up only exact superseded Canvas-managed ClickUp subscriptions with the original account and owner. Preserve cleanup metadata on failure or uncertainty. Do not reconnect valid OAuth accounts and do not touch the separate ClickUp Files connector.
10. Verify Canvas retirement across direct action, workflow, MCP, dispatcher/worker, Pipedream, and Trigger.dev paths using safe rejection probes. Verify that OAuth account discovery, account sharing, authorization, credential minting, and unrelated actions still work. Do not deploy or merge from this worktree.

## Rollback boundary

Keep workflows paused on any mismatch, uncertain provider write, missing signing receipt, revoked account, rate limit, partial attachment result, or unexpected revision. Fix forward with a new expected revision or restore the affected workflow from a compatible protected backup. Do not restore a legacy Canvas ClickUp action while retirement enforcement is active. Code rollback alone does not undo remote subscriptions, PAT revocation, or provider-side writes.
