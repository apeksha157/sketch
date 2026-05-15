/**
 * Setup checklist card — proposed primary affordance for /home/setup.
 *
 * Horizontal stepper layout — the pattern Stripe / Notion / Linear / Asana
 * use when 5-ish onboarding steps need to fit in a wide-but-short card on
 * a home surface. The card fills the available width and stays short
 * vertically; all 5 step states are visible simultaneously instead of
 * scrolling.
 *
 * Structure:
 *   [GET STARTED                                              N of 5]
 *   ✓ ── ✓ ── ● ── ○ ── ○      ← circles + connectors + labels
 *   Channel  Team  Integ.  Skill  Task
 *
 *   {one-sentence description of the current step}    [ CTA → ]
 *
 * Color discipline: only the CTA button uses the brown/yellow brand pair.
 * Status circles + connectors are neutral grays; the current step is
 * distinguished by a darker fill rather than a colored accent.
 */
import { ArrowRightIcon, CheckIcon } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";

export type SetupStepKey = "channel" | "teammate" | "integration" | "skill" | "schedule";

interface StepDef {
  key: SetupStepKey;
  /** Short label that renders under the circle in the stepper. */
  shortLabel: string;
  /** Long label used in the active-step row below the stepper. */
  label: string;
  /** One-sentence description shown when this step is current. */
  description: string;
  /** CTA button label when this step is current. */
  cta: string;
}

const STEPS: StepDef[] = [
  {
    key: "channel",
    shortLabel: "Channel",
    label: "Connect a channel",
    description: "Hook up Slack or WhatsApp so Sketch can live where your team already talks.",
    cta: "Connect a channel",
  },
  {
    key: "teammate",
    shortLabel: "Teammate",
    label: "Invite a teammate",
    description: "Bring someone else into the workspace — Sketch gets sharper with more context.",
    cta: "Invite a teammate",
  },
  {
    key: "integration",
    shortLabel: "Integration",
    label: "Connect an integration",
    description: "Hook up Gmail, Notion, Drive, Linear, or any of 300+ others so Sketch has context.",
    cta: "Add an integration",
  },
  {
    key: "skill",
    shortLabel: "Skill",
    label: "Create your first skill",
    description: "Teach Sketch a workflow your team uses so it can run on a schedule or on demand.",
    cta: "Create a skill",
  },
  {
    key: "schedule",
    shortLabel: "Schedule",
    label: "Schedule a task",
    description: "Automate something you do every week — Sketch will run it without you asking.",
    cta: "Schedule a task",
  },
];

export interface SetupChecklistProps {
  /** Index of the current step (1-based, 1–5). Earlier indices render completed. */
  currentStep: number;
  onAdvance?: () => void;
  className?: string;
}

export function SetupChecklist({ currentStep, onAdvance, className }: SetupChecklistProps) {
  const currentDef = STEPS[currentStep - 1] ?? STEPS[0];
  const completedCount = Math.max(0, Math.min(STEPS.length, currentStep - 1));

  return (
    <section
      className={cn("flex flex-col rounded-[12px] border border-border bg-card", "px-[24px] py-[20px]", className)}
    >
      {/* Header — label + progress count */}
      <div className="mb-[18px] flex items-baseline justify-between">
        <h2 className="font-mono text-xs uppercase text-foreground" style={{ letterSpacing: "0.08em" }}>
          Get started
        </h2>
        <span
          className="font-mono text-[10px] uppercase text-muted-foreground tabular-nums"
          style={{ letterSpacing: "0.07em" }}
        >
          {completedCount} of {STEPS.length}
        </span>
      </div>

      {/* Stepper row — 5 status circles connected by line segments, labels below */}
      <Stepper currentStep={currentStep} />

      {/* Hairline divider between the stepper and the active-step block — gives
       * a clear hand-off between "where you are in the journey" and "what to
       * do next" without taking vertical space. */}
      <div className="mt-[20px] border-t border-border" />

      {/* Active-step block — title + description on the left, CTA button on the
       * right aligned to the title baseline. Reads as a proper card row, not a
       * floating button next to a wrapping paragraph. */}
      <div className="mt-[18px] flex items-start justify-between gap-[24px]">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium text-foreground leading-[1.3]">{currentDef.label}</h3>
          <p className="mt-[4px] text-[13px] text-muted-foreground leading-[1.5]">{currentDef.description}</p>
        </div>
        <button
          type="button"
          onClick={onAdvance}
          className={cn(
            "shrink-0 inline-flex items-center gap-[6px] rounded-[6px]",
            // Neutral dark primary — matches the rest of the dashboard's
            // button language (clean foreground/background pair). The
            // brand brown-on-yellow combo is reserved for the chat-input
            // submit pip, where it actually earns the saturation.
            "bg-foreground text-background px-[14px] py-[8px] text-[13px] font-medium",
            "transition-all duration-100 ease-out cursor-pointer",
            "hover:bg-foreground/90 active:scale-[0.98]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          )}
          aria-label={`${currentDef.cta}: ${currentDef.label}`}
        >
          <span>{currentDef.cta}</span>
          <ArrowRightIcon size={13} aria-hidden />
        </button>
      </div>
    </section>
  );
}

function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex w-full items-start">
      {STEPS.map((step, idx) => {
        const stepNumber = idx + 1;
        const completed = stepNumber < currentStep;
        const current = stepNumber === currentStep;
        const isLast = idx === STEPS.length - 1;
        return (
          <div key={step.key} className={cn("flex shrink-0 items-start", isLast ? "" : "flex-1")}>
            {/* Step cell — circle + label below, centered on the circle */}
            <div className="flex shrink-0 flex-col items-center gap-[8px]">
              <StatusCircle completed={completed} current={current} stepNumber={stepNumber} />
              <span
                className={cn(
                  "text-[11.5px] leading-[1.2] text-center whitespace-nowrap",
                  current ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {step.shortLabel}
              </span>
            </div>
            {/* Connector line — fills the space between this circle and the next */}
            {!isLast && (
              <div
                className={cn(
                  "h-[2px] flex-1 self-start rounded-full",
                  // Vertically align with the center of the 24px circle (y = 11px).
                  "mt-[11px]",
                  completed ? "bg-foreground/40" : "bg-foreground/12",
                )}
                aria-hidden
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatusCircle({
  completed,
  current,
  stepNumber,
}: { completed: boolean; current: boolean; stepNumber: number }) {
  return (
    <span
      className={cn(
        "flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-full",
        "transition-colors duration-150 ease-out",
        completed && "bg-foreground/70 text-background",
        current && "bg-foreground text-background ring-2 ring-foreground/15 ring-offset-2 ring-offset-card",
        !completed && !current && "border-[1.5px] border-foreground/20 bg-card text-foreground/35",
      )}
      aria-hidden
    >
      {completed ? (
        <CheckIcon size={12} weight="bold" />
      ) : (
        <span className="text-[11px] font-semibold tabular-nums leading-none">{stepNumber}</span>
      )}
    </span>
  );
}
