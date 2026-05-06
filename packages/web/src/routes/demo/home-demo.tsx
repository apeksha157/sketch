/**
 * Home page route variants — matches the convention used by every other dashboard
 * page (channels, skills, integrations, etc.):
 *
 *   /home                       — admin, populated  (legacy HomePage)
 *   /home/empty                 — admin, first-time (legacy HomePage)
 *   /home/complete              — admin, setup 100% done (legacy HomePage)
 *   /home/member                — member, active, no errors (redesign)
 *   /home/member-empty          — member, new user, verbose empties (current)
 *   /home/member-empty-v2       — member, new user, calm empties (single teacher: Discover/Setup)
 *   /home/member-walkthrough    — member, new user, with onboarding chatbot widget + coachmark tour
 *   /home/member-errors         — member with notifications card (Iteration B)
 *   /home/member-iteration-a    — member with notifications as banner (Iteration A)
 */
import { SketchWidget } from "@/components/onboarding-widget";
import { useDashboardAuth } from "@/routes/dashboard";
import { HomePage } from "@/routes/home";
import { type ActivityFeedItem, type DiscoverNudge, HomeMemberPage, type NotificationItem } from "@/routes/home-member";
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
  component: () => (
    <HomePage
      setupSteps={{
        slack: true,
        firstConversation: false,
        firstSkill: false,
        integration: false,
        scheduledTask: false,
      }}
      activity={[]}
      usage={{ messages: 0, messagesDelta: 0, skills: 0, skillsDelta: 0 }}
      discover={[]}
      digest={{
        daysActive: 2,
        tasksRanToday: 0,
        hoursSavedThisWeek: 0,
        runningNow: 0,
        scheduledToday: 0,
      }}
    />
  ),
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

export const homeMemberRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPage
      setupSteps={MEMBER_SETUP_ACTIVE}
      digest={MEMBER_DIGEST_ACTIVE}
      activity={MEMBER_ACTIVITY}
      usage={MEMBER_USAGE_ACTIVE}
      discover={MEMBER_DISCOVER}
      notifications={[]}
    />
  ),
});

export const homeMemberEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-empty",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPage
      setupSteps={MEMBER_SETUP_NEW}
      digest={MEMBER_DIGEST_NEW}
      activity={[]}
      usage={MEMBER_USAGE_EMPTY}
      discover={[]}
      notifications={[]}
    />
  ),
});

export const homeMemberEmptyV2Route = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-empty-v2",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPage
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

function HomeMemberWalkthrough() {
  const auth = useDashboardAuth();
  const firstName = auth.displayName.split(" ")[0] ?? auth.displayName;
  return (
    <>
      <HomeMemberPage
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

export const homeMemberWalkthroughRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-walkthrough",
  beforeLoad: setMemberRole,
  component: HomeMemberWalkthrough,
});

export const homeMemberErrorsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-errors",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPage
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

export const homeMemberIterationARoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-iteration-a",
  beforeLoad: setMemberRole,
  component: () => (
    <HomeMemberPage
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
