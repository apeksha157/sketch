# Automation benchmarks

## Goal and product contract

Make everyday automation requests succeed without technical coaching. The internal Platform Benchmarks tab runs batches of 3–10 scenarios, reports each outcome and the help needed, and retains frozen cases for repeat runs. It never treats an agent's completion message as proof.

Platform provides the superadmin UI and proxies to one explicitly configured e2e-test tenant. Sketch owns enrollment, generation, durable execution, evidence and cleanup. There is one worker boundary, not distributed orchestration across two databases.

Every model call inherits the current Sketch settings preset (currently GPT 5.6 Luna). APIs reject model overrides. Record a configuration fingerprint, and stop if it changes. Read-count cases freeze a hidden fixture count and require completed managed read evidence from the evaluated conversation; a correct tool-free guess fails. Alternate read transports without that evidence remain unsupported. Existing keys stay inside Sketch. No separate OpenRouter settings are added.

## Extensibility

Benchmarks is a feature-neutral area. Suite descriptors carry a stable key, feature name, supported integrations, version and coverage. Shared reports retain correctness assertions, usability observations, conversations and cleanup. The first release has three separate suites, with distinct required assertions and histories tagged by suite. New suites supply generation/execution/verifiers without adding top-level navigation items or changing run-history semantics.

## Implementation sequence

1. Versioned scenario contracts, additive portable persistence, strict verdict reducer and regression tests. Separate correctness, usability and cleanup.
2. ClickUp fixture/verification adapter: isolated lists under explicitly selected test Spaces, ordinary managed account authorization, real provider events, exact output counts and attachment content verification. Record resource intent before writes. Never delete by name prefix.
3. Existing builder route driver, fully drained streams, normal editing leases and bounded simulated-user answers. No direct replacement agent loop or hidden technical hints. Batch generation selects supported goals and plain-language variants; unsupported novelty cannot pass.
4. Durable sequential runner, cancellation, bounded observation windows, model-change detection and interrupted-run reconciliation. Never replay uncertain writes after process death.
5. Platform tab: connected account, test location, 3–10 workflows, draft/review, run, cancel, per-case conversation and evidence. No model selector. Frozen reruns compare the same inputs.
6. Whole-change independent review, SQLite/Postgres persistence checks, meaningful route/runner/verifier/UI tests, repository quality checks. Live tenant acceptance is a separate opt-in operation, not implied by mocked tests.

## Three separate benchmark areas

| Suite | Connection | Cases | Independent checks |
| --- | --- | --- | --- |
| Core automations | Sketch test identity only | Recurring note, calculation, checklist, CSV | Saved schedule, real scheduler execution, exact file contents, pause, resume |
| Integration capabilities | ClickUp test account | Count open tasks, create, rename, attach a file | Provider readback, exact object counts and identity, attachment bytes |
| Integration automations | ClickUp test account | New tasks, completion, high priority, two lists, attached brief | Actual scoped remote webhooks, real event delivery and execution, positive and negative outputs, pause |

Each suite supports 3–10 cases. Families are covered before adding distinct wording variants; ten cases do not imply ten distinct capabilities. Core tests require no external integration. The user chooses a suite, reviews the plain-language requests, then starts the batch. Results distinguish correctness, assistance needed, and cleanup. Scheduled tests use one-minute intervals so the pipeline can observe actual ticks within bounded runtime; they do not claim timezone/DST coverage.

## Integration automation cases

Five versioned event-driven goal families: new-task follow-up, completion follow-up, high-priority filtering, multiple source lists, and follow-up with a file. An agent chooses a balanced batch of 3–10 scenarios with plain-language wording. Batches above five include distinct variants; reports retain family/variant IDs and make this visible. Add future integrations via adapters with explicit supported families. Scheduled digests, semantic summaries, cross-integration flows and browser usability are uncovered until their independent verifiers exist.

The generator sees business goal templates, not assertions. The evaluated builder sees only the rendered user request, attachment and user facts. The simulated user may select a named location or answer a business preference; it cannot choose webhooks, write API code, explain errors or invent missing facts. Bound clarification rounds and report technical questions separately.

## Accuracy requirements

Pass requires persisted evidence for every required assertion. Missing/unsupported evidence is unverified; infrastructure or setup failure is blocked; an observed incorrect effect is failed. Cleanup failure cannot disappear behind a functional pass. No weighted score hides scope, duplicate or attachment failures.

Verify remote subscriptions as well as Sketch bindings; prefer appropriately scoped events without telling the builder to use webhooks. Exercise positive and negative events and retain the observation window. Count all destination objects, not just the first match. Confirm output title and source correspondence, real delivery receipt and successful execution. Read attachment metadata through the authorized provider connection, then download only allowlisted HTTPS attachment URLs without forwarding provider credentials and compare content hashes. A manual run does not count as proof of a scheduled trigger.

Freeze prompt, family version, facts and preset fingerprint before execution. Repeats reuse frozen cases with fresh fixtures. Report sample size and coverage: a single batch is evidence, not a statistical guarantee.

## Safety, durability and accepted limits

Platform is superadmin-only. Its shared ops login is an operator account, not a human identity or the owner of a connection. A superadmin generates a single-use, 30-minute setup URL. The token lives in the URL fragment and only a hash is stored. The link grants no login authority. The recipient must sign in to e2e-test and connect their own account through the existing Integrations flow. They explicitly consent to benchmark-team use of that profile and choose dedicated test Spaces. Existing connections can be selected without reconnecting. Core-only enrollment shares a Sketch test identity without asking for ClickUp.

The setup page links directly to `/integrations?connect=clickup` and Platform provides both Open setup and Copy link. Once enrolled, authorized Platform operators select the shared test profile; every run records the connection owner and the initiating Platform account. A shared ops account cannot identify which human used it. Credentials remain in the existing managed resolver.

Only a user opting in with their own connected identity can enroll. Use a dedicated test account/identity and selected test Spaces; a e2e-test tenant alone does not isolate provider data or existing agent memory. Platform admin status grants no arbitrary identity override. Provider credentials never enter reports or model context.

Persist run/case state and resource intent before side effects. Only a database claim may start a run; one active run per enrolled owner prevents conflicting cases. A process interruption is not automatically replayed. Cleanup reconciles exact recorded objects, pauses owned automations and removes exact run callback registrations. Ambiguous writes remain visible for inspection. Cleanup recovers unknown IDs only from exact persisted markers. If an uncertain write cannot be recovered, an operator may explicitly attest that the exact resource is absent; this is recorded as manual, unverified evidence and never creates a passing result. Cleanup must then be retried before releasing the identity lock. Never infer ownership from a name alone.

Bound batch size, turns, provider calls, runtime and response sizes. Cancellation stops the builder via its normal interruption endpoint and still attempts cleanup. Preserve evidence and separate interrupted/cleanup-needed state. No production deployment, automatic release gates or live provider runs are part of code implementation.

## Rollout and acceptance

Read-only AWS verification on September 7, 2026 confirmed stack `sketch-tenant-e2e-test`, ECS service of the same name, one running task on task definition `sketch-e2e-test:65`, image `sketch:1.7.1`, and log group `/sketch/e2e-test`. That release does not include this feature. The tenant UUID is resolved from the Platform registry by explicit `BENCHMARK_TENANT_ID` or exact slug `e2e-test`; no UUID was inferred from infrastructure naming.

1. Merge/release the required ClickUp and benchmark changes in Sketch, and the Platform changes. This PR contains only benchmark changes stacked on PR #653 (feat/tool-activity-timeline-stack). ClickUp integration enhancements are owned by their separate PR. Benchmark migration 231 follows main's migration 230 and is additive. The multiple-list benchmark can reveal the current single-binding limitation until the integration changes land.
2. Update the e2e-test tenant CloudFormation template once so its new `BenchmarksEnabled` parameter exists. The deployer enables it only for the configured benchmark tenant; other tenants receive false. A normal image-only update of the old template cannot introduce the new flag.
3. Deploy a Sketch release containing the system benchmark and authenticated setup routes. Keep the existing model preset and keys in Sketch settings. Platform adds no model control. Confirm the returned preset is the intended GPT 5.6 Luna preset before a run.
4. Open Platform `/admin/benchmarks`, create a setup link, and enroll a dedicated e2e-test identity. For ClickUp, choose dedicated test Spaces; choose two different Spaces to exercise the cross-Space scenario.
5. Run three cases in Core automations, then Integration capabilities, then Integration automations. Confirm real event/scheduler evidence, correct attachment bytes, and complete cleanup. Repeat the frozen batch before comparing revisions.
6. Expand to ten cases after the first live acceptance. Preserve failed conversations and evidence. No live result is claimed from unit, mocked HTTP, database or component tests.

Known coverage limits are returned by the suite catalogue and shown in the UI. This initial version does not verify arbitrary provider mutations outside its fixture lists, arbitrary new prompt semantics, pagination workloads, DST, browser UX, cross-integration workflows or semantic summary quality. A dedicated test identity/account is required because the evaluated agent retains its normal permissions and tools. New integrations need explicit fixture/verifier adapters; they do not become supported merely by appearing in the connection list.

References: ClickUp official Create List, Create Task, Get Task and Get Webhooks API documentation, verified September 7, 2026.

## Initial implementation verification (before benchmark-only rebase)

September 7, 2026: both repositories passed formatting, type checks and production builds. Sketch's full server run passed 6,928 tests (22 existing live-provider tests skipped), and its web run passed 660 tests. The focused benchmark checks additionally cover migration compatibility, worker fencing, manual reconciliation, system/profile authorization, provider-outage cleanup and read-oracle calibration. Platform's full API, web and infrastructure tests passed; added proxy authorization and target-only deployment regressions also passed.

A real-browser smoke check loaded the production-built Platform UI against isolated HTTP fixtures. It exercised suite selection, draft batches and separate histories, core tests without an integration requirement, and the connection-link surface; there were no console errors. Full-page local artifacts are in `output/playwright/benchmarks-core.png` and `output/playwright/benchmarks-integrations.png`. These show test responses and unexecuted drafts, not live benchmark results. The temporary server/browser were stopped afterward.

No live model, ClickUp webhook, attachment or scheduler benchmark has been run on e2e-test as part of this implementation. Run the acceptance sequence above after release. The first provider adapter is ClickUp; the core suite needs no provider. Other integrations reuse the batch/driver/evidence/lifecycle infrastructure but need their own explicit fixtures and outcome verifiers before being advertised as supported.

## Benchmark-only PR scope verification

The benchmark commits were first isolated onto main in both repositories; Sketch is now stacked on PR #653, while Platform targets main. ClickUp integration implementation, builder recovery, and private-repository authentication changes are excluded. Migration 231 adds only benchmark tables. After rebasing, 141 focused Sketch benchmark/migration tests passed, along with server/web type checks and changed-file formatting checks. Platform passed 59 benchmark/deployer tests, 4 benchmark UI tests, 72 tenant-stack tests, type checks and changed-file formatting checks. Full unrelated suites were not rerun for the scope-only update.
