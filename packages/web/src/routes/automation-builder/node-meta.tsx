/**
 * Per-type visual metadata. Fully themed: node fills, handles, selection, and
 * status colors all resolve from Sketch's CSS tokens, so the canvas adapts to
 * light and dark mode.
 */
import { ClockIcon, CodeIcon, type Icon, LightningIcon, SparkleIcon } from "@phosphor-icons/react";
import type { AutomationStep, RunStatus } from "./types";

/**
 * Canvas colour system — every value is a Sketch token:
 *
 *   • `--canvas-line` = resting structure: node outline, handle dots, connection
 *     branches, and idle status dots — one quiet language. Defined in flow.css as
 *     `--border` mixed a notch toward `--muted-foreground`, so the lines read a
 *     shade darker than the (plain `--border`) background grid, giving the canvas
 *     a little depth. Tracks light/dark since it's derived from tokens.
 *   • `--ring` = the emphasis / SELECTED state for nodes, handles, and edges.
 *     This is Sketch's dedicated focus-ring token: a deep accent yellow (warm
 *     mustard on light, bright on-brand yellow on dark), so selection picks up
 *     the brand accent without using the bright `--brand-yellow` (invisible on
 *     white) or `--primary` (reserved for the Run CTA). It sits in the yellow-
 *     green accent family, distinct from `--warning` (amber) and `--destructive`
 *     (red), so it never reads as an error.
 */
export const NODE_FILL = "var(--card)";
export const NODE_BORDER = "var(--canvas-line)";
// Selected outline: full foreground (dark) rather than the brand gold — selection
// reads as a strong neutral, consistent with the rest of the de-golded UI.
export const SELECTION_COLOR = "var(--foreground)";

/**
 * Run-status dots. Success/failed are the semantic tokens; running is the brand
 * accent (a faint pulse, set in the dot component) rather than a blue; idle is
 * the canvas line colour so a not-yet-run node reads as quietly inactive but
 * still in the same structural language as the outlines and edges.
 */
export const STATUS_COLOR: Record<RunStatus, string> = {
  success: "var(--success)",
  running: "var(--foreground)",
  failed: "var(--destructive)",
  idle: "var(--canvas-line)",
};

export const TYPE_LABEL: Record<AutomationStep["type"], string> = {
  trigger: "Trigger",
  agent: "Agent",
  action: "Action",
};

/**
 * Human names for the apps/integrations a step reaches out to. The stored keys
 * are internal slugs ("sheets", "slack"); the drawer shows the proper product
 * name so a reader sees "Google Sheets", not a slug.
 */
const APP_LABEL: Record<string, string> = {
  slack: "Slack",
  sheets: "Google Sheets",
  gmail: "Gmail",
  trustpilot: "Trustpilot",
  notion: "Notion",
  intercom: "Intercom",
};

export function appLabel(key: string): string {
  return APP_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * The external apps a step connects to, in plain language — the one thing worth
 * surfacing about "how a step runs". Agents draw from their allowed skills + MCP
 * servers; actions from their script's apps; triggers have none (they're fired
 * *by* a source, shown in their own fields, rather than calling out to one).
 */
export function stepConnections(step: AutomationStep, apps?: string[]): string[] {
  if (step.type === "agent") return [...(step.agentSkills ?? []), ...(step.agentMcpServers ?? [])];
  if (step.type === "action") return apps ?? [];
  return [];
}

/** Icon shown inside the node shape — gives each step type a glanceable identity. */
export function stepIcon(step: AutomationStep): Icon {
  if (step.type === "trigger") {
    return step.triggerConfig?.type === "schedule" ? ClockIcon : LightningIcon;
  }
  if (step.type === "agent") return SparkleIcon;
  return CodeIcon;
}
