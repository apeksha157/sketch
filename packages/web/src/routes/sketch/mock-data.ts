/**
 * Mock data for the Sketch v1 demo routes. The production app will swap these
 * out for live queries; the shapes here match what the components expect.
 *
 * Timestamps are constructed relative to "now" so the relative-time formatter
 * (§4.7) produces realistic output regardless of when the demo is opened.
 */
import type { ConversationRowProps } from "@/components/sketch/conversation-row";
import type { HomeDigest } from "@/routes/home";

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function isoHoursAgo(hr: number): string {
  return new Date(Date.now() - hr * 3_600_000).toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export const MOCK_PROFILE = {
  name: "Apeksha Maithani",
  firstName: "Apeksha",
  isAdmin: true,
  identifier: "ops@canvasx.ai",
} as const;

export const MOCK_RECENTS: ConversationRowProps[] = [
  {
    id: "c-001",
    title: "Triage inbox from last 24h",
    channel: "web",
    occurredAt: isoMinutesAgo(18),
  },
  {
    id: "c-002",
    title: "Draft reply to Hubspot trial follow-up",
    channel: "slack",
    occurredAt: isoHoursAgo(3),
  },
  {
    id: "c-003",
    title: "Weekly standup digest",
    channel: "slack",
    occurredAt: isoHoursAgo(20),
  },
  {
    id: "c-004",
    title: "Summarize Tom's PR comments",
    channel: "whatsapp",
    occurredAt: isoDaysAgo(1),
  },
  {
    id: "c-005",
    title: "Catch up on #team-product",
    channel: "slack",
    occurredAt: isoDaysAgo(2),
  },
];

/** Full conversation history for /conversations. Larger than recents. */
export const MOCK_ALL_CONVERSATIONS: ConversationRowProps[] = [
  ...MOCK_RECENTS,
  {
    id: "c-006",
    title: "Schedule monthly metrics roundup",
    channel: "web",
    occurredAt: isoDaysAgo(2),
  },
  {
    id: "c-007",
    title: "Find files about pricing experiment",
    channel: "web",
    occurredAt: isoDaysAgo(3),
  },
  {
    id: "c-008",
    title: "Slack digest posted",
    channel: "slack",
    occurredAt: isoDaysAgo(4),
  },
  {
    id: "c-009",
    title: "Brief: Q2 OKR retro",
    channel: "web",
    occurredAt: isoDaysAgo(6),
  },
  {
    id: "c-010",
    title: "Tom asked about onboarding metrics",
    channel: "whatsapp",
    occurredAt: isoDaysAgo(9),
  },
  {
    id: "c-011",
    title: "Competitive intel: 3 competitors",
    channel: "web",
    occurredAt: isoDaysAgo(14),
  },
  {
    id: "c-012",
    title: "Draft NDA reply",
    channel: "slack",
    occurredAt: isoDaysAgo(21),
  },
  {
    id: "c-013",
    title: "Re-org doc check-in",
    channel: "web",
    occurredAt: isoDaysAgo(30),
  },
];

/** Drives the digest-aware subtitle under the greeting (mirrors /home). */
export const MOCK_DIGEST: HomeDigest = {
  daysActive: 30,
  tasksRanToday: 3,
  nextScheduledLabel: "5:00 PM",
  hoursSavedThisWeek: 2,
  runningNow: 1,
  scheduledToday: 2,
};

/** Brand-new workspace — pickSubtitle's daysActive < 7 branch surfaces nudges
 * instead of production-state snapshots, which is the right framing for the
 * /home/setup state. */
export const MOCK_SETUP_DIGEST: HomeDigest = {
  daysActive: 0,
  tasksRanToday: 0,
  hoursSavedThisWeek: 0,
  runningNow: 0,
  scheduledToday: 0,
};

export const MOCK_CREDITS = {
  count: 1240,
  total: 1500,
  renewsAt: "Renews May 21",
};

export const MOCK_CREDITS_LOW = {
  count: 84,
  total: 1500,
  renewsAt: "Renews May 21",
  low: true,
};

/**
 * Files card mock — the "brain of the org" surface in the sidebar. Three
 * meaningful buckets (docs / calls / memos) so the breakdown line reads as
 * org memory rather than a generic file dump.
 */
export const MOCK_FILES = {
  total: 197,
  breakdown: {
    docs: 128,
    calls: 47,
    memos: 22,
  },
};

/** Cold-start variant — new workspace, nothing ingested yet. */
export const MOCK_FILES_EMPTY = {
  total: 0,
};
