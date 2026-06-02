/**
 * The React Flow surface. Themeable chrome (background grid + controls follow
 * Sketch tokens) and themed nodes. Read-only for now: nodes are selectable and
 * draggable for feel, but connecting and persistence are deferred to wiring.
 *
 * Node status dots reflect `runResults` (the active run); pass a different run's
 * results + a changed `runKey` to re-render the graph against that run.
 */
import { Background, BackgroundVariant, Controls, type Node, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { useMemo } from "react";
import "./flow.css";
import { toFlowEdges, toFlowNodes } from "./layout";
import { nodeTypes } from "./nodes";
import type { Automation, StepNodeData, StepRunResult } from "./types";

export function AutomationCanvas({
  automation,
  runResults,
  runKey,
  onSelectStep,
}: {
  automation: Automation;
  runResults?: Record<string, StepRunResult>;
  runKey?: string;
  onSelectStep: (stepId: string | null) => void;
}) {
  const { resolvedTheme } = useTheme();
  const dotColor = resolvedTheme === "dark" ? "#2a2f3a" : "#d8d8e0";

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
          <Background variant={BackgroundVariant.Dots} gap={16} size={2} color={dotColor} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
