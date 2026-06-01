import type { ScheduledTaskListItem } from "@/lib/api";
import { ScheduledTasksPage } from "@/routes/scheduled-tasks";
import { createRoute } from "@tanstack/react-router";
import { MockQueryProvider, hideTrialBanner, setMemberRole } from "./mock-query-provider";
import { previewRoute } from "./preview-route";

const now = new Date().toISOString();
const tomorrow = new Date(Date.now() + 86400000).toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();

const DEMO_DATA: ScheduledTaskListItem[] = [
  {
    id: "t1",
    platform: "slack",
    contextType: "channel",
    deliveryTarget: "#general",
    threadTs: null,
    prompt: "Summarize yesterday's key discussions and action items from all channels",
    scheduleType: "cron",
    scheduleValue: "0 9 * * 1-5",
    timezone: "America/New_York",
    sessionMode: "fresh",
    nextRunAt: tomorrow,
    lastRunAt: yesterday,
    status: "active",
    createdBy: "u1",
    createdAt: now,
    targetLabel: "#general",
    targetKindLabel: "Slack channel",
    creatorName: "Alex Chen",
    scheduleLabel: "Weekdays at 9:00 AM",
    canPause: true,
    canResume: false,
    canDelete: true,
    title: null,
    description: null,
    steps: null,
    stepCount: 0,
    triggerConfig: null,
    outputTarget: null,
    outputPlatform: null,
    outputMode: "deliver",
    lastRunStatus: null,
    runCount: 0,
  },
  {
    id: "t2",
    platform: "slack",
    contextType: "dm",
    deliveryTarget: "U02DEF",
    threadTs: null,
    prompt: "Check open PRs and remind me of any that need review",
    scheduleType: "cron",
    scheduleValue: "0 10 * * 1-5",
    timezone: "America/New_York",
    sessionMode: "fresh",
    nextRunAt: tomorrow,
    lastRunAt: yesterday,
    status: "active",
    createdBy: "u2",
    createdAt: now,
    targetLabel: "Sarah Kim",
    targetKindLabel: "Slack DM",
    creatorName: "Sarah Kim",
    scheduleLabel: "Weekdays at 10:00 AM",
    canPause: true,
    canResume: false,
    canDelete: true,
    title: null,
    description: null,
    steps: null,
    stepCount: 0,
    triggerConfig: null,
    outputTarget: null,
    outputPlatform: null,
    outputMode: "deliver",
    lastRunStatus: null,
    runCount: 0,
  },
  {
    id: "t3",
    platform: "whatsapp",
    contextType: "dm",
    deliveryTarget: "+15551234567",
    threadTs: null,
    prompt: "Send weekly metrics digest with key KPIs",
    scheduleType: "cron",
    scheduleValue: "0 8 * * 1",
    timezone: "America/New_York",
    sessionMode: "fresh",
    nextRunAt: tomorrow,
    lastRunAt: yesterday,
    status: "paused",
    createdBy: "u1",
    createdAt: now,
    targetLabel: "Alex Chen",
    targetKindLabel: "WhatsApp DM",
    creatorName: "Alex Chen",
    scheduleLabel: "Mondays at 8:00 AM",
    canPause: false,
    canResume: true,
    canDelete: true,
    title: null,
    description: null,
    steps: null,
    stepCount: 0,
    triggerConfig: null,
    outputTarget: null,
    outputPlatform: null,
    outputMode: "deliver",
    lastRunStatus: null,
    runCount: 0,
  },
  {
    id: "t4",
    platform: "slack",
    contextType: "channel",
    deliveryTarget: "#sales",
    threadTs: null,
    prompt: "Generate end-of-day pipeline summary with deal movements",
    scheduleType: "cron",
    scheduleValue: "0 17 * * 1-5",
    timezone: "America/New_York",
    sessionMode: "fresh",
    nextRunAt: null,
    lastRunAt: yesterday,
    status: "completed",
    createdBy: "u2",
    createdAt: now,
    targetLabel: "#sales",
    targetKindLabel: "Slack channel",
    creatorName: "Sarah Kim",
    scheduleLabel: "Weekdays at 5:00 PM",
    canPause: false,
    canResume: false,
    canDelete: true,
    title: null,
    description: null,
    steps: null,
    stepCount: 0,
    triggerConfig: null,
    outputTarget: null,
    outputPlatform: null,
    outputMode: "deliver",
    lastRunStatus: null,
    runCount: 0,
  },
];

export const scheduledTasksPreviewRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/scheduled-tasks",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["scheduled-tasks"], data: DEMO_DATA }]}>
      <ScheduledTasksPage />
    </MockQueryProvider>
  ),
});

export const scheduledTasksEmptyRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/scheduled-tasks/empty",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["scheduled-tasks"], data: [] }]}>
      <ScheduledTasksPage />
    </MockQueryProvider>
  ),
});

export const scheduledTasksMemberRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/scheduled-tasks/member",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["scheduled-tasks"], data: DEMO_DATA }]}>
      <ScheduledTasksPage />
    </MockQueryProvider>
  ),
});

export const scheduledTasksMemberEmptyRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/scheduled-tasks/member-empty",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["scheduled-tasks"], data: [] }]}>
      <ScheduledTasksPage />
    </MockQueryProvider>
  ),
});
