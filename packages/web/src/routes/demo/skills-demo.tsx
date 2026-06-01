import { categoryMeta } from "@/lib/skills-data";
import type { Skill } from "@/lib/skills-data";
import { SkillsPage } from "@/routes/skills";
import { createRoute } from "@tanstack/react-router";
import { MockQueryProvider, hideTrialBanner, setMemberRole } from "./mock-query-provider";
import { previewRoute } from "./preview-route";

const now = new Date();

const DEMO_SKILLS: Skill[] = [
  {
    id: "s1",
    name: "Meeting Summary",
    description: "Summarizes meeting notes into action items and key takeaways",
    body: "You are a meeting notes assistant. Summarize the meeting transcript into: 1) Key decisions, 2) Action items with owners, 3) Open questions.",
    category: "productivity",
    status: { org: true, channels: [], individuals: [] },
    iconBg: categoryMeta.productivity.iconBg,
    iconEmoji: categoryMeta.productivity.iconEmoji,
    source: undefined,
    lastUsedAt: null,
    createdAt: now,
  },
  {
    id: "s2",
    name: "Code Review",
    description: "Reviews pull requests for bugs, style, and best practices",
    body: "Review the given code diff. Check for: bugs, security issues, performance concerns, and style consistency. Provide actionable feedback.",
    category: "engineering",
    status: { org: true, channels: [], individuals: [] },
    iconBg: categoryMeta.engineering.iconBg,
    iconEmoji: categoryMeta.engineering.iconEmoji,
    source: undefined,
    lastUsedAt: null,
    createdAt: now,
  },
  {
    id: "s3",
    name: "Lead Qualifier",
    description: "Scores inbound leads based on ICP fit and buying signals",
    body: "Analyze the lead information and score from 1-10 based on: company size, industry fit, engagement level, and budget signals.",
    category: "sales",
    status: { org: true, channels: [], individuals: [] },
    iconBg: categoryMeta.sales.iconBg,
    iconEmoji: categoryMeta.sales.iconEmoji,
    source: undefined,
    lastUsedAt: null,
    createdAt: now,
  },
  {
    id: "s4",
    name: "Competitive Intel",
    description: "Researches competitors and summarizes positioning changes",
    body: "Research the given competitor. Report on: recent product changes, pricing updates, messaging shifts, and market positioning.",
    category: "research",
    status: { org: true, channels: [], individuals: [] },
    iconBg: categoryMeta.research.iconBg,
    iconEmoji: categoryMeta.research.iconEmoji,
    source: undefined,
    lastUsedAt: null,
    createdAt: now,
  },
  {
    id: "s5",
    name: "Weekly Report",
    description: "Generates a weekly progress report from Slack activity",
    body: "Compile a weekly report from the team's Slack messages. Include: completed items, blockers, and upcoming priorities.",
    category: "reporting",
    status: { org: true, channels: [], individuals: [] },
    iconBg: categoryMeta.reporting.iconBg,
    iconEmoji: categoryMeta.reporting.iconEmoji,
    source: undefined,
    lastUsedAt: null,
    createdAt: now,
  },
  {
    id: "s6",
    name: "Customer Reply",
    description: "Drafts empathetic support replies to customer issues",
    body: "Draft a support reply that: acknowledges the issue, provides a solution or next steps, and maintains a friendly, professional tone.",
    category: "support",
    status: { org: true, channels: [], individuals: [] },
    iconBg: categoryMeta.support.iconBg,
    iconEmoji: categoryMeta.support.iconEmoji,
    source: undefined,
    lastUsedAt: null,
    createdAt: now,
  },
];

export const skillsPreviewRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/skills",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["skills"], data: { skills: DEMO_SKILLS } }]}>
      <SkillsPage />
    </MockQueryProvider>
  ),
});

export const skillsEmptyRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/skills/empty",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["skills"], data: { skills: [] } }]}>
      <SkillsPage />
    </MockQueryProvider>
  ),
});

export const skillsMemberRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/skills/member",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["skills"], data: { skills: DEMO_SKILLS } }]}>
      <SkillsPage />
    </MockQueryProvider>
  ),
});

export const skillsMemberEmptyRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/skills/member-empty",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["skills"], data: { skills: [] } }]}>
      <SkillsPage />
    </MockQueryProvider>
  ),
});
