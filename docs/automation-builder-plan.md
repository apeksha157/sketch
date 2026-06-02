# Automation Builder — Canvas → Sketch adaptation plan

Status: design locked, pre-implementation
Owner: ops@canvasx.ai
Last updated: 2026-06-02

## Goal

Sketch automations are created via chat and shown in a **read-only** list. We want a
**visual editor**: a drag-and-drop graph view of an automation, adapting the
drag-and-drop builder UI from Canvas (canvas-ai) into Sketch.

Chat stays the primary author. The canvas is an editor over automations that already
exist — you open an automation, see its steps as a graph, edit prompts/code/config,
reposition and reconnect, and save.

## Locked decisions (2026-06-02)

1. **Visual:** Canvas's *structure* (shape-coded nodes, drawer, output viewer) but
   **fully themed with Sketch's tokens + font** — everything (surface, nodes, handles,
   edges, drawer, output viewer) resolves from CSS variables and flips with light/dark
   mode. (Superseded the earlier "hybrid / fixed-dark nodes" option C on user request.)
   Nodes are small shape-coded chips (triangle/square/circle) using `--card` fill +
   `--border`, `--primary` on select; label underneath. Prompt/code lives in the drawer,
   not on the node. Status dots map to `--success`/`--info`/`--destructive`.
2. **Node types:** only Sketch's three — `trigger` / `agent` (prompt) / `action` (code).
   No if-else, loops, or Pipedream integrations in v1.
3. **Runtime:** linear / DAG. Edges define execution order. Minimal executor change.
4. **Authoring:** visual editor over chat-created automations. Add save/update (PUT)
   endpoints — today only GET / DELETE / pause / resume exist.

## Why this is tractable: the data model is already graph-shaped

Sketch's `scheduled_tasks` schema already anticipates a graph:

- `WorkflowStep` already carries `position: { x, y }`.
- There is already an `edges` JSON column (currently unused).
- Step content already splits into `automation_step_content.content_type: "prompt" | "script"`.
- A `triggerConfig.type: "canvas"` already links a trigger to a Canvas workflow.

So the persistence layer is mostly there. The missing pieces are: (1) the interactive
canvas UI, (2) write endpoints, (3) edge-driven execution order.

## Source vs target stacks

| | Canvas (source) | Sketch (target) |
| --- | --- | --- |
| Framework | Next.js, React 19 | TanStack Router, Vite, React |
| Design system | Chakra UI | shadcn/ui + Tailwind v4 |
| Graph engine | `@xyflow/react` v12 | none yet (to add) |
| Local state | zustand | (to add zustand for the canvas) |
| Code editor | — | Monaco (already shipped) |
| Backend | MongoDB, Pipedream, Trigger.dev | SQLite-style, Claude Agent SDK |

`@xyflow/react` and zustand are styling-agnostic and port directly. Chakra node bodies and
the ~1500-line `UnifiedNodeDrawer` are rebuilt in shadcn.

## What we take from Canvas

### Keep / lift (logic, framework-agnostic)
- `@xyflow/react` v12 graph engine.
- Interaction logic from `FlowArea.tsx`: `onConnect`, `onNodesChange`, `onEdgesChange`,
  selection, node-placement mode, viewport persistence, focus-node animation.
- zustand store pattern for canvas state (`canvasDataStore` → `automation-canvas` store).
- Edge styling, connection line, handle styling + connect highlight.
- The drawer's **Input / Output tab** concept — Output tab shows the last run's result.
  Sketch already stores `automation_runs.step_outputs`, so this is a cheap, high-value lift.
- `ExecutionBackground` running-node shimmer, mapped to Sketch run status.

### Adapt
- Node bodies: from 20 Chakra components down to **3 shadcn shape nodes** (triangle trigger,
  rounded-square agent, circle action) on a dark surface, label underneath.
- Drawer: from `UnifiedNodeDrawer` (~1500 lines) to a slim shadcn `Sheet` (~250 lines).
- Config forms: Sketch's small field set (agent mode/skills/model/mcp; trigger schedule).

### Drop (out of v1 scope)
- Pipedream integration forms + dynamic component fetching.
- if-else / for-loop nodes and their per-node stores.
- VariableBox / `{{ }}` JSONPath templating (linear runtime, no inter-step var passing yet).
- Trigger.dev execution, subworkflows.
- Collaboration / presence locks, multi-trigger, agent tool-streaming panels.

## Node visual spec

### Theming model (Fully themed — light + dark)

Everything resolves from Sketch's CSS tokens and flips with the app theme — no fixed
Canvas hex remains. Canvas hardcodes ~90 hex values with no tokens; the rebuild re-maps
them all:

| Role | Canvas hex | Sketch token |
| --- | --- | --- |
| Canvas surface / grid | `#232323` | `--background` / grid dots per theme |
| Node fill | `linear-gradient(180deg,#1D1F26,#000)` | `--card` (+ border + subtle shadow for contrast) |
| Node border / selection | `#5A6587` / `#6B7DFA` | `--border` / `--primary` |
| Node label text | dark.50 | `--foreground` |
| Handle (idle) / connecting | `#5A6587` / `#6B7DFA` | `--muted-foreground` / `--primary` |
| Edge stroke / hover | `#5A6587` / `#6B7DFA` | `--muted-foreground` @ 0.45 / `--primary` |
| Status: success / running / failed | `#9CFF7D` / `#6B7DFA` / `#EF4444` | `--success` / `--info` / `--destructive` |
| Drawer / output box bg | `#0C0D12` / `#0A0D14` | `--card` / `--muted/40` |
| JSON syntax (key/string/number/bool) | fixed | theme-aware Tailwind pairs (violet/emerald/amber/sky w/ `dark:` variants) |
| Font | Instrument Sans / IBM Plex Mono | `--font-sans` (Inter) / `--font-mono` (IBM Plex Mono) |

Note: light `--card` (0.967) barely differs from `--background` (0.976), so themed nodes
rely on `--border` + a subtle `shadow-sm` to read; dark mode has natural card/bg contrast.

Each node:

- **Shape by type:** `trigger` = triangle, `agent` = rounded square, `action` = circle.
  Reuse Canvas's node SVG assets and the fixed `linear-gradient(180deg,#1D1F26,#000)` fill.
- **Icon** centered in the shape (type icon; trigger sub-icon for schedule/webhook/canvas).
- **Editable label** below the node, in `--foreground` — the primary way to tell steps apart.
- **Status dot:** idle / running / success / failed, driven by the last `automation_run`.
- **Handles:** input left, output right. Fixed `#5A6587`, `#6B7DFA` on connect.
- **Selection:** fixed `#6B7DFA` border.

Edges: default bezier, fixed `#5A6587` stroke, arrow marker; dashed `#6B7DFA` connection line
while dragging; double-click to delete.

## Drawer spec (shadcn Sheet)

Opens on node click. Header: editable label + run-status. Two tabs:

- **Input** (config), rendered per node type:
  - `agent`: Monaco prompt editor + `agentMode` (light/sketch), `agentSkills`,
    `agentModel`, `agentMcpServers`, `timeout`.
  - `action`: Monaco script editor + `timeout`.
  - `trigger`: `triggerConfig` form (schedule cron/interval/once, webhook, or canvas).
- **Output**: last run's `step_outputs[stepId]` — status, duration, output/error.
  Output rendering is a close adaptation of Canvas's `OutputSection` (`output-viewer.tsx`):
  a fixed-dark "OUTPUT" box with a Tree ⇄ Raw toggle and a collapsible JSON tree using
  Canvas's exact syntax palette (brackets `#EAB308`, values `#60A5FA`, keys `#8B95B7`),
  per-row + copy-all, and "+ Show N more" array truncation. The path-picker checkboxes,
  processed/variables modes, modal, and CSV export are intentionally dropped — they
  served Canvas's variable-mapping feature, which the linear v1 runtime doesn't have.

Content (prompt/script) reads/writes `automation_step_content`; structural fields write to
the `steps` JSON on `scheduled_tasks`.

## Backend changes (`packages/server`)

Net-new endpoints (data model already supports them):

- `PUT /api/scheduled-tasks/:id` — persist `steps` (incl. positions), `edges`, label.
- `PUT /api/scheduled-tasks/:id/step-content` — upsert a step's prompt/script (+ apps).
- (reuse) `GET /api/scheduled-tasks/:id/step-content`, `/runs`, `/runs/:runId`.

Runtime: change the executor from implicit ordering to **edge-driven topological order**.
Steps already run sequentially sharing a session, so this is a small, contained change.
Validation: single connected DAG, exactly one trigger as the root, no cycles.

## Frontend file plan (`packages/web/src/routes/automation-builder/` + components)

- `canvas.tsx` — `<ReactFlow>` wrapper + handlers (ported from `FlowArea.tsx`, de-Chakra'd).
- `nodes/TriggerNode.tsx`, `nodes/AgentNode.tsx`, `nodes/ActionNode.tsx` — 3 shape nodes.
- `node-drawer.tsx` — shadcn Sheet, Input/Output tabs, Monaco editors.
- `node-palette.tsx` — add-node palette (3 types), click-to-place.
- `stores/automation-canvas.ts` — zustand: nodes, edges, selection, dirty flag, save.
- `flow.css` — handle / edge / connection-line CSS (lifted from Canvas `flowStyles.css`).
- Route: full-page editor `/scheduled-tasks/$id/edit`, opened from the automations list.
  (The existing `/scheduled-tasks/builder-sidecar` placeholder stays for chat scaffolding.)

## Build phases

1. **Scaffold + read-only render.** Add `@xyflow/react`; themeable canvas surface (Sketch
   tokens) with fixed-identity nodes in the new edit route; load an existing automation and
   render its `steps` + `edges` read-only.
2. **The 3 node components + edges**, matching Canvas styling; labels + status dots.
3. **Selection + drawer.** Click → Sheet; Monaco prompt/script (read-only persistence
   still); Output tab wired to `step_outputs`.
4. **Editing + persistence.** Drag/reposition, connect/disconnect, edit label/prompt/code;
   wire the `PUT` endpoints; dirty-state + save.
5. **DAG execution order** in the runtime + validation.

## Conventions to honor (from CLAUDE.md)

- **Feature-gate behind `EXPERIMENTAL_FLAG`** at all 4 layers — HTTP routes (`http.ts`),
  agent tools (`sketch-tools.ts`), system prompt (`prompt.ts`), and frontend nav
  (`app-sidebar.tsx`). With the flag off the builder must be fully invisible (no route,
  no API, no nav entry).
- **RESTful endpoints:** the `PUT` upserts above follow the noun-based, idempotent-PUT rule.
- **DB stays SQLite + Postgres portable** (Kysely); reuse existing `scheduled_tasks` columns
  (`steps`, `edges`) rather than adding dialect-specific structures.
- **Planning location:** the team's canonical plans live in the `.planning/` submodule under
  `{topic}/to-be-developed/`. This doc is a working draft in `docs/`; if we proceed, move it
  into `.planning/automations/to-be-developed/` and run it through the Codex CLI review step
  per the documented implementation workflow.

## Open questions / risks

- Hybrid theming: confirm fixed-identity dark nodes read as deliberate (not broken) on a
  **light** canvas surface — validate the contrast of label text and grid in light mode.
- zustand is a new dep in `packages/web` — acceptable (chosen for clean state lift).
- Legibility of icon-only nodes depends on good labels; chat-authoring should set sensible
  default labels, and the label must be easy to edit on the node.
- Topological execution must degrade gracefully for automations authored before edges
  existed (no edges → fall back to current ordering).
