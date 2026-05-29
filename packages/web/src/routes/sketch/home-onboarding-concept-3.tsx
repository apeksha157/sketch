/**
 * /home/onboarding-concept-3 — Show + Do split-screen.
 *
 * The most didactic of the four concepts. Each setup step opens a focused
 * full-screen split:
 *
 *   ┌──────────────────────────┬──────────────────────────┐
 *   │  WHAT YOU'LL GET         │  SET IT UP               │
 *   │  (visual preview of      │  (the actual form /      │
 *   │   the outcome — Slack    │   connect button —       │
 *   │   thread with Sketch     │   OAuth, dropdown, etc)  │
 *   │   replying, etc.)        │                          │
 *   └──────────────────────────┴──────────────────────────┘
 *
 * Top chrome carries `STEP N OF 5 · {label}` + progress dots + a Skip
 * button. Bottom chrome carries Back / Skip / primary CTA. The left pane is
 * the "show" half — a stylized preview of what the user will get once this
 * step is complete. The right pane is the "do" half — the actual setup UI.
 * Spatially enforces Himanshu's WHAT/HOW split.
 *
 * Two routes for design review:
 *   /home/onboarding-concept-3      — step 1 (Connect Slack)
 *   /home/onboarding-concept-3-mid  — step 3 (Invite teammates), 2 of 5 done
 *
 * Once all 5 are complete in production, the user lands on the normal
 * dashboard. The sidebar stays visible for context but the main pane is
 * fully owned by the split view.
 */
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarTimeIcon,
  ChannelsIcon,
  CheckIcon,
  type IconProps,
  PuzzleIcon,
  SlackBrandIcon,
  SparklesIcon,
  UserPlusIcon,
} from "@/components/sketch/icons";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_FILES_EMPTY } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { XIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute, useNavigate } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";

interface StepDef {
  id: string;
  shortLabel: string;
  fullLabel: string;
  icon: ComponentType<IconProps>;
  showPreview: ReactNode;
  doForm: ReactNode;
  primaryCta: string;
  secondaryCta: string;
}

interface PageState {
  /** 1-based current step. */
  currentStep: number;
  /** Which prior steps are marked done. */
  completedIds: string[];
}

function HomeOnboardingConcept3PageImpl({ state }: { state: PageState }) {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const allSteps = makeSteps();
  const total = allSteps.length;
  const currentDef = allSteps[state.currentStep - 1];
  const doneCount = state.completedIds.length;

  function handleSkip() {
    void navigate({ to: "/home/default" });
  }

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      files={MOCK_FILES_EMPTY}
      mainClassName="overflow-hidden"
    >
      <div className="flex h-full min-h-0 flex-col">
        <TopChrome
          currentStep={state.currentStep}
          total={total}
          stepLabel={currentDef.shortLabel}
          completedIds={state.completedIds}
          steps={allSteps}
          onSkip={handleSkip}
        />

        {/* Split body — left = preview / show, right = form / do. */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ShowPane>{currentDef.showPreview}</ShowPane>
          <DoPane
            stepNumber={state.currentStep}
            stepFullLabel={currentDef.fullLabel}
            icon={currentDef.icon}
            primaryCta={currentDef.primaryCta}
            secondaryCta={currentDef.secondaryCta}
            doneCount={doneCount}
            total={total}
          >
            {currentDef.doForm}
          </DoPane>
        </div>

        <BottomChrome
          currentStep={state.currentStep}
          total={total}
          primaryCta={currentDef.primaryCta}
          onBack={() => navigate({ to: "/home/default" })}
        />
      </div>
    </SketchShell>
  );
}

// ─── Chrome ────────────────────────────────────────────────────────────────

function TopChrome({
  currentStep,
  total,
  stepLabel,
  completedIds,
  steps,
  onSkip,
}: {
  currentStep: number;
  total: number;
  stepLabel: string;
  completedIds: string[];
  steps: StepDef[];
  onSkip: () => void;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-[16px] border-b border-border bg-background",
        "px-[24px] py-[14px]",
      )}
    >
      {/* Eyebrow + step label. */}
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.14em" }}>
          Set up Sketch
        </span>
        <span className="text-[13px] font-medium text-foreground">
          <span className="text-muted-foreground">
            Step {currentStep} of {total} ·
          </span>{" "}
          {stepLabel}
        </span>
      </div>

      {/* Progress dots — centered. */}
      <div className="ml-auto flex shrink-0 items-center gap-[6px]" aria-hidden>
        {steps.map((step, idx) => {
          const n = idx + 1;
          const done = completedIds.includes(step.id);
          const current = n === currentStep;
          return (
            <span
              key={step.id}
              className={cn(
                "h-[8px] rounded-full transition-all",
                done && "w-[8px] bg-foreground",
                !done && current && "w-[24px] bg-[#FEED01]",
                !done && !current && "w-[8px] bg-foreground/[0.15]",
              )}
            />
          );
        })}
      </div>

      {/* Exit affordance — universal × icon rather than another "Skip" label.
       * The bottom row already has a per-step Skip; reusing the same verb up
       * top read as a duplicate (caught in audit). The × is the conventional
       * "close this view" pattern. */}
      <button
        type="button"
        onClick={onSkip}
        aria-label="Exit setup"
        className={cn(
          "ml-[6px] inline-flex h-[28px] w-[28px] items-center justify-center rounded-[8px]",
          "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors duration-100 ease-out cursor-pointer",
        )}
      >
        <XIcon size={14} weight="bold" aria-hidden />
      </button>
    </div>
  );
}

function BottomChrome({
  currentStep,
  total: _total,
  primaryCta,
  onBack,
}: {
  currentStep: number;
  total: number;
  primaryCta: string;
  onBack: () => void;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-[12px] border-t border-border bg-background",
        "px-[24px] py-[14px]",
      )}
    >
      <button
        type="button"
        onClick={onBack}
        disabled={currentStep === 1}
        className={cn(
          "inline-flex items-center gap-[6px] rounded-[8px] px-[12px] py-[7px] text-[12px]",
          "transition-colors duration-100 ease-out cursor-pointer",
          currentStep === 1
            ? "text-muted-foreground/40 cursor-not-allowed"
            : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
        )}
      >
        <ArrowLeftIcon size={13} weight="bold" aria-hidden />
        Back
      </button>

      <div className="flex items-center gap-[10px]">
        {/* Per-step skip — distinct from the top-right "Skip setup" which
         * exits the entire flow. Labeled explicitly so the two skips can't
         * be confused for the same thing. */}
        <button
          type="button"
          className="text-[12px] text-muted-foreground hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
        >
          Skip this step
        </button>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-[6px] rounded-[10px] px-[18px] py-[9px] text-[13px] font-medium",
            "bg-[#FEED01] text-[#1a1a18] hover:brightness-95 transition-all cursor-pointer",
          )}
        >
          {primaryCta}
          <ArrowRightIcon size={12} weight="bold" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ─── Panes ─────────────────────────────────────────────────────────────────

function ShowPane({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-1/2 min-w-0 flex-col overflow-y-auto border-r border-border bg-[#FAF8F0] dark:bg-[#15140F]">
      <div className="px-[28px] pt-[28px] pb-[16px]">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.14em" }}>
          What you'll get
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center px-[28px] pb-[28px]">{children}</div>
    </div>
  );
}

function DoPane({
  stepNumber,
  stepFullLabel,
  icon: Icon,
  children,
}: {
  stepNumber: number;
  stepFullLabel: string;
  icon: ComponentType<IconProps>;
  primaryCta: string;
  secondaryCta: string;
  doneCount: number;
  total: number;
  children: ReactNode;
}) {
  return (
    <div className="flex w-1/2 min-w-0 flex-col overflow-y-auto bg-background">
      <div className="px-[28px] pt-[28px] pb-[16px]">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.14em" }}>
          Set it up
        </span>
        <div className="mt-[14px] flex items-center gap-[12px]">
          <span
            className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[10px] bg-[#FAF3BD] text-[#8B7A00] dark:bg-[#322B0C] dark:text-[#FEED01]"
            aria-hidden
          >
            <Icon size={18} weight="regular" />
          </span>
          <h2 className="text-[18px] font-semibold text-foreground leading-tight">{stepFullLabel}</h2>
        </div>
      </div>
      <div className="flex-1 px-[28px] pb-[28px]">{children}</div>
    </div>
  );
}

// ─── Step content ──────────────────────────────────────────────────────────

function makeSteps(): StepDef[] {
  return [
    {
      id: "channel",
      shortLabel: "Connect channels",
      fullLabel: "Connect Slack",
      icon: ChannelsIcon,
      showPreview: <SlackPreview />,
      doForm: <SlackForm />,
      primaryCta: "Connect Slack",
      secondaryCta: "Skip for now",
    },
    {
      id: "integration",
      shortLabel: "Add integrations",
      fullLabel: "Connect Notion",
      icon: PuzzleIcon,
      showPreview: <IntegrationsPreview />,
      doForm: <IntegrationsForm />,
      primaryCta: "Connect Notion",
      secondaryCta: "Skip for now",
    },
    {
      id: "teammate",
      shortLabel: "Invite teammates",
      fullLabel: "Invite your team",
      icon: UserPlusIcon,
      showPreview: <TeammatePreview />,
      doForm: <TeammateForm />,
      primaryCta: "Send invites",
      secondaryCta: "Skip for now",
    },
    {
      id: "skill",
      shortLabel: "Create a skill",
      fullLabel: "Build your first skill",
      icon: SparklesIcon,
      showPreview: <SkillPreview />,
      doForm: <SkillForm />,
      primaryCta: "Build skill",
      secondaryCta: "Skip for now",
    },
    {
      id: "schedule",
      shortLabel: "Schedule a task",
      fullLabel: "Set a schedule",
      icon: CalendarTimeIcon,
      showPreview: <SchedulePreview />,
      doForm: <ScheduleForm />,
      primaryCta: "Set schedule",
      secondaryCta: "Skip for now",
    },
  ];
}

// ─── Step 1 — Connect Slack ────────────────────────────────────────────────

function SlackPreview() {
  return (
    <div className="w-full max-w-[420px]">
      {/* Faux Slack window — communicates "this is what Sketch does inside
       * your Slack" without being a literal copy of the Slack UI. */}
      <div className="rounded-[14px] border border-border bg-card shadow-[0_18px_40px_-12px_rgba(0,0,0,0.18)]">
        {/* Header */}
        <div className="flex items-center gap-[8px] border-b border-border px-[14px] py-[10px]">
          <span className="size-[10px] rounded-full bg-[#FF6157]" />
          <span className="size-[10px] rounded-full bg-[#FFC12F]" />
          <span className="size-[10px] rounded-full bg-[#28CA42]" />
          <span className="ml-[8px] text-[11px] font-medium text-foreground">#team-product</span>
          <span className="ml-auto text-[10px] text-muted-foreground">slack</span>
        </div>

        {/* Messages */}
        <div className="flex flex-col gap-[10px] p-[14px]">
          <FauxSlackMessage
            initials="MR"
            name="Maria Rodriguez"
            time="9:01 AM"
            body="@sketch can you catch us up on what shipped this week?"
          />
          <FauxSketchMessage time="9:01 AM">
            <p className="text-[12.5px] leading-[1.5] text-foreground/85">Sure — three things shipped this week:</p>
            <ul className="mt-[6px] flex flex-col gap-[3px] text-[12px] text-foreground/80">
              <li>• New onboarding flow (PR #482) — live in prod since Monday</li>
              <li>• Billing fix for the EU price tier (PR #486)</li>
              <li>• Search latency improvement on the docs page</li>
            </ul>
            <p className="mt-[8px] text-[11px] text-muted-foreground">
              2 threads pending — want me to summarize those too?
            </p>
          </FauxSketchMessage>
        </div>
      </div>

      <p className="mt-[16px] text-[12.5px] text-muted-foreground">
        Sketch listens in the channels you choose. When you @mention it, it summarizes threads, drafts replies, and
        posts back.
      </p>
    </div>
  );
}

function SlackForm() {
  return (
    <div className="flex flex-col gap-[18px]">
      <p className="text-[13.5px] text-foreground/85" style={{ lineHeight: 1.55 }}>
        Authorize Sketch to read messages and post in the channels you choose. You'll pick which channels — Sketch only
        sees what you grant.
      </p>

      <FormField label="Slack workspace">
        <FormSelect placeholder="Pick a workspace…" value="canvasx" options={["canvasx", "Other…"]} />
      </FormField>

      <FormField label="Channels to start with">
        <div className="flex flex-col gap-[8px]">
          <FormCheckbox label="#team-product" checked />
          <FormCheckbox label="#team-eng" checked />
          <FormCheckbox label="#general" />
          <FormCheckbox label="#design" />
        </div>
      </FormField>

      <div className="mt-[4px] flex items-center gap-[8px]">
        <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-foreground/[0.06]">
          <SlackBrandIcon size={11} className="text-foreground/70" />
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          Sketch will request the `channels:read` and `chat:write` scopes only.
        </span>
      </div>
    </div>
  );
}

// ─── Step 2 — Connect Notion (preview content for completeness) ──────────

function IntegrationsPreview() {
  return (
    <div className="w-full max-w-[420px]">
      <div className="rounded-[14px] border border-border bg-card p-[18px] shadow-[0_18px_40px_-12px_rgba(0,0,0,0.18)]">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.12em" }}>
          Search · Notion
        </span>
        <p className="mt-[10px] text-[13px] text-foreground">"What's our refund policy for the Pro plan?"</p>
        <div className="mt-[12px] rounded-[10px] bg-foreground/[0.04] p-[12px]">
          <p className="text-[12px] text-foreground/85">
            Refunds within 14 days — pulled from{" "}
            <span className="underline decoration-muted-foreground/30">Customer Policies · Pro tier</span> in Notion.
          </p>
        </div>
      </div>
      <p className="mt-[16px] text-[12.5px] text-muted-foreground">
        Connect your tools and Sketch can search them, cite them, and act inside them.
      </p>
    </div>
  );
}

function IntegrationsForm() {
  return (
    <div className="flex flex-col gap-[18px]">
      <p className="text-[13.5px] text-foreground/85" style={{ lineHeight: 1.55 }}>
        Notion's the most common starting point — connect it now and add the rest later.
      </p>
      <FormField label="Notion workspace">
        <FormSelect placeholder="Sign in to Notion…" value="CanvasX" options={["CanvasX", "Other workspace…"]} />
      </FormField>
      <FormField label="Pages Sketch can read">
        <FormCheckbox label="All workspace pages" />
        <FormCheckbox label="Just shared with me" checked />
      </FormField>
    </div>
  );
}

// ─── Step 3 — Invite teammates ─────────────────────────────────────────────

function TeammatePreview() {
  return (
    <div className="w-full max-w-[420px]">
      <div className="rounded-[14px] border border-border bg-card p-[18px] shadow-[0_18px_40px_-12px_rgba(0,0,0,0.18)]">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.12em" }}>
          Team activity · today
        </span>
        <ul className="mt-[12px] flex flex-col gap-[10px]">
          <TeamRow initials="MR" name="Maria" action="ran" target="Weekly investor digest" />
          <TeamRow initials="TY" name="Tom" action="installed" target="Lead Qualifier skill" />
          <TeamRow initials="AP" name="You" action="connected" target="Slack" />
        </ul>
      </div>
      <p className="mt-[16px] text-[12.5px] text-muted-foreground">
        Sketch gets sharper the more of your team uses it — and your team's skills are shared across everyone.
      </p>
    </div>
  );
}

function TeammateForm() {
  return (
    <div className="flex flex-col gap-[18px]">
      <p className="text-[13.5px] text-foreground/85" style={{ lineHeight: 1.55 }}>
        Send magic links to anyone you want on board. They'll be ready to go in seconds — no setup on their side.
      </p>
      <FormField label="Email addresses">
        <FormTextArea placeholder="alex@canvasx.ai, tom@canvasx.ai" />
      </FormField>
      <FormField label="What they get">
        <div className="rounded-[10px] border border-border bg-card p-[12px]">
          <p className="text-[12px] text-foreground/80">
            Member access — they can use every skill, see shared activity, and trigger conversations.
          </p>
        </div>
      </FormField>
    </div>
  );
}

// ─── Steps 4 + 5 (stub previews so navigation reads correctly) ──────────

function SkillPreview() {
  return (
    <p className="max-w-[360px] text-center text-[13px] text-muted-foreground">
      Preview: a saved skill card running on a schedule.
    </p>
  );
}
function SkillForm() {
  return (
    <p className="text-[13.5px] text-foreground/85">Form: pick a starter skill or describe one in your own words.</p>
  );
}
function SchedulePreview() {
  return (
    <p className="max-w-[360px] text-center text-[13px] text-muted-foreground">
      Preview: a scheduled task running every weekday at 8am.
    </p>
  );
}
function ScheduleForm() {
  return (
    <p className="text-[13.5px] text-foreground/85">Form: pick a skill, set the cadence, choose where output lands.</p>
  );
}

// ─── Mini primitives for forms + faux Slack ───────────────────────────────

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[8px]">
      <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.12em" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function FormSelect({
  placeholder,
  value,
  options: _options,
}: {
  placeholder: string;
  value?: string;
  options: string[];
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center justify-between rounded-[10px] border border-border bg-card",
        "px-[14px] py-[10px] text-[13px] text-foreground",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.03]",
      )}
    >
      <span className={cn(value ? "" : "text-muted-foreground")}>{value ?? placeholder}</span>
      <span className="text-muted-foreground" aria-hidden>
        ▾
      </span>
    </button>
  );
}

function FormCheckbox({ label, checked }: { label: string; checked?: boolean }) {
  // Visual-only mock — no real input here, so this is a <div>, not a <label>.
  return (
    <div className="flex items-center gap-[10px] cursor-pointer">
      <span
        className={cn(
          "inline-flex h-[16px] w-[16px] items-center justify-center rounded-[4px] border",
          checked ? "bg-foreground border-foreground text-background" : "border-border bg-card",
        )}
        aria-hidden
      >
        {checked && <CheckIcon size={10} weight="bold" />}
      </span>
      <span className="text-[13px] text-foreground">{label}</span>
    </div>
  );
}

function FormTextArea({ placeholder }: { placeholder: string }) {
  return (
    <div
      className={cn(
        "min-h-[80px] w-full rounded-[10px] border border-border bg-card px-[14px] py-[10px]",
        "text-[13px] text-muted-foreground",
      )}
    >
      {placeholder}
    </div>
  );
}

function FauxSlackMessage({
  initials,
  name,
  time,
  body,
}: {
  initials: string;
  name: string;
  time: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-[10px]">
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] bg-[#7A4FD6] text-[10px] font-medium text-white">
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-[8px]">
          <span className="text-[12px] font-medium text-foreground">{name}</span>
          <span className="text-[10px] text-muted-foreground">{time}</span>
        </div>
        <p className="mt-[2px] text-[12.5px] text-foreground/85">{body}</p>
      </div>
    </div>
  );
}

function FauxSketchMessage({ time, children }: { time: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-[10px]">
      <span
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] bg-[#FEED01]"
        aria-hidden
      >
        <img src="/logos/sketch-icon-lightmode.png" alt="" className="size-[14px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-[8px]">
          <span className="text-[12px] font-medium text-foreground">Sketch</span>
          <span className="font-mono text-[9px] uppercase text-muted-foreground" style={{ letterSpacing: "0.1em" }}>
            APP
          </span>
          <span className="text-[10px] text-muted-foreground">{time}</span>
        </div>
        <div className="mt-[2px]">{children}</div>
      </div>
    </div>
  );
}

function TeamRow({
  initials,
  name,
  action,
  target,
}: {
  initials: string;
  name: string;
  action: string;
  target: string;
}) {
  return (
    <li className="flex items-center gap-[10px]">
      <span className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[10px] font-medium text-foreground">
        {initials}
      </span>
      <span className="text-[12.5px] text-foreground/85">
        <span className="font-medium">{name}</span> {action} <span className="text-muted-foreground">{target}</span>
      </span>
    </li>
  );
}

// ─── Route exports ─────────────────────────────────────────────────────────

export const homeOnboardingConcept3Route = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-3",
  component: () => <HomeOnboardingConcept3PageImpl state={{ currentStep: 1, completedIds: [] }} />,
});

export const homeOnboardingConcept3MidRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-3-mid",
  component: () => (
    <HomeOnboardingConcept3PageImpl state={{ currentStep: 3, completedIds: ["channel", "integration"] }} />
  ),
});
