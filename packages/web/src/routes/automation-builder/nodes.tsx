/**
 * The single node renderer, registered under all three step types. Shape-coded by
 * type (triangle / rounded square / circle) with a fixed dark gradient fill and a
 * status dot; the label sits underneath and is the primary way to tell steps apart.
 * Horizontal flow: handles on left (target) / right (source), anchored to the shape.
 */
import { cn } from "@sketch/ui/lib/utils";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { NODE_BORDER, NODE_FILL, SELECTION_COLOR, STATUS_COLOR, stepIcon } from "./node-meta";
import type { RunStatus, StepNodeData } from "./types";

const SHAPE_SIZE = 60;
/**
 * Connection handles are small half-discs: the flat side sits flush on the node
 * edge and the dome faces outward toward the branch, so the connector reads as
 * growing out of the shape rather than a dot stuck on it. `zIndex` keeps them
 * above the shape body; `background` is set per node to the stroke colour.
 */
const HANDLE_BASE = { width: 4, height: 8, border: "none", zIndex: 1 } as const;

/**
 * Stacked drop-shadow that mirrors the square/circle's `shadow-sm` (two layers
 * in this Tailwind v4 setup) — drop-shadow follows the triangle's outline where
 * a box-shadow would only trace its bounding rectangle.
 */
const SHAPE_SHADOW = "drop-shadow(0 1px 3px rgb(0 0 0 / 0.10)) drop-shadow(0 1px 2px rgb(0 0 0 / 0.06))";

/**
 * The triangle is drawn as a rounded-corner SVG path (not a clipPath polygon) so
 * it gets the same family treatment as the square/circle: a real 2px stroke,
 * softened corners, and a shape-following shadow. Vertices sit a few px inside
 * the 60×60 box to leave room for the stroke; corners are rounded by offsetting
 * along each edge and arcing through the vertex with a quadratic curve.
 */
function unit(from: readonly [number, number], to: readonly [number, number]): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function roundedPolygonPath(points: readonly (readonly [number, number])[], radius: number): string {
  const n = points.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const cur = points[i];
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const toPrev = unit(cur, prev);
    const toNext = unit(cur, next);
    const enter = [cur[0] + toPrev[0] * radius, cur[1] + toPrev[1] * radius];
    const exit = [cur[0] + toNext[0] * radius, cur[1] + toNext[1] * radius];
    d += `${i === 0 ? "M" : "L"}${enter[0].toFixed(2)},${enter[1].toFixed(2)}`;
    d += `Q${cur[0]},${cur[1]} ${exit[0].toFixed(2)},${exit[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

// Right-pointing triangle: flat edge on the LEFT, apex on the RIGHT pointing
// along the flow (a "play"/start glyph). Vertices inset 3px to leave room for
// the stroke, mirroring the square/circle insets.
const TRIANGLE_VERTICES = [
  [3, 3], // top-left (flat edge, top)
  [57, 30], // right apex — points downstream
  [3, 57], // bottom-left (flat edge, bottom)
] as const;
const TRIANGLE_PATH = roundedPolygonPath(TRIANGLE_VERTICES, 8);

/**
 * Each handle's flat edge hugs the node and its dome points along the branch.
 * With the trigger triangle now pointing right, its apex sits at the right edge
 * mid-height — exactly where the standard source handle lands — so every shape
 * shares one source-handle style.
 */
const TARGET_HANDLE_STYLE = {
  ...HANDLE_BASE,
  borderRadius: "9999px 0 0 9999px",
  left: 0,
  right: "auto",
  top: "50%",
  transform: "translate(calc(-100% + 1px), -50%)",
} as const;
const SOURCE_HANDLE_STYLE = {
  ...HANDLE_BASE,
  borderRadius: "0 9999px 9999px 0",
  left: "auto",
  right: 0,
  top: "50%",
  transform: "translate(calc(100% - 1px), -50%)",
} as const;
// The apex *vertex* is at x57, but the corner rounding (radius 8) arcs the path
// back so the actual rendered tip lands at x≈53.4 (≈54.2 including the 1.5px
// stroke). Anchoring to the vertex therefore leaves a ~1.6px gap. Put the flat
// side at x52 so it overlaps the visible stroked tip by ~2px — the connector
// reads as growing out of the point, matching the square/circle treatment.
const TRIANGLE_SOURCE_HANDLE_STYLE = {
  ...HANDLE_BASE,
  borderRadius: "0 9999px 9999px 0",
  left: "52px",
  right: "auto",
  top: "50%",
  transform: "translate(0, -50%)",
} as const;

function StatusDot({ status, className }: { status: RunStatus; className?: string }) {
  const running = status === "running";
  return (
    <span
      className={cn(
        "absolute size-2 rounded-full",
        // Square/circle: centred on top. The triangle overrides this (its top is
        // the top-left vertex, not the box centre).
        className ?? "-top-0.5 left-1/2 -translate-x-1/2",
        // Running = a faint brand-accent pulse: motion draws the eye without the
        // dot reading as an obviously-yellow status.
        running && "animate-[pulse_1.1s_ease-in-out_infinite] opacity-60",
      )}
      style={{ backgroundColor: STATUS_COLOR[status], boxShadow: "0 0 0 1.5px var(--background)" }}
    />
  );
}

export function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const { step, run, hasIncoming, hasOutgoing } = data;
  const borderColor = selected ? SELECTION_COLOR : NODE_BORDER;
  // Only render a handle where an edge actually lands, so terminal nodes (the
  // action's rounded cap) don't show a dangling connector dot.
  const showTarget = hasIncoming ?? step.type !== "trigger";
  const showSource = hasOutgoing ?? true;
  const status = run?.status ?? "idle";
  const isFailed = status === "failed";

  const isTriangle = step.type === "trigger";
  const isCircle = step.type === "action";
  const Icon = stepIcon(step);

  return (
    <div className="flex w-[150px] flex-col items-center gap-1.5 select-none">
      {/* shape box — handles live inside so they anchor to the shape, not the label */}
      <div className="relative" style={{ width: SHAPE_SIZE, height: SHAPE_SIZE }}>
        {showTarget && (
          <Handle type="target" position={Position.Left} style={{ ...TARGET_HANDLE_STYLE, background: borderColor }} />
        )}

        {isTriangle ? (
          <svg
            viewBox="0 0 60 60"
            className="absolute inset-0 size-full"
            style={{ filter: SHAPE_SHADOW, transition: "stroke 100ms ease-out, fill 100ms ease-out" }}
            aria-hidden
          >
            <title>Trigger</title>
            <path d={TRIANGLE_PATH} fill={NODE_FILL} stroke={borderColor} strokeWidth={1.5} strokeLinejoin="round" />
          </svg>
        ) : (
          <div
            className={cn(
              "absolute inset-0 border-[1.5px] shadow-sm transition-colors",
              isCircle ? "rounded-full" : "rounded-2xl",
            )}
            style={{ background: NODE_FILL, borderColor }}
          />
        )}
        {/* Square/circle icons centre on the box; the right-pointing triangle's
         * mass sits left of centre, so its icon is nudged left to sit on the
         * centroid. Colour: `--muted-foreground` normally — a calm medium grey
         * that lets the saturated status dots be the only "loud" thing on the
         * canvas; a failed step turns the icon red to read at a glance. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center",
            isFailed ? "text-destructive" : "text-muted-foreground",
            isTriangle && "-translate-x-[8px]",
          )}
        >
          <Icon size={isTriangle ? 18 : 22} weight="regular" />
        </div>

        {/* Triangle's top is its top-left vertex, so anchor the dot there rather
         * than over the (now empty) top-centre of the box. */}
        <StatusDot status={status} className={isTriangle ? "left-[9%] -top-0.5 -translate-x-1/2" : undefined} />

        {showSource && (
          <Handle
            type="source"
            position={Position.Right}
            style={{ ...(isTriangle ? TRIANGLE_SOURCE_HANDLE_STYLE : SOURCE_HANDLE_STYLE), background: borderColor }}
          />
        )}
      </div>

      {/* One line only — type / mode details and the full title live in the drawer. */}
      <span className="line-clamp-1 max-w-[150px] text-center text-xs font-medium leading-tight text-foreground">
        {step.label}
      </span>
    </div>
  );
}

export const nodeTypes = {
  trigger: StepNode,
  action: StepNode,
  agent: StepNode,
};
