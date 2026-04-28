/**
 * Home page route variants — matches the convention used by every other dashboard
 * page (channels, skills, integrations, etc.):
 *
 *   /home                  — admin, populated
 *   /home/empty            — admin, first-time / nothing done
 *   /home/member           — member, populated
 *   /home/member-empty     — member, first-time
 *   /home/complete         — bonus: setup 100% done (checklist hidden)
 *
 * The `HomePage` component is shared; each variant supplies its own mock content
 * so the design demo can show every state without a real backend.
 */
import { HomePage } from "@/routes/home";
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

// ── Member mocks (Sarah Kim — different person, different data) ──────────────

const MEMBER_ACTIVITY = [
  {
    kind: "user" as const,
    initials: "SK",
    title: "You triggered Lead Qualifier",
    day: "Today",
    time: "11:20 AM",
  },
  {
    kind: "sketch" as const,
    icon: <MagnifyingGlassIcon size={16} />,
    title: "Account research ran",
    outcome: "Brief on Acme Corp drafted",
    day: "Today",
    time: "9:45 AM",
  },
  {
    kind: "user" as const,
    initials: "SK",
    title: "You asked about pipeline coverage",
    day: "Yesterday",
    time: "3:10 PM",
  },
  {
    kind: "sketch" as const,
    icon: <CalendarDotsIcon size={16} />,
    title: "Daily forecast digest ran",
    outcome: "Posted to your DM",
    day: "Yesterday",
    time: "8:00 AM",
  },
];

const MEMBER_DISCOVER = [
  {
    kind: "skill" as const,
    icon: <ChatCircleIcon size={16} />,
    name: "Meeting Summary",
    description: "Most-used skill on your team — 14 runs this week",
    href: "/skills",
  },
];

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

export const homeMemberRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member",
  beforeLoad: setMemberRole,
  component: () => (
    <HomePage
      setupSteps={{
        slack: true,
        firstConversation: true,
        firstSkill: true,
        integration: false,
        scheduledTask: false,
      }}
      activity={MEMBER_ACTIVITY}
      usage={{ messages: 27, messagesDelta: 23, skills: 4, skillsDelta: 100 }}
      discover={MEMBER_DISCOVER}
    />
  ),
});

export const homeMemberEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home/member-empty",
  beforeLoad: setMemberRole,
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
