# Tool activity and timeline improvement plan

Status: implemented locally with verification record. The sections below describe the implemented web activity timeline behavior and the remaining accepted boundaries.

## Outcome and scope

Friendly and Technical should describe the same actual activity with different levels of detail. Users should be able to tell which tool or integration is involved, what is still running, what finished, and whether Sketch needs attention. Technical details must be inspectable beyond the one-line preview. Preserve Off mode's existing Thinking label and event suppression behavior.

**Visual constraint:** preserve the current timeline layout, spacing, typography, colors, icon dimensions, animations, and three-row window. Add usefulness within the existing visual language; no sidebar, permanent inspector, or redesigned chat. Expanded detail is opt-in.

Primary surfaces: web chat and the automation builder, which share the timeline component. Preserve Slack's existing presentation and transport behavior while reusing semantic helpers where appropriate. This is an activity display improvement, not a change to execution, permissions, retry policy, model reasoning generation, or runtime limits.

## Pre-implementation findings

- `packages/server/src/agent/tool-progress.ts`: `MAX_ARG_LENGTH = 40` and `progressItem()` truncate detail before transport. `buildTechnicalLine()` also clips; Canvas commands are reduced to a parsed subcommand/target. Expanding the current UI alone cannot recover the original command.
- The same file maintains several overlapping label tables and separate web and text renderers. Friendly web output deliberately drops targets, labels integration-related skill loading as “Running integration,” and returns “Running integration” for every MCP server. `ManageScheduledTasks` is labeled before the action can distinguish list/create/update. Canvas detection relies on a `$CANVAS_CLI` regular expression and splits on shell punctuation without respecting quotes.
- `packages/shared/src/web-chat.ts`: progress items carry label, kind, icon, detail, and tool name, but no stable invocation ID, lifecycle status, or timing. Icon types cannot currently represent an integration image.
- `packages/server/src/agent/runner.ts`: SDK tool-use IDs and result/error events are available internally, but the public progress stream forwards starts and intermediate text. The alternative runtime has start/end hooks; its invocation correlation needs to be carried through explicitly.
- `packages/server/src/api/web-chat.ts`: progress uses incrementing part IDs; transcript sanitizers explicitly select known fields. Every new field must survive storage and replay as well as live streaming.
- `updateWebChatProgressMessage()` replaces the in-progress message with the latest snapshot. Reliable live-history restoration requires persisting the bounded activity snapshot, not only enriching that last item. The builder's `onToolResult` compares whole result events for repeated failures; adding volatile IDs/timestamps to that existing object would change its safety behavior.
- `packages/web/src/components/sketch/chat-thread.tsx`: the latest entry is treated as active, detail uses CSS `truncate`, and only the latest three progress entries appear in the live window. Completed activity has a separate collapsible history with a 260px scroll limit. There is no per-row details interaction.
- `packages/server/src/integrations/canvas.ts`: `listApps()` already normalizes Canvas catalog `imgSrc` into `IntegrationApp.icon`. The frontend already has `components/connections/app-icon.tsx`; integration connection cards also receive app identity and icons.
- `packages/web/src/routes/chat.tsx` and `automation-builder.tsx` each adapt progress data; both must preserve the new fields.

## User experience

Keep the live timeline compact, with three recent rows by default. Each row has an app/tool icon, action label, optional safe target, and explicit state. Integration branding remains visible while running; show a separate small activity indicator instead of replacing the brand icon with a spinner.

| Actual operation | Friendly presentation | Technical presentation |
| --- | --- | --- |
| Load an integration skill | Loading GitHub instructions, if identity is established; otherwise Loading integration instructions | Exact Skill tool name and inspectable skill argument |
| Search app catalog | Finding integrations | Exact tool name and command/arguments |
| Discover actions for an app | Finding available GitHub actions | Exact discovery command/arguments |
| Execute a verified issue-search action | Searching GitHub issues | Exact invocation, GitHub icon, expandable command/arguments |
| Execute a verified create-issue action | Creating GitHub issue → Done or Failed from the backend outcome | Exact invocation and explicit outcome state |
| List scheduled tasks | Listing scheduled tasks | ManageScheduledTasks with action=list |
| Read a file | Reading notes.md, using an approved display target | Read with inspectable path |
| Unknown shell command | Running command | Bash with full display-safe command |
| App known, action unresolved | Using GitHub | Exact underlying tool and inspectable invocation |
| Integration identity unresolved | Running integration tool | Exact qualified tool name; generic integration icon |

These examples require verified operation metadata. Do not infer success or a business action from an arbitrary humanized identifier. A tool returning without transport error may still report an application error; use existing structured outcome signals where available, otherwise say “Finished” rather than claiming the intended business change succeeded.

Both modes expose row details for state, elapsed time, and available safe outcome information. Friendly stays human-readable and does not receive raw arguments merely because they are hidden in the UI. Technical adds the qualified tool name, exact display-safe command or formatted inputs, and Copy. Preserve command whitespace and line breaks; redact credentials before transport or persistence. Copy copies exactly the displayed sanitized content, with a visible redaction/truncation notice when applicable.

Add a small expand/collapse affordance to the existing row. Show detail inline beneath that row in the same timeline styling, with a modest scrollable code area and Copy in Technical. While a row is expanded, pause automatic row eviction/window translation, keep the viewport bounded with local scrolling, and retain the selected invocation and focus. Collapsing resumes the existing recent-row window after inspection. Reuse the current Activity timeline disclosure to access earlier retained calls during execution and after completion. No sidebar or new sheet is needed. Support keyboard activation, focus retention, reduced motion, and screen-reader status changes without announcing every timer tick.

If several calls run concurrently, show a muted “N tools running” within the existing activity summary and allow inspection of every active call, including ones outside the three recent rows. Never mark an earlier call complete just because another starts.

## Data and rendering contract

Extend the existing progress structures additively rather than introducing a separate telemetry system:

- Invocation identity: a run-scoped activity ID encoded as `<runId>:<toolCallId>`, created once at the execution boundary and reused for start/end updates. Keep namespaced tool names intact. Separate retries remain separate invocations.
- Ordering: a server-assigned monotonically increasing revision within a run; insertion order preserves row order. Updates revise the existing row without moving it to the bottom. Compare revisions per invocation, not against one run-wide last-seen value, so a delayed completion for a different call still applies. Ignore stale revisions only for the same invocation. Snapshots are reconciled by invocation ID and per-item revision; the client keeps newer buffered fields when the history snapshot is older. There is no separate run-wide watermark field. Never deduplicate two real calls by label or command text.
- Lifecycle: `running`, `succeeded`, `failed`, `cancelled`, or `interrupted`; timestamps for actual start/end. Only backend evidence establishes outcomes. Historical items without lifecycle fields remain legacy activity, not invented successes.
- Presentation: semantic operation, label, optional approved target, qualified tool name, kind, and integration identity `{ providerId, appId, name, icon }` when resolved. Friendly and Technical use one deterministic semantic descriptor; presentation policy controls which fields are emitted.
- Technical detail: a separately bounded sanitized payload, format, redaction indicator, and truncation indicator. Implemented limit: 16 KiB per invocation; preview truncation happens in CSS. Anything over the cap explicitly says so. Do not silently turn truncated data into a purported full command. Preserve the old `lines` fallback during rollout.
- Run state: retain existing run terminal/interruption information and expose authoritative last-activity timestamps. Invocation lifecycle and stream connection health are separate concepts.

Trace both runtime adapters, the web stream writer, in-progress persistence, final transcript assembly, sanitizers, frontend parsers, and history reconciliation before finalizing field names. Store updates by invocation identity using existing transcript facilities; avoid adding a database table unless this audit proves necessary. If database changes become necessary, they must be additive and work on SQLite and Postgres.

Keep lifecycle identity in the progress contract rather than adding volatile fields to the builder's existing failure-comparison payload. Preserve repeated-failure detection with a regression case of identical failures on distinct invocation IDs. Nonterminal progress delivery/enrichment failures must not fail tool execution; failed terminal persistence must be surfaced through existing diagnostics and recovered from authoritative run state where available, rather than silently displaying success.

On final run termination, unresolved calls become interrupted/cancelled as appropriate, never succeeded by inference. On a browser disconnect, their execution state remains unknown until the existing run/transcript source confirms it. Rehydrate the authoritative snapshot before applying newer updates. Terminal invocation states cannot regress to running due to stale replay. An old reader may ignore new metadata; a new reader must still render old transcripts.

Capture mode is fixed for a run and stored with its activity. Historical activity keeps its captured presentation after a preference change; the new preference applies to subsequent runs. Friendly-captured calls cannot reveal Technical arguments later because they were never retained. Explain unavailable detail rather than reconstructing it. Test preference changes in both directions and during a run.

Sanitization uses per-tool display-input allowlists and applies equally to preview, detail, Copy, outcomes, storage, and replay. Redact credential-bearing keys, authorization headers, sensitive URL parameters, and recognized secret-bearing shell arguments/environment assignments. Never expand environment variables or retrieve credentials for display. Unknown structured input exposes only approved fields. If a command cannot be sanitized confidently, omit detail with an explicit unavailable notice. Document supported command forms and test adversarial fixtures; arbitrary free-form secret detection is not guaranteed. Do not include response bodies by default.

## Labels and integration identity

Create a small semantic descriptor registry next to `tool-progress.ts`, including action-sensitive handlers for multiplexed tools. Prefer explicit tool/action metadata and exact identifiers over regexes against display text. Keep a small set of dependable fallbacks for unknown tools.

Resolution order: explicit integration/action identity from the execution adapter; exact provider/component mapping already available in the run catalog; a narrow parser for recognized CLI invocations; generic fallback. For CLI parsing, use a tested tokenizer or existing argument parser that respects quotes. Only classify unambiguous recognized invocations. Multiple shell commands must not be presented as one verified integration action. A GitHub skill being loaded is preparation, not evidence that GitHub was contacted. Searching connected knowledge does not establish that a live app API was queried.

Reuse normalized `IntegrationApp` metadata and `AppIcon`. Resolve identity with `(providerId, appId)`; Canvas component keys use the longest known catalog app slug, matching the existing integration-card convention. Do not use an account ID as an app ID. Reuse catalog/search results already available to the run. Missing icons must not trigger agent tool calls or block tool execution. If enrichment needs a catalog fetch, use the existing provider API asynchronously, deduplicate it, enforce a timeout, and keep a bounded cache scoped to provider/configuration; do not cache user connection or account data globally. Implemented catalog scope: one run-local request, up to 256 apps, with a 2-second timeout and no cross-run TTL or negative cache. Missing/broken images fall back to the existing icon behavior. Snapshot the resolved app name/identity in history so later catalog changes cannot relabel old actions.

## Honest progress and reasoning flow

Use the existing user-visible assistant updates as timeline text. Keep the reasoning-text preference respected; this plan does not add model calls to paraphrase activity or expose private internal reasoning. Generic Thinking belongs at the run level when no tool is active; it must not replace a still-running tool.

Show elapsed time for active calls. After 10 seconds without a meaningful update, show “Using GitHub · 12s” only if the active operation and app are established; otherwise “Running command · 12s” or “No new activity for 12s.” Use “Waiting for GitHub” only if an explicit upstream-wait event establishes that phase. These are elapsed-time descriptions, not promises that an upstream service is healthy. Do not invent percentages, stages, retries, or periodic assistant sentences.

The web stream already has a heartbeat: inspect its semantics before adding anything. A transport heartbeat does not prove tool progress. When the connection drops, show reconnecting/connection lost separately from the last known execution state. On verified run failure, cancellation, budget exhaustion, or other interruption, show the real reason through the existing interruption mechanism and stop the active animation. Preserve all existing safety and execution limits.

## Implemented slices

1. **Fixtures and contract — implemented.** Representative built-in, Canvas, MCP, and runtime start/end fixtures cover additive lifecycle fields, per-invocation IDs/revisions, mode projection, and payload bounds. Shared fields remain optional for legacy transcripts.
2. **Technical inspection — implemented.** Technical mode retains sanitized detail up to 16 KiB, removes the old transport-level 40-character detail loss, preserves Canvas command text, and provides inline expansion/Copy in live and completed activity. Legacy items remain inspectable only to the extent their stored content allows.
3. **Friendly accuracy and branding — implemented.** Deterministic descriptors, action-aware schedule/Canvas labels, run-scoped catalog resolution, and reusable app icons are wired while channel-specific verbosity remains unchanged.
4. **Lifecycle and activity feedback — implemented.** Invocation IDs, revisions, actual outcomes, active counts, timing, reconnect reconciliation, and terminal cleanup flow through both runtime paths and persistence. Updates revise the same row and do not count completion updates as new calls.
5. **Bounded-window integration and review — implemented.** Live history access, stable expanded-row selection during streaming, keyboard/focus affordances, automation-builder parity, and legacy transcript regression checks are covered. Browser QA is recorded separately for the private local stack.

## Verification and acceptance

The contract is implemented in the server activity snapshot, web stream persistence/replay, shared progress fields, and the shared ChatThread used by chat and the automation builder. Focused unit, isolated, and component tests cover the data contract, sanitization, retention, reconciliation, labels, lifecycle transitions, Off mode, and inspection behavior.

- Technical: a 500-character multiline command is fully inspectable and copied faithfully after sanitization; a payload above 16 KiB shows an explicit cap notice; Canvas commands are not replaced by a lossy subcommand summary.
- Friendly: fixtures distinguish instruction loading, app discovery, action discovery, execution, knowledge search, and schedule actions. Unresolved operations stay generic. Credentials/raw private arguments are absent from Friendly transport, not merely hidden with CSS.
- Lifecycle: two same-name concurrent calls complete in reverse order correctly; duplicate start/end updates do not add rows; stale replay cannot reverse a terminal state; retries retain separate identities; missing IDs do not use name-based matching.
- Persistence: live, reconnect, background-run restoration, and completed history agree for both runtimes and both web surfaces. Old transcripts still render; old incomplete details are not described as recoverable.
- Outcomes: success, application error, denied tool, cancellation, interruption, and disconnect receive distinct honest treatment. Run-level failure is not reassigned to a tool without evidence.
- Visual regression: compare baseline and updated screenshots at desktop and mobile widths for the collapsed timeline; preserve layout, typography, spacing, colors, and animation behavior apart from the approved icon/label/status affordances.
- UX: three-row default remains bounded, all active calls and earlier activity remain reachable, an expanded detail row stays stable through new events, narrow layouts work, and icon failures never prevent progress rendering.
- Resource/privacy limits: bound detail payloads and caches; audit existing transcript limits and use the implemented per-run retention budgets: 16 KiB per item, 256 KiB of detail across a run, 512 completed items plus active items, and 64 KiB of retained intermediate text. Prune completed detail before active state, preserve summary rows, and display when retained detail is unavailable, including in an already-expanded row. Keep active invocation identities/states and terminal transitions available even when completed detail is pruned. Coalesce nonterminal cosmetic updates; never drop terminal states silently.
- Off mode: existing tests for its single Thinking label, reasoning settings, and event suppression continue unchanged. Shared runtime metadata must not increase Off-mode display events.

Use plain unit tests for descriptor/projection/reducer logic; follow repository suffix rules for mocks, fake timers, real sockets, and browser coverage. Add meaningful integration coverage for stream/storage/replay and focused component tests for inspection and bounded history. For release verification, run `pnpm exec biome check .`, `pnpm typecheck`, `pnpm test`, and `pnpm build`, followed by focused browser QA of web chat and automation builder.

## Accepted boundaries

Some tools cannot provide meaningful sub-progress, so elapsed time and observed state are the honest limit. Unknown integrations may retain a generic icon. Historical clipped commands cannot be reconstructed. Technical is an inspection surface for sanitized invocation data, not an unrestricted tool-output/log viewer. Run-level recovery and execution policy remain separate from this display work. No production changes are included in this plan.

## Design review

Independent review incorporated: per-invocation replay comparison, per-item revisions, capture-mode semantics, evidence-based waiting labels, concrete display sanitization, and retention budgets settled before detail expansion. The user subsequently confirmed that the existing look must remain; this revision replaces the proposed external inspector with modest inline expansion and preserves the current visual design.

## Private browser QA record — 2026-09-07

The local stack was exercised with the private `activity-builder` Playwright session at `http://127.0.0.1:5189` against the already-running QA backend on `127.0.0.1:5109`. Password login succeeded as `activity@example.test`. The backend fixture itself has no scheduler data/routes, so the initial unmocked `/scheduled-tasks` check returned 404 and correctly rendered the unavailable state.

For populated builder QA, only the builder’s localhost API requests were intercepted in Playwright with fixture responses shaped from `automation-builder.isolated.test.tsx`: automation definition and lock, conversation list/selection, conversation transcript, origin messages, run details, MCP server/connections, and the selected run’s four technical activity items. No production or backend source was changed. The populated route rendered the automation canvas, chat sidecar, run history, four-call Activity timeline, terminal statuses (`Done` and `Failed`), elapsed durations, expanded technical detail, and Copy controls.

Desktop evidence is captured at `output/playwright/activity-builder-desktop-final.png`. At 390×844, the run history was closed through its existing “Collapse all runs” control so the chat sidecar could be inspected; the expanded timeline and scrollable Bash detail are captured at `output/playwright/activity-builder-mobile-chat-expanded.png`. The mobile page reported viewport/body width 390, timeline width 354, detail width 195, and no horizontal body overflow. The run-panel-only capture `activity-builder-mobile-expanded.png` is retained as a separate run-history view, not counted as timeline evidence.

Chat QA used the actual local web-chat API with a deterministic runner fixture. It verified concurrent invocation states, an expanded row retaining focus through later tool events, Friendly presentation without raw detail, unchanged Off-mode Thinking, persisted history after reload, and exact clipboard equality for a 551-character multiline command. Desktop and 390px mobile captures are in `output/playwright/activity-technical-completed-final.png`, `activity-technical-mobile-final.png`, `activity-friendly-completed.png`, and `activity-off-live.png`. Mobile activity rows had no horizontal overflow. These checks exercise local UI and transport behavior; live provider execution and OAuth were outside this QA fixture.

Final test verification: `pnpm test` passed with 6,875 server tests and 670 web tests (7,545 passed overall; 22 existing server tests skipped). The full run was repeated after separating the build from the tests: a concurrent Vite build had briefly removed `packages/web/dist/index.html`, which API test app creation reads. The completed run has no failures.

Final quality gates also passed: `pnpm exec biome check .` (1,808 files), `pnpm typecheck`, `pnpm build`, and `git diff --check`. Temporary QA services were stopped and the local fixture was removed from the working tree.
