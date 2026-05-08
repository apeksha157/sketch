/**
 * Home page route variants — matches the convention used by every other dashboard
 * page (channels, skills, integrations, etc.):
 *
 *   /home                          — admin, populated  (legacy HomePage)
 *   /home/empty                    — admin, first-time (legacy HomePage)
 *   /home/complete                 — admin, setup 100% done (legacy HomePage)
 *   /home/member                   — member, active (current canonical member design)
 *   /home/member-empty             — member, new user (current canonical member design)
 *   /home/member-old               — previous member design, active
 *   /home/member-old-empty         — previous member design, new user, verbose empties
 *   /home/member-old-empty-v2      — previous member design, new user, calm empties
 *   /home/member-old-walkthrough   — previous member design, with onboarding chatbot + coachmark tour
 *   /home/member-old-errors        — previous member design, notifications card (Iteration B)
 *   /home/member-old-iteration-a   — previous member design, notifications banner (Iteration A)
 */
import { SketchWidget } from "@/components/onboarding-widget";
import { useDashboardAuth } from "@/routes/dashboard";
import { HomePage } from "@/routes/home";
import {
  type ActiveSkill,
  type ExploreSuggestion,
  type FilesSummary,
  HomeMemberPage as HomeMemberPageNew,
  type HomeMemberPageProps,
  type IntegrationSummary,
  type RecentEvent,
  type TeamSummary,
  type UpcomingRun,
  type UsageSummary,
} from "@/routes/home-member";
import {
  type ActivityFeedItem,
  type DiscoverNudge,
  HomeMemberPage as HomeMemberPageOld,
  type NotificationItem,
} from "@/routes/home-member-old";
import { CalendarDotsIcon, ChatCircleIcon, MagnifyingGlassIcon, PlugIcon, TargetIcon } from "@phosphor-icons/react";
import { createRoute } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";
import { hideTrialBanner, setMemberRole } from "./mock-query-provider";

// ── Admin mocks ──────────────────────────────────────────────────────────────

const ADMIN_ACTIVITY = [
  {
    kind: "sketch" as const,
    icon: <CalendarDotsIcon size={16} />,
    title: "Weekly standup digest ran",
    outcome: "Posted summary to #team-product",
    day: "Today",
    time: "9:00 AM",
  },
  {
    kind: "user" as const,
    initials: "AD",
    title: "You triggered Meeting Summary",
    day: "Today",
    time: "8:42 AM",
  },
  {
    kind: "sketch" as const,
    icon: <MagnifyingGlassIcon size={16} />,
    title: "Competitive Intel ran",
    outcome: "Drafted report on 3 competitors",
    day: "Yesterday",
    time: "4:15 PM",
  },
  {
    kind: "user" as const,
    initials: "AD",
    title: "You asked about Q2 pipeline",
    day: "Yesterday",
    time: "2:30 PM",
  },
  {
    kind: "sketch" as const,
    icon: <ChatCircleIcon size={16} />,
    title: "Slack digest posted",
    outcome: "3 threads summarised",
    day: "Mon",
    time: "9:00 AM",
  },
];

const ADMIN_DISCOVER = [
  {
    kind: "skill" as const,
    icon: <TargetIcon size={16} />,
    name: "Lead Qualifier",
    description: "3 teammates use this to score inbound leads",
    href: "/skills",
  },
  {
    kind: "integration" as const,
    icon: <PlugIcon size={16} />,
    name: "Notion",
    description: "Connected by 2 teammates — give Sketch access to your docs",
    href: "/integrations",
  },
];

// ── Member mocks (Sarah Kim) — redesigned home shapes ────────────────────────

const MEMBER_ACTIVITY: ActivityFeedItem[] = [
  {
    id: "u1",
    type: "upcoming",
    skillName: "Competitive Intel",
    time: "2:00 PM",
    day: "today",
    meta: "scheduled · #market-research",
  },
  {
    id: "r1",
    type: "running",
    skillName: "Lead Qualifier",
    time: "11:24 AM",
    day: "today",
    meta: "processing 8 items",
  },
  {
    id: "t1",
    type: "completed_auto",
    skillName: "Meeting Summary",
    time: "9:45 AM",
    day: "today",
    meta: "12 msgs · #design-standups",
  },
  {
    id: "t2",
    type: "completed_user",
    skillName: "Account Research",
    time: "9:10 AM",
    day: "today",
    meta: "1m 24s",
  },
  {
    id: "y1",
    type: "completed_auto",
    skillName: "Daily forecast digest",
    time: "8:00 AM",
    day: "yesterday",
    meta: "Posted to your DM",
  },
  {
    id: "y2",
    type: "completed_user",
    skillName: "Lead Qualifier",
    time: "3:10 PM",
    day: "yesterday",
    meta: "32s",
  },
];

const MEMBER_DISCOVER: DiscoverNudge[] = [
  {
    id: "d1",
    type: "team_activity",
    title: "Priya started using Meeting Summary",
    description: "Running daily on #design-standups.",
    ctaLabel: "Try it yourself",
    ctaUrl: "/skills",
    dismissible: true,
  },
  {
    id: "d2",
    type: "popular",
    title: "Competitive Intel",
    description: "Used by 68% of teams your size.",
    ctaLabel: "Try this skill",
    ctaUrl: "/skills",
    dismissible: true,
  },
  {
    id: "d3",
    type: "product_update",
    title: "MCP integrations are here",
    description: "Connect external tools directly to Sketch.",
    ctaLabel: "Learn more",
    ctaUrl: "/integrations",
    dismissible: true,
  },
];

const MEMBER_NOTIFICATIONS: NotificationItem[] = [
  {
    id: "n1",
    type: "integration_disconnected",
    title: "Slack disconnected 2h ago",
    actionLabel: "Reconnect",
    actionUrl: "/integrations",
    severity: "critical",
  },
  {
    id: "n2",
    type: "automation_failed",
    title: "Lead Scoring failed at 6:12 AM",
    actionLabel: "View",
    actionUrl: "/scheduled-tasks",
    severity: "warning",
  },
];

const MEMBER_USAGE_ACTIVE = {
  messages: 27,
  messagesDelta: 12,
  skills: 4,
  skillsDelta: 100,
  automations: 9,
  automationsDelta: -4,
};

const MEMBER_USAGE_EMPTY = {
  messages: 0,
  messagesDelta: 0,
  skills: 0,
  skillsDelta: 0,
  automations: 0,
  automationsDelta: 0,
};

const MEMBER_SETUP_ACTIVE = {
  slack: true,
  firstConversation: true,
  firstSkill: true,
  integration: true,
  scheduledTask: true,
};

const MEMBER_SETUP_NEW = {
  slack: true,
  firstConversation: false,
  firstSkill: false,
  integration: false,
  scheduledTask: false,
};

const MEMBER_DIGEST_ACTIVE = {
  daysActive: 24,
  tasksRanToday: 4,
  nextScheduledLabel: "2:00 PM",
  hoursSavedThisWeek: 3,
  runningNow: 1,
  scheduledToday: 2,
};

const MEMBER_DIGEST_NEW = {
  daysActive: 2,
  tasksRanToday: 0,
  hoursSavedThisWeek: 0,
  runningNow: 0,
  scheduledToday: 0,
};

// ── Routes ───────────────────────────────────────────────────────────────────

export const homePreviewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home",
  beforeLoad: hideTrialBanner,
  component: () => <HomeMemberPageNew {...MEMBER_HOME_ACTIVE_PROPS} />,
});

export const homeAdminLegacyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/admin-legacy",
  beforeLoad: hideTrialBanner,
  component: () => (
    <HomePage
      setupSteps={{
        slack: true,
        firstConversation: true,
        firstSkill: true,
        integration: false,
        scheduledTask: false,
      }}
      activity={ADMIN_ACTIVITY}
      usage={{ messages: 42, messagesDelta: 40, skills: 8, skillsDelta: -27 }}
      discover={ADMIN_DISCOVER}
    />
  ),
});

export const homeEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/empty",
  beforeLoad: hideTrialBanner,
  component: () => <HomeMemberPageNew {...MEMBER_HOME_EMPTY_PROPS} />,
});

export const homeCompleteRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/complete",
  beforeLoad: hideTrialBanner,
  component: () => (
    <HomePage
      setupSteps={{
        slack: true,
        firstConversation: true,
        firstSkill: true,
        integration: true,
        scheduledTask: true,
      }}
      activity={ADMIN_ACTIVITY}
      usage={{ messages: 42, messagesDelta: 40, skills: 8, skillsDelta: -27 }}
      discover={ADMIN_DISCOVER}
    />
  ),
});

// ── Member routes (redesigned bento dashboard) ───────────────────────────────

export const homeMemberOldRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-old",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPageOld
      setupSteps={MEMBER_SETUP_ACTIVE}
      digest={MEMBER_DIGEST_ACTIVE}
      activity={MEMBER_ACTIVITY}
      usage={MEMBER_USAGE_ACTIVE}
      discover={MEMBER_DISCOVER}
      notifications={[]}
    />
  ),
});

export const homeMemberOldEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-old-empty",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPageOld
      setupSteps={MEMBER_SETUP_NEW}
      digest={MEMBER_DIGEST_NEW}
      activity={[]}
      usage={MEMBER_USAGE_EMPTY}
      discover={[]}
      notifications={[]}
    />
  ),
});

export const homeMemberOldEmptyV2Route = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-old-empty-v2",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPageOld
      setupSteps={MEMBER_SETUP_NEW}
      digest={MEMBER_DIGEST_NEW}
      activity={[]}
      usage={MEMBER_USAGE_EMPTY}
      discover={[]}
      notifications={[]}
      emptyVariant="calm"
    />
  ),
});

function HomeMemberOldWalkthrough() {
  const auth = useDashboardAuth();
  const firstName = auth.displayName.split(" ")[0] ?? auth.displayName;
  return (
    <>
      <HomeMemberPageOld
        setupSteps={MEMBER_SETUP_NEW}
        digest={MEMBER_DIGEST_NEW}
        activity={[]}
        usage={MEMBER_USAGE_EMPTY}
        discover={[]}
        notifications={[]}
      />
      <SketchWidget firstName={firstName} />
    </>
  );
}

export const homeMemberOldWalkthroughRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-old-walkthrough",
  beforeLoad: setMemberRole,
  component: HomeMemberOldWalkthrough,
});

export const homeMemberOldErrorsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-old-errors",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPageOld
      setupSteps={MEMBER_SETUP_ACTIVE}
      digest={MEMBER_DIGEST_ACTIVE}
      activity={MEMBER_ACTIVITY}
      usage={MEMBER_USAGE_ACTIVE}
      discover={MEMBER_DISCOVER}
      notifications={MEMBER_NOTIFICATIONS}
      notificationsMode="card"
    />
  ),
});

export const homeMemberOldIterationARoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-old-iteration-a",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPageOld
      setupSteps={MEMBER_SETUP_ACTIVE}
      digest={MEMBER_DIGEST_ACTIVE}
      activity={MEMBER_ACTIVITY}
      usage={MEMBER_USAGE_ACTIVE}
      discover={MEMBER_DISCOVER}
      notifications={MEMBER_NOTIFICATIONS}
      notificationsMode="banner"
    />
  ),
});

// ── New canonical member home (bento grid) ──────────────────────────────────

const MEMBER_HOME_ACTIVE_UPCOMING: UpcomingRun[] = [
  {
    id: "u1",
    title: "Daily standup digest",
    target: "#standup",
    time: "9:00 AM",
    relativeTime: "tomorrow",
  },
  {
    id: "u2",
    title: "Competitive intel sweep",
    target: "#market-research",
    time: "2:00 PM",
    relativeTime: "in 2h",
  },
];

const MEMBER_HOME_ACTIVE_RECENT: RecentEvent[] = [
  { kind: "sketch", id: "r1", title: "Standup digest sent", category: "comms", day: "Today", time: "9:02 AM" },
  { kind: "sketch", id: "r2", title: "Q2 pipeline summary", category: "reporting", day: "Today", time: "9:15 AM" },
  { kind: "user", id: "r3", title: "Sarah asked about launch", initials: "SK", day: "Today", time: "8:51 AM" },
  {
    kind: "scheduled",
    id: "r4",
    title: "Daily forecast digest",
    category: "reporting",
    day: "Yesterday",
    time: "8:00 AM",
  },
];

const MEMBER_HOME_ACTIVE_SKILLS: ActiveSkill[] = [
  { id: "s1", name: "Standup digest", category: "comms", lastUsedAt: null, lastUsedLabel: "ran 2h ago" },
  { id: "s2", name: "Lead qualifier", category: "crm", lastUsedAt: null, lastUsedLabel: "ran today" },
  { id: "s3", name: "Competitive intel", category: "research", lastUsedAt: null, lastUsedLabel: "ran 2d ago" },
];

const MEMBER_HOME_EXPLORE: ExploreSuggestion = {
  id: "e1",
  name: "Weekly roundup",
  description: "Digest every Monday morning",
  href: "/skills",
};

const MEMBER_HOME_TEAM_ACTIVE: TeamSummary = {
  totalCount: 8,
  humanCount: 6,
  agentCount: 2,
  pendingInvites: 0,
  members: [
    { id: "m1", initials: "SK", tint: "bg-blue-500/30 text-blue-700 dark:text-blue-200" },
    { id: "m2", initials: "MJ", tint: "bg-emerald-500/30 text-emerald-700 dark:text-emerald-200" },
    { id: "m3", initials: "JR", tint: "bg-violet-500/30 text-violet-700 dark:text-violet-200" },
  ],
};

const MEMBER_HOME_TEAM_EMPTY: TeamSummary = {
  totalCount: 1,
  humanCount: 1,
  agentCount: 0,
  pendingInvites: 0,
  members: [{ id: "self", initials: "SK", tint: "bg-blue-500/30 text-blue-700 dark:text-blue-200" }],
};

const MEMBER_HOME_INTEGRATIONS_ACTIVE: IntegrationSummary = {
  totalCount: 5,
  needsReconnectCount: 1,
  providers: [
    { id: "drive", tint: "bg-blue-500", status: "ok" },
    { id: "notion", tint: "bg-violet-500", status: "ok" },
    { id: "slack", tint: "bg-pink-500", status: "ok" },
    { id: "linear", tint: "bg-indigo-500", status: "ok" },
    { id: "fireflies", tint: "bg-orange-500", status: "error" },
  ],
};

const MEMBER_HOME_INTEGRATIONS_EMPTY: IntegrationSummary = {
  totalCount: 0,
  needsReconnectCount: 0,
  providers: [],
};

const MEMBER_HOME_USAGE_ACTIVE: UsageSummary = {
  messages: 247,
  messagesDelta: 12,
  automations: 32,
  automationsDelta: 4,
};

const MEMBER_HOME_USAGE_EMPTY: UsageSummary = {
  messages: 0,
  messagesDelta: 0,
  automations: 0,
  automationsDelta: 0,
};

const MEMBER_HOME_FILES_ACTIVE: FilesSummary = {
  entityCounts: { people: 24, companies: 8, projects: 12, databases: 4, documents: 168 },
  recentlyIndexed: [
    { id: "f1", fileName: "Q4 launch plan", source: "Drive", syncedLabel: "2h ago" },
    { id: "f2", fileName: "Customer interview notes", source: "Notion", syncedLabel: "today" },
    { id: "f3", fileName: "Pricing model v3", source: "Drive", syncedLabel: "today" },
  ],
  sources: [
    { id: "drive", name: "Drive", status: "ok" },
    { id: "notion", name: "Notion", status: "ok" },
    { id: "slack", name: "Slack", status: "ok" },
    { id: "linear", name: "Linear", status: "syncing" },
    { id: "fireflies", name: "Fireflies", status: "error" },
  ],
};

const MEMBER_HOME_FILES_EMPTY: FilesSummary = {
  entityCounts: { people: 0, companies: 0, projects: 0, databases: 0, documents: 0 },
  recentlyIndexed: [],
  sources: [],
};

const MEMBER_HOME_ACTIVE_PROPS: HomeMemberPageProps = {
  digest: MEMBER_DIGEST_ACTIVE,
  upcoming: MEMBER_HOME_ACTIVE_UPCOMING,
  recent: MEMBER_HOME_ACTIVE_RECENT,
  activeSkills: MEMBER_HOME_ACTIVE_SKILLS,
  exploreSuggestion: MEMBER_HOME_EXPLORE,
  team: MEMBER_HOME_TEAM_ACTIVE,
  integrations: MEMBER_HOME_INTEGRATIONS_ACTIVE,
  usage: MEMBER_HOME_USAGE_ACTIVE,
  files: MEMBER_HOME_FILES_ACTIVE,
};

const MEMBER_HOME_EMPTY_PROPS: HomeMemberPageProps = {
  digest: MEMBER_DIGEST_NEW,
  upcoming: [],
  recent: [],
  activeSkills: [],
  exploreSuggestion: MEMBER_HOME_EXPLORE,
  team: MEMBER_HOME_TEAM_EMPTY,
  integrations: MEMBER_HOME_INTEGRATIONS_EMPTY,
  usage: MEMBER_HOME_USAGE_EMPTY,
  files: MEMBER_HOME_FILES_EMPTY,
};

export const homeMemberRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member",
  beforeLoad: setMemberRole,
  component: () => <HomeMemberPageNew {...MEMBER_HOME_ACTIVE_PROPS} />,
});

export const homeMemberEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-empty",
  beforeLoad: setMemberRole,
  component: () => <HomeMemberPageNew {...MEMBER_HOME_EMPTY_PROPS} />,
});
