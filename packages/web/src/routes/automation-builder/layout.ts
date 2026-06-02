/**
 * Builds React Flow nodes/edges from an Automation. Because stored `position`
 * values are unreliable and two of three real automations have no edges, we
 * derive a deterministic vertical layout from edge order (topological), falling
 * back to the step array order. Edges are mapped from `{from,to}` to React Flow
 * `{source,target}`.
 */
import type { Edge, Node } from "@xyflow/react";
import type { Automation, StepNodeData, StepRunResult } from "./types";

const COL_GAP = 230;
const ROW_Y = 0;

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

export function toFlowNodes(
  automation: Automation,
  stepResults: Record<string, StepRunResult> = automation.lastRun,
): Node<StepNodeData>[] {
  const order = orderedStepIds(automation);
  const byId = new Map(automation.steps.map((s) => [s.id, s]));

  return order.map((id, index) => {
    const step = byId.get(id);
    if (!step) throw new Error(`unknown step ${id}`);
    return {
      id,
      type: step.type,
      position: { x: index * COL_GAP, y: ROW_Y },
      data: {
        step,
        content: automation.content[id],
        run: stepResults[id],
      },
    };
  });
}

export function toFlowEdges(automation: Automation): Edge[] {
  if (automation.edges.length > 0) {
    return automation.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: "smoothstep",
    }));
  }
  // No stored edges: connect consecutive steps in display order so the graph reads.
  const order = orderedStepIds(automation);
  const edges: Edge[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    edges.push({ id: `auto-${i}`, source: order[i], target: order[i + 1], type: "smoothstep" });
  }
  return edges;
}
