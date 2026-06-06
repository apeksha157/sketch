/**
 * Shared mock dataset for the scheduled-tasks redesign explorations.
 *
 * The production demo data (`scheduled-tasks-demo.tsx`) only contains *simple*
 * single-step reminders, which hides the core problem these explorations are
 * trying to solve: a real workspace mixes dead-simple reminders ("nudge me at
 * 7pm") with genuinely complex, multi-app, trigger-based workflows that branch,
 * fail, and need debugging. This dataset deliberately includes both archetypes
 * so each direction can be judged on the hard case.
 *
 * `MockTask` extends the real `ScheduledTaskListItem` with a few presentation
 * helpers (kind, scope, appChain, runHealth) that a redesign would eventually
 * derive on the backend. Keeping them here lets the prototypes stay declarative.
 */
import type { ScheduledTaskListItem } from "@/lib/api";

export type TaskKind = "reminder" | "workflow";
export type TaskScope = "personal" | "system";

export interface MockTask extends ScheduledTaskListItem {
  /** Derived archetype — drives every divergent layout decision. */
  kind: TaskKind;
  /** Personal (user-created) vs system/team-default tasks (Viktor's tabs). */
  scope: TaskScope;
  /** App logos to render as a chain on workflow rows (emoji stand-ins). */
  appChain?: string[];
  /** Last-N run outcomes, newest last — drives the health sparkline. */
  runHealth?: Array<"ok" | "fail" | "running">;
}

const now = new Date().toISOString();
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const agoHours = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const agoDays = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

/** Reduce boilerplate — every field the type requires, with sane defaults. */
function task(partial: Partial<MockTask> & Pick<MockTask, "id" | "title" | "kind">): MockTask {
  return {
    platform: "whatsapp",
    contextType: "dm",
    deliveryTarget: "+15551234567",
    threadTs: null,
    prompt: partial.title ?? "",
    scheduleType: "cron",
    scheduleValue: "0 9 * * *",
    timezone: "Asia/Kolkata",
    sessionMode: "fresh",
    nextRunAt: inHours(6),
    lastRunAt: agoHours(4),
    status: "active",
    createdBy: "u1",
    createdAt: agoDays(7),
    targetLabel: "Himanshu Kalra",
    targetKindLabel: "WhatsApp DM",
    creatorName: "Himanshu Kalra",
    scheduleLabel: "Every day at 9:00 AM",
    canPause: true,
    canResume: false,
    canDelete: true,
    description: null,
    steps: null,
    stepCount: 0,
    triggerConfig: null,
    outputTarget: null,
    outputPlatform: null,
    outputMode: "deliver",
    lastRunStatus: "completed",
    runCount: 12,
    scope: "personal",
    ...partial,
  };
}

/** Serialize steps in the format the real StepsList parser expects. */
function steps(list: Array<{ id: string; type: "trigger" | "agent" | "action" | "code"; label: string }>) {
  return JSON.stringify(list);
}

// ── Simple reminders ───────────────────────────────────────────────────────
export const REMINDERS: MockTask[] = [
  task({
    id: "r1",
    title: "Daily Todo — 7 PM",
    kind: "reminder",
    prompt: "Send me my todo list for tomorrow",
    scheduleLabel: "Every day at 7:00 PM",
    scheduleValue: "0 19 * * *",
    lastRunAt: agoHours(4),
    runCount: 1,
  }),
  task({
    id: "r2",
    title: "GMAT Daily Study — 8 AM",
    kind: "reminder",
    prompt: "Remind me to do my GMAT study block",
    scheduleLabel: "Every day at 8:00 AM",
    scheduleValue: "30 2 * * *",
    lastRunAt: agoHours(16),
    runCount: 1,
  }),
  task({
    id: "r3",
    title: "Standup nudge — Roopak",
    kind: "reminder",
    platform: "slack",
    targetKindLabel: "Slack DM",
    targetLabel: "Roopak Nijhara",
    creatorName: "Apeksha M.",
    prompt: "DM Roopak his open action items every morning",
    scheduleLabel: "Weekdays at 9:00 AM",
    scheduleValue: "0 9 * * 1-5",
    outputMode: "silent",
    lastRunStatus: "failed",
    lastRunAt: agoHours(20),
    runCount: 8,
  }),
  task({
    id: "r4",
    title: "Weekly metrics digest",
    kind: "reminder",
    platform: "slack",
    targetKindLabel: "Slack channel",
    targetLabel: "#leadership",
    prompt: "Post the weekly KPI digest",
    status: "paused",
    canPause: false,
    canResume: true,
    scheduleLabel: "Mondays at 8:00 AM",
    scheduleValue: "0 8 * * 1",
    nextRunAt: null,
    lastRunAt: agoDays(3),
    runCount: 14,
  }),
  task({
    id: "r5",
    title: "Hydration reminder",
    kind: "reminder",
    scheduleLabel: "Every day at 2:00 PM",
    runCount: 40,
  }),
  task({
    id: "r6",
    title: "EOD wrap-up — post blockers",
    kind: "reminder",
    platform: "slack",
    targetKindLabel: "Slack channel",
    targetLabel: "#standup",
    scheduleLabel: "Weekdays at 6:30 PM",
    runCount: 22,
  }),
  task({
    id: "r7",
    title: "Standup nudge — Ananya",
    kind: "reminder",
    platform: "slack",
    targetKindLabel: "Slack DM",
    targetLabel: "Ananya R.",
    outputMode: "silent",
    scheduleLabel: "Weekdays at 9:00 AM",
    runCount: 17,
  }),
  task({
    id: "r8",
    title: "Weekly review prep",
    kind: "reminder",
    scheduleLabel: "Fridays at 4:00 PM",
    runCount: 9,
  }),
  task({
    id: "r9",
    title: "Invoice follow-up — overdue accounts",
    kind: "reminder",
    platform: "slack",
    targetKindLabel: "Slack DM",
    targetLabel: "Finance",
    lastRunStatus: "failed",
    scheduleLabel: "Mondays at 11:00 AM",
    runCount: 6,
  }),
  task({
    id: "r10",
    title: "Content calendar check",
    kind: "reminder",
    scheduleLabel: "Tue, Thu at 10:00 AM",
    runCount: 13,
  }),
  task({
    id: "r11",
    title: "Renewal nudge — enterprise",
    kind: "reminder",
    platform: "slack",
    targetKindLabel: "Slack channel",
    targetLabel: "#cs",
    scheduleLabel: "1st of month at 9:00 AM",
    runCount: 4,
  }),
  task({
    id: "r12",
    title: "Reading list digest",
    kind: "reminder",
    status: "paused",
    canPause: false,
    canResume: true,
    scheduleLabel: "Sundays at 8:00 AM",
    nextRunAt: null,
    runCount: 11,
  }),
];

// ── Complex workflows ──────────────────────────────────────────────────────
export const WORKFLOWS: MockTask[] = [
  task({
    id: "w1",
    title: "ClickUp Content: Create/update subtasks on new parent task",
    kind: "workflow",
    platform: "whatsapp",
    creatorName: "Arun Rajasekaran",
    prompt: "When a new parent task is created in Habuild content lists, fan out the subtask template",
    description: "Trigger · Canvas · clickup · new parent task created in Habuild content lists",
    scheduleType: "external",
    scheduleValue: "canvas",
    scheduleLabel: "On new ClickUp parent task",
    outputMode: "silent",
    nextRunAt: null,
    lastRunAt: agoHours(2),
    runCount: 23,
    stepCount: 3,
    appChain: ["clickup", "code", "code"],
    runHealth: ["ok", "fail", "ok", "ok", "ok"],
    triggerConfig: {
      type: "canvas",
      app: "clickup",
      eventDescription: "New parent task in Habuild content lists",
      status: "active",
    },
    steps: steps([
      { id: "trigger", type: "trigger", label: "New parent task in Habuild content lists" },
      { id: "s1", type: "code", label: "Wait for template and prepare existing subtask updates" },
      { id: "s2", type: "code", label: "Update existing ClickUp subtasks" },
    ]),
  }),
  task({
    id: "w2",
    title: "Surface design wins from Trustpilot",
    kind: "workflow",
    platform: "slack",
    targetKindLabel: "Slack channel",
    targetLabel: "#design-wins",
    creatorName: "Apeksha M.",
    prompt: "Every five-star Trustpilot review mentioning design lands in #design-wins",
    description: "On every new Trustpilot review",
    scheduleType: "external",
    scheduleValue: "canvas",
    scheduleLabel: "On new Trustpilot review",
    nextRunAt: null,
    lastRunStatus: "failed",
    lastRunAt: agoHours(6),
    runCount: 41,
    stepCount: 5,
    appChain: ["trustpilot", "ai", "slack", "sheets"],
    runHealth: ["ok", "ok", "ok", "ok", "fail"],
    triggerConfig: {
      type: "webhook",
      app: "trustpilot",
      eventDescription: "New review received",
      status: "active",
    },
    steps: steps([
      { id: "trigger", type: "trigger", label: "New Trustpilot review" },
      { id: "classify", type: "agent", label: "Check rating & topic" },
      { id: "post", type: "agent", label: "Post to #design-wins" },
      { id: "notify", type: "action", label: "DM the creator" },
      { id: "log", type: "action", label: "Log to wins tracker" },
    ]),
  }),
  task({
    id: "w3",
    title: "Gather Email Daily Digest",
    kind: "workflow",
    platform: "slack",
    targetKindLabel: "Slack channel",
    targetLabel: "#sketch-automation-test",
    creatorName: "Roopak Nijhara",
    prompt: "Summarize Gather emails from the last 24 hours and post a digest",
    scheduleLabel: "Every 24 hours",
    scheduleValue: "0 0 * * *",
    lastRunAt: agoHours(10),
    runCount: 31,
    stepCount: 3,
    appChain: ["gmail", "ai", "slack"],
    runHealth: ["ok", "ok", "ok", "ok", "ok"],
    triggerConfig: { type: "schedule", scheduleType: "interval", scheduleValue: "86400" },
    steps: steps([
      { id: "trigger", type: "trigger", label: "Daily trigger" },
      { id: "fetch", type: "code", label: "Fetch Gather emails" },
      { id: "summarize", type: "agent", label: "Summarize & deliver" },
    ]),
  }),
  task({
    id: "w4",
    title: "New signup → onboarding sequence",
    kind: "workflow",
    platform: "slack",
    creatorName: "Apeksha M.",
    prompt: "When a new user signs up, kick off the onboarding sequence",
    scheduleType: "external",
    scheduleValue: "canvas",
    scheduleLabel: "On new signup",
    nextRunAt: null,
    runCount: 88,
    stepCount: 4,
    appChain: ["ai", "slack", "gmail"],
    runHealth: ["ok", "ok", "ok", "ok", "ok"],
    triggerConfig: { type: "webhook", app: "stripe", eventDescription: "New customer", status: "active" },
    steps: steps([
      { id: "trigger", type: "trigger", label: "New signup" },
      { id: "enrich", type: "code", label: "Enrich profile" },
      { id: "welcome", type: "agent", label: "Send welcome message" },
      { id: "schedule", type: "action", label: "Schedule day-3 follow-up" },
    ]),
  }),
  task({
    id: "w5",
    title: "Support ticket → triage to Linear",
    kind: "workflow",
    platform: "slack",
    targetKindLabel: "Slack channel",
    targetLabel: "#support",
    creatorName: "Roopak Nijhara",
    prompt: "Triage new support tickets and file Linear issues for bugs",
    scheduleType: "external",
    scheduleValue: "canvas",
    scheduleLabel: "On new support ticket",
    nextRunAt: null,
    runCount: 54,
    stepCount: 3,
    appChain: ["intercom", "ai", "linear"],
    runHealth: ["ok", "fail", "ok", "ok", "ok"],
    triggerConfig: { type: "webhook", app: "intercom", eventDescription: "New conversation", status: "active" },
    steps: steps([
      { id: "trigger", type: "trigger", label: "New support ticket" },
      { id: "triage", type: "agent", label: "Classify & summarize" },
      { id: "file", type: "action", label: "Create Linear issue if bug" },
    ]),
  }),
  task({
    id: "w6",
    title: "Calendly booking → prep doc",
    kind: "workflow",
    platform: "slack",
    creatorName: "Apeksha M.",
    prompt: "When a meeting is booked, research the attendee and draft a prep doc",
    scheduleType: "external",
    scheduleValue: "canvas",
    scheduleLabel: "On new Calendly booking",
    nextRunAt: null,
    runCount: 19,
    stepCount: 3,
    appChain: ["calendly", "ai", "notion"],
    runHealth: ["ok", "ok", "ok", "ok", "ok"],
    triggerConfig: { type: "webhook", app: "calendly", eventDescription: "Invitee created", status: "active" },
    steps: steps([
      { id: "trigger", type: "trigger", label: "New booking" },
      { id: "research", type: "agent", label: "Research attendee" },
      { id: "doc", type: "action", label: "Draft prep doc in Notion" },
    ]),
  }),
  task({
    id: "w7",
    title: "Churn-risk alert → notify CS",
    kind: "workflow",
    platform: "slack",
    targetKindLabel: "Slack channel",
    targetLabel: "#cs",
    creatorName: "Roopak Nijhara",
    prompt: "Flag accounts with dropping usage and alert the CS team",
    scheduleLabel: "Every day at 7:00 AM",
    runCount: 30,
    stepCount: 3,
    appChain: ["sheets", "ai", "slack"],
    runHealth: ["ok", "ok", "ok", "ok", "ok"],
    triggerConfig: { type: "schedule", scheduleType: "cron", scheduleValue: "0 7 * * *" },
    steps: steps([
      { id: "trigger", type: "trigger", label: "Daily trigger" },
      { id: "score", type: "code", label: "Score usage trend" },
      { id: "alert", type: "agent", label: "Alert CS on risk" },
    ]),
  }),
];

// ── System / team-default tasks (Viktor's "System tasks" tab) ──────────────
export const SYSTEM_TASKS: MockTask[] = [
  task({
    id: "sys1",
    title: "Workflow Discovery",
    kind: "workflow",
    scope: "system",
    creatorName: "Sketch",
    prompt: "Scan recent activity for repetitive work worth automating",
    description: "Sketch proposes new automations based on what the team does repeatedly.",
    status: "paused",
    canPause: false,
    canResume: true,
    scheduleLabel: "Wed, Fri at 2:41 PM",
    scheduleValue: "41 14 * * 3,5",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    stepCount: 4,
    appChain: ["ai", "code"],
    runHealth: [],
    steps: steps([
      { id: "trigger", type: "trigger", label: "Twice-weekly scan" },
      { id: "scan", type: "agent", label: "Scan recent activity" },
      { id: "rank", type: "code", label: "Rank automation candidates" },
      { id: "propose", type: "agent", label: "Draft proposals" },
    ]),
  }),
  task({
    id: "sys2",
    title: "Onboarding Follow-up (Touch 1)",
    kind: "reminder",
    scope: "system",
    creatorName: "Sketch",
    prompt: "One-time follow-up to the workspace installer if they haven't interacted yet",
    description: "Sketch sends a one-time follow-up to the workspace installer if they have not interacted yet.",
    status: "paused",
    canPause: false,
    canResume: true,
    scheduleLabel: "Every 6 hours",
    scheduleValue: "0 */6 * * *",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
  }),
];

export const ALL_TASKS: MockTask[] = [...WORKFLOWS, ...REMINDERS, ...SYSTEM_TASKS];

/** Counts used by the ops-summary strips and tab badges. */
export function taskStats(tasks: MockTask[]) {
  return {
    total: tasks.length,
    active: tasks.filter((t) => t.status === "active").length,
    paused: tasks.filter((t) => t.status === "paused").length,
    failing: tasks.filter((t) => t.lastRunStatus === "failed").length,
    reminders: tasks.filter((t) => t.kind === "reminder").length,
    workflows: tasks.filter((t) => t.kind === "workflow").length,
  };
}
