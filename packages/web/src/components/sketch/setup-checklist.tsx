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

// CTA strings are verb-only on purpose — the title already says the noun,
// so the button just confirms the intent. Avoids "Schedule a task: Schedule
// a task" duplication.
const STEPS: StepDef[] = [
  {
    key: "channel",
    shortLabel: "Channel",
    label: "Connect a channel",
    description: "Hook up Slack or WhatsApp so Sketch can live where your team already talks.",
    cta: "Connect",
  },
  {
    key: "teammate",
    shortLabel: "Teammate",
    label: "Invite a teammate",
    description: "Bring someone else into the workspace — Sketch gets sharper with more context.",
    cta: "Invite",
  },
  {
    key: "integration",
    shortLabel: "Integration",
    label: "Connect an integration",
    description: "Hook up Gmail, Notion, Drive, Linear, or any of 300+ others so Sketch has context.",
    cta: "Connect",
  },
  {
    key: "skill",
    shortLabel: "Skill",
    label: "Create your first skill",
    description: "Teach Sketch a workflow your team uses so it can run on a schedule or on demand.",
    cta: "Create",
  },
  {
    key: "schedule",
    shortLabel: "Schedule",
    label: "Schedule a task",
    description: "Automate something you do every week — Sketch will run it without you asking.",
    cta: "Schedule",
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
      <div className="mt-[22px] border-t border-border" />

      {/* Active-step block.
       *
       * Top row: step title (h3) on the left, CTA button on the right —
       *   button vertically centered on the title line, so the title reads
       *   as the action and the button is the affordance to take it.
       * Bottom row: description spans the full card width below, with proper
       *   line length for readability (no longer wedged into a half-column
       *   next to a button).
       *
       * This is the pattern Stripe / Linear / Notion use for setup-card
       * active-step blocks — clear hierarchy, generous line length, the
       * action sits as a confident peer to the title.
       */}
      <div className="mt-[18px]">
        <div className="flex items-center justify-between gap-[20px]">
          <h3 className="min-w-0 truncate text-[15px] font-medium text-foreground leading-[1.3]">{currentDef.label}</h3>
          <button
            type="button"
            onClick={onAdvance}
            className={cn(
              "shrink-0 inline-flex items-center gap-[6px] rounded-[6px]",
              // Neutral dark primary with a brand-yellow arrow accent — the
              // arrow is the brand wink, the button itself stays clean and
              // legible.
              "bg-foreground text-background px-[14px] py-[8px] text-[13px] font-medium",
              "transition-all duration-100 ease-out cursor-pointer",
              "hover:bg-foreground/90 active:scale-[0.98]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            )}
            aria-label={`${currentDef.cta}: ${currentDef.label}`}
          >
            <span>{currentDef.cta}</span>
            <ArrowRightIcon size={13} aria-hidden className="text-brand-yellow" />
          </button>
        </div>
        <p className="mt-[6px] text-[13px] text-muted-foreground leading-[1.5]">{currentDef.description}</p>
      </div>
    </section>
  );
}

function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <div className="grid grid-cols-5">
      {STEPS.map((step, idx) => {
        const stepNumber = idx + 1;
        const completed = stepNumber < currentStep;
        const current = stepNumber === currentStep;
        const isFirst = idx === 0;
        const isLast = idx === STEPS.length - 1;

        // Each step owns the connector segments on either side of its circle.
        // - Left half: filled when this step has been reached (current or done).
        //   Hidden entirely on the first step so the line doesn't dangle.
        // - Right half: filled when this step is done (we've moved past it).
        //   Hidden entirely on the last step.
        const leftFilled = !isFirst && (completed || current);
        const rightFilled = !isLast && completed;

        return (
          <div key={step.key} className="flex flex-col items-center">
            {/* Circle row — left half connector, circle, right half connector.
             * The two halves are flex-1 so circles always sit centered in
             * their grid column and the connectors stop cleanly at each
             * column boundary — never overlapping the label below. */}
            <div className="flex w-full items-center">
              <ConnectorSegment visible={!isFirst} filled={leftFilled} />
              <StatusCircle completed={completed} current={current} stepNumber={stepNumber} />
              <ConnectorSegment visible={!isLast} filled={rightFilled} />
            </div>
            {/* Label — sits below the circle in its own grid column, so it
             * never extends into the connector area. */}
            <span
              className={cn(
                "mt-[10px] text-[11.5px] leading-[1.2]",
                current ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {step.shortLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ConnectorSegment({ visible, filled }: { visible: boolean; filled: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "h-[2px] flex-1 rounded-full",
        !visible && "bg-transparent",
        // Neutral dark for the completed trail — the brand identity in the
        // stepper lives on the circles (yellow current + yellow checks).
        visible && filled && "bg-foreground/40",
        visible && !filled && "bg-foreground/12",
      )}
    />
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
        // Completed: neutral dark fill with a brand-yellow check — the
        // check is the only brand accent on each completed step.
        completed && "bg-foreground/70 text-brand-yellow",
        // Current: brand-yellow fill with dark text + a neutral foreground
        // ring so the yellow circle doesn't dissolve into the white card.
        // This is the page's brightest brand spot — the "you are here."
        current && "bg-brand-yellow text-foreground ring-2 ring-foreground/30 ring-offset-2 ring-offset-card",
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
