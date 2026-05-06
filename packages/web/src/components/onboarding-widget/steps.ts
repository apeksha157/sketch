import type { WalkthroughStep } from "./types";

/**
 * Targets are matched via `data-walkthrough-target` attributes set on
 * elements in `home-member.tsx` and `app-sidebar.tsx`. Adding a step here
 * without setting the corresponding attribute will fall through to a
 * centered fallback tooltip.
 */
export const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  {
    index: 1,
    selector: '[data-walkthrough-target="activity-card"]',
    placement: "bottom",
    body: "This is your activity feed. Every time I run a task — scheduled or triggered by you — it shows up here. You can set schedules from Scheduled Tasks in the sidebar.",
    cta: "Next",
  },
  {
    index: 2,
    selector: '[data-walkthrough-target="sidebar-skills"]',
    placement: "right",
    body: "This is what I can do. Summarize meetings, qualify leads, run research — browse what's available or ask your admin to create new ones.",
    cta: "Next",
  },
  {
    index: 3,
    selector: '[data-walkthrough-target="setup-checklist"]',
    placement: "bottom",
    body: "Start here. These steps will walk you through your first conversation and your first skill.",
    cta: "Next",
  },
  {
    index: 4,
    selector: '[data-walkthrough-target="sidebar"]',
    placement: "right",
    body: "The rest lives here — your channels, team, usage, and integrations. Explore when you're ready.",
    cta: "Done",
  },
];
