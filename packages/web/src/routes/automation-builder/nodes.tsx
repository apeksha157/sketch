/**
 * The single node renderer, registered under all three step types. Shape-coded by
 * type (triangle / rounded square / circle) with a fixed dark gradient fill and a
 * status dot; the label sits underneath and is the primary way to tell steps apart.
 * Horizontal flow: handles on left (target) / right (source), anchored to the shape.
 */
import { cn } from "@sketch/ui/lib/utils";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { HANDLE_COLOR, NODE_BORDER, NODE_FILL, SELECTION_COLOR, STATUS_COLOR, stepSubLabel } from "./node-meta";
import type { StepNodeData } from "./types";

const SHAPE_SIZE = 60;
const HANDLE_STYLE = { background: HANDLE_COLOR, width: 9, height: 9, border: "none" } as const;

function StatusDot({ color }: { color: string }) {
  return (
    <span
      className="absolute -right-0.5 -top-0.5 size-3 rounded-full"
      style={{ backgroundColor: color, boxShadow: "0 0 0 2px var(--background)" }}
    />
  );
}

export function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const { step, run } = data;
  const borderColor = selected ? SELECTION_COLOR : NODE_BORDER;
  const statusColor = STATUS_COLOR[run?.status ?? "idle"];
  const sub = stepSubLabel(step);

  const isTriangle = step.type === "trigger";
  const isCircle = step.type === "action";

  return (
    <div className="flex w-[150px] flex-col items-center gap-2 select-none">
      {/* shape box — handles live inside so they anchor to the shape, not the label */}
      <div className="relative" style={{ width: SHAPE_SIZE, height: SHAPE_SIZE }}>
        {step.type !== "trigger" && <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />}

        {isTriangle ? (
          <>
            <div
              className="absolute inset-0 drop-shadow-sm"
              style={{ background: borderColor, clipPath: "polygon(50% 4%, 4% 96%, 96% 96%)" }}
            />
            <div
              className="absolute inset-[2px]"
              style={{ background: NODE_FILL, clipPath: "polygon(50% 4%, 4% 96%, 96% 96%)" }}
            />
          </>
        ) : (
          <div
            className={cn(
              "absolute inset-0 border-2 shadow-sm transition-colors",
              isCircle ? "rounded-full" : "rounded-2xl",
            )}
            style={{ background: NODE_FILL, borderColor }}
          />
        )}
        <StatusDot color={statusColor} />

        <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      </div>

      <div className="flex flex-col items-center gap-0.5 text-center">
        <span className="line-clamp-2 max-w-[150px] text-xs font-medium leading-tight text-foreground">
          {step.label}
        </span>
        {sub && <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}

export const nodeTypes = {
  trigger: StepNode,
  action: StepNode,
  agent: StepNode,
};
