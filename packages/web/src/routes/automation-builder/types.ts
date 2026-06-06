/**
 * Types for the automation builder prototype. These mirror the real Sketch
 * `scheduled_tasks` / `automation_step_content` shapes (see the CSV exports the
 * data model is derived from) so wiring to the API later is a swap, not a rewrite.
 *
 * Note: stored edges use `{ from, to }` (not React Flow's `source`/`target`), and
 * stored `position` values are unreliable across automations (some are grid hints
 * like {x:0,y:1}, some pixel-ish, some absent), so the canvas auto-lays-out
 * vertically from edge order rather than trusting `position`.
 */

export type StepType = "trigger" | "action" | "agent";
export type ContentType = "prompt" | "script";
export type RunStatus = "idle" | "running" | "success" | "failed";

export interface TriggerConfig {
  type: "schedule" | "webhook" | "canvas";
  scheduleType?: "cron" | "interval" | "once";
  scheduleValue?: string;
  timezone?: string;
  app?: string;
  eventDescription?: string;
}

export interface AutomationStep {
  id: string;
  type: StepType;
  label: string;
  icon?: string;
  position?: { x: number; y: number };
  triggerConfig?: TriggerConfig;
  agentMode?: "light" | "sketch";
  agentSkills?: string[];
  agentModel?: string;
  agentMcpServers?: string[];
  timeout?: number;
}

export interface AutomationEdge {
  id: string;
  from: string;
  to: string;
}

export interface StepContent {
  contentType: ContentType;
  content: string;
  apps?: string[];
}

export interface StepRunResult {
  status: RunStatus;
  durationMs?: number;
  /** string for text output (Slack messages, reminders), object/array for JSON. */
  output?: unknown;
  error?: string;
}

export type RunTrigger = "manual" | "schedule" | "webhook";

/** One execution of the whole automation (mirrors the `automation_runs` row). */
export interface AutomationRun {
  id: string;
  status: "success" | "failed" | "running";
  trigger: RunTrigger;
  startedAt: string;
  durationMs?: number;
  /** per-step results, keyed by step id (mirrors automation_runs.step_outputs). */
  stepResults: Record<string, StepRunResult>;
}

export interface Automation {
  id: string;
  title: string;
  description?: string;
  platform: "slack" | "whatsapp";
  scheduleLabel: string;
  timezone: string;
  outputMode: "deliver" | "silent";
  outputTarget?: string;
  status: "active" | "paused" | "completed";
  lastRunAt?: string;
  nextRunAt?: string;
  steps: AutomationStep[];
  edges: AutomationEdge[];
  /** keyed by step id */
  content: Record<string, StepContent>;
  /** latest run's per-step results (drives status dots + Output tab by default) */
  lastRun: Record<string, StepRunResult>;
  /** execution history, newest first (drives the Previous Runs panel) */
  runs?: AutomationRun[];
}

/** Data carried on each React Flow node. */
export interface StepNodeData {
  step: AutomationStep;
  content?: StepContent;
  run?: StepRunResult;
  /** Whether the resolved graph gives this node an in/out edge — drives which
   * handles render, so terminal nodes don't show a dangling connector dot. */
  hasIncoming?: boolean;
  hasOutgoing?: boolean;
  [key: string]: unknown;
}
