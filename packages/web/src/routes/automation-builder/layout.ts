/**
 * Builds React Flow nodes/edges from an Automation. Stored `position` values are
 * unreliable, so we derive a deterministic *layered* layout: each node's column
 * is its longest-path depth from a root, and nodes sharing a column stack
 * downward (the first in array order stays on the main line at y=0, branches
 * hang below). Edges map from `{from,to}` to React Flow `{source,target}`.
 */
import type { Edge, Node } from "@xyflow/react";
import type { Automation, StepNodeData, StepRunResult } from "./types";

const COL_GAP = 240;
const ROW_GAP = 150;

/** Order steps: follow edges from the root; fall back to array order for leftovers. */
function orderedStepIds(automation: Automation): string[] {
  const { steps, edges } = automation;
  if (edges.length === 0) return steps.map((s) => s.id);

  const next = new Map<string, string>();
  const hasIncoming = new Set<string>();
  for (const e of edges) {
    next.set(e.from, e.to);
    hasIncoming.add(e.to);
  }
  const root = steps.find((s) => !hasIncoming.has(s.id)) ?? steps[0];

  const ordered: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = root?.id;
  while (cursor && !seen.has(cursor)) {
    ordered.push(cursor);
    seen.add(cursor);
    cursor = next.get(cursor);
  }
  for (const s of steps) if (!seen.has(s.id)) ordered.push(s.id);
  return ordered;
}

/** The connections actually drawn — stored edges, or consecutive steps in
 *  display order when an automation has none. Shared by nodes (to decide which
 *  handles to render) and edges (to draw them) so the two never disagree. */
function resolvedConnections(automation: Automation): Array<{ id: string; source: string; target: string }> {
  if (automation.edges.length > 0) {
    return automation.edges.map((e) => ({ id: e.id, source: e.from, target: e.to }));
  }
  const order = orderedStepIds(automation);
  const conns: Array<{ id: string; source: string; target: string }> = [];
  for (let i = 0; i < order.length - 1; i++) {
    conns.push({ id: `auto-${i}`, source: order[i], target: order[i + 1] });
  }
  return conns;
}

/** Column index per node = longest path from any root (memoized; cycle-safe). */
function computeColumns(stepIds: string[], conns: Array<{ source: string; target: string }>): Map<string, number> {
  const sourcesByTarget = new Map<string, string[]>();
  for (const c of conns) {
    const arr = sourcesByTarget.get(c.target) ?? [];
    arr.push(c.source);
    sourcesByTarget.set(c.target, arr);
  }
  const memo = new Map<string, number>();
  const onPath = new Set<string>();
  function depth(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (onPath.has(id)) return 0;
    const sources = sourcesByTarget.get(id) ?? [];
    if (sources.length === 0) {
      memo.set(id, 0);
      return 0;
    }
    onPath.add(id);
    const d = 1 + Math.max(...sources.map(depth));
    onPath.delete(id);
    memo.set(id, d);
    return d;
  }
  const cols = new Map<string, number>();
  for (const id of stepIds) cols.set(id, depth(id));
  return cols;
}

export function toFlowNodes(
  automation: Automation,
  stepResults: Record<string, StepRunResult> = automation.lastRun,
): Node<StepNodeData>[] {
  const stepIds = automation.steps.map((s) => s.id);
  const byId = new Map(automation.steps.map((s) => [s.id, s]));

  const conns = resolvedConnections(automation);
  const hasOutgoing = new Set(conns.map((c) => c.source));
  const hasIncoming = new Set(conns.map((c) => c.target));
  const columns = computeColumns(stepIds, conns);

  // Stack nodes that share a column; first-in-array stays on the main line (y=0).
  const nextRow = new Map<number, number>();
  const rows = new Map<string, number>();
  for (const id of stepIds) {
    const col = columns.get(id) ?? 0;
    const row = nextRow.get(col) ?? 0;
    rows.set(id, row);
    nextRow.set(col, row + 1);
  }

  return stepIds.map((id) => {
    const step = byId.get(id);
    if (!step) throw new Error(`unknown step ${id}`);
    return {
      id,
      type: step.type,
      position: { x: (columns.get(id) ?? 0) * COL_GAP, y: (rows.get(id) ?? 0) * ROW_GAP },
      data: {
        step,
        content: automation.content[id],
        run: stepResults[id],
        hasIncoming: hasIncoming.has(id),
        hasOutgoing: hasOutgoing.has(id),
      },
    };
  });
}

export function toFlowEdges(automation: Automation): Edge[] {
  return resolvedConnections(automation).map((c) => ({
    id: c.id,
    source: c.source,
    target: c.target,
    type: "smoothstep",
  }));
}
