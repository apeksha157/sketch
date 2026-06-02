/**
 * Per-type visual metadata. Fully themed: node fills, handles, selection, and
 * status colors all resolve from Sketch's CSS tokens, so the canvas adapts to
 * light and dark mode.
 */
import type { AutomationStep, RunStatus } from "./types";

export const NODE_FILL = "var(--card)";
export const HANDLE_COLOR = "var(--muted-foreground)";
export const SELECTION_COLOR = "var(--primary)";
export const NODE_BORDER = "var(--border)";

/** Run-status dots — mapped to Sketch's semantic tokens (theme-aware). */
export const STATUS_COLOR: Record<RunStatus, string> = {
  success: "var(--success)",
  running: "var(--info)",
  failed: "var(--destructive)",
  idle: "var(--muted-foreground)",
};

export const TYPE_LABEL: Record<AutomationStep["type"], string> = {
  trigger: "Trigger",
  agent: "Agent",
  action: "Action",
};

/** Short secondary line under the node label. */
export function stepSubLabel(step: AutomationStep): string | null {
  if (step.type === "trigger") {
    const c = step.triggerConfig;
    if (!c) return "trigger";
    if (c.scheduleType === "cron" && c.scheduleValue) return `cron · ${c.scheduleValue}`;
    if (c.scheduleType === "interval" && c.scheduleValue) return `every ${Number(c.scheduleValue) / 3600}h`;
    return c.type;
  }
  if (step.type === "agent") return step.agentMode ? `agent · ${step.agentMode}` : "agent · prompt";
  if (step.type === "action") return "code";
  return null;
}
