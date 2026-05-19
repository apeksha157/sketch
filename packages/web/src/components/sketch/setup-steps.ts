/**
 * Canonical setup-step data.
 *
 * Single source of truth for the 5-step onboarding sequence. The v1 SetupBanner
 * (top-banner.tsx) and the persistent sidebar nudge (sidebar-setup-nudge.tsx)
 * both read from this array so copy, verbs, and step counts never drift between
 * surfaces. Keep this list in sync with product onboarding state.
 */

export type SetupStepKey = "channel" | "teammate" | "integration" | "skill" | "schedule";

export interface StepDef {
  key: SetupStepKey;
  /** Single-noun label rendered under the circle in the stepper. Never a verb. */
  shortLabel: string;
  /** Verb-first title shown in the action area when this step is current. */
  title: string;
  /** One sentence, two clauses joined by an em dash — action then why. */
  description: string;
  /** Duration estimate ("~1 MIN"). Only steps with a meaningful estimate carry one. */
  time?: string;
  /** Primary CTA label. Must not repeat any verb from the step title. */
  cta: string;
}

export const STEPS: StepDef[] = [
  {
    key: "channel",
    shortLabel: "Platforms",
    title: "Plug Sketch into your chat",
    description: "Slack or WhatsApp — wherever your team's already talking.",
    time: "~30 sec",
    cta: "Connect",
  },
  {
    key: "teammate",
    shortLabel: "Team",
    title: "Bring in a teammate",
    description: "Sketch gets sharper the more of your team it works with.",
    time: "~1 min",
    cta: "Invite",
  },
  {
    key: "integration",
    shortLabel: "Apps",
    title: "Hook up a tool",
    description: "Gmail, Notion, Drive, Linear, or any of 300+ others — give Sketch the context it needs.",
    time: "~2 min",
    cta: "Connect",
  },
  {
    key: "skill",
    shortLabel: "Skills",
    title: "Teach Sketch a skill",
    description: "Show it a workflow once — it'll run that on a schedule or whenever you ask.",
    time: "~3 min",
    cta: "Build",
  },
  {
    key: "schedule",
    shortLabel: "Tasks",
    title: "Set a schedule",
    description: "Pick a cadence — Sketch runs it on its own from there.",
    time: "~1 min",
    // "Automate" reads more confident than "Choose" (which begged the
    // question "choose what?") and captures the outcome the user cares
    // about: this is the step that makes Sketch run on its own.
    cta: "Automate",
  },
];
