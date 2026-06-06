/**
 * The React Flow surface. Themeable chrome (background grid + controls follow
 * Sketch tokens) and themed nodes. Read-only for now: nodes are selectable and
 * draggable for feel, but connecting and persistence are deferred to wiring.
 *
 * Node status dots reflect `runResults` (the active run); pass a different run's
 * results + a changed `runKey` to re-render the graph against that run.
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo } from "react";
import "./flow.css";
import { toFlowEdges, toFlowNodes } from "./layout";
import { nodeTypes } from "./nodes";
import type { Automation, StepNodeData, StepRunResult } from "./types";

/**
 * Drives React Flow's node selection from `selectedStepId` (the drawer's target)
 * rather than letting React Flow own it. Without this, closing the drawer leaves
 * the node stuck in its selected state — selection should mirror the drawer.
 */
function SelectionSync({ selectedStepId }: { selectedStepId: string | null }) {
  const { setNodes } = useReactFlow();
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const selected = n.id === selectedStepId;
        return n.selected === selected ? n : { ...n, selected };
      }),
    );
  }, [selectedStepId, setNodes]);
  return null;
}

/**
 * Updates node statuses in place during a live run (the gradual cascade), so the
 * dots light up one-by-one without remounting the graph (which would reset pan /
 * zoom). When `results` is null the baked run results stand.
 */
function RunResultsSync({ results }: { results: Record<string, StepRunResult> | null }) {
  const { setNodes } = useReactFlow();
  useEffect(() => {
    if (!results) return;
    setNodes((nds) =>
      nds.map((n) => {
        const next = results[n.id];
        if (!next || n.data.run === next) return n;
        return { ...n, data: { ...n.data, run: next } };
      }),
    );
  }, [results, setNodes]);
  return null;
}

export function AutomationCanvas({
  automation,
  runResults,
  runKey,
  liveResults = null,
  selectedStepId = null,
  onSelectStep,
}: {
  automation: Automation;
  runResults?: Record<string, StepRunResult>;
  runKey?: string;
  liveResults?: Record<string, StepRunResult> | null;
  selectedStepId?: string | null;
  onSelectStep: (stepId: string | null) => void;
}) {
  const nodes = useMemo(() => toFlowNodes(automation, runResults), [automation, runResults]);
  const edges = useMemo(() => toFlowEdges(automation), [automation]);

  return (
    <div className="automation-flow size-full bg-background">
      <ReactFlowProvider>
        <ReactFlow
          key={`${automation.id}:${runKey ?? "latest"}`}
          defaultNodes={nodes}
          defaultEdges={edges}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.35, maxZoom: 1.1 }}
          minZoom={0.4}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node: Node<StepNodeData>) => onSelectStep(node.id)}
          onPaneClick={() => onSelectStep(null)}
        >
          <SelectionSync selectedStepId={selectedStepId} />
          <RunResultsSync results={liveResults} />
          <Background variant={BackgroundVariant.Dots} gap={16} size={2} color="var(--border)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
