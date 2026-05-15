/**
 * Setup checklist card — the proposed primary affordance for /home/setup.
 *
 * Renders as a card *inside* the page content rather than a full-width banner
 * at the top. This lets the setup card coexist with the rest of the home page
 * structure (greeting, chat input, recents) so:
 *
 * - The page layout stays stable as the user transitions from new → mid-setup
 *   → setup-complete. Sections appear/disappear individually instead of the
 *   whole page restructuring.
 * - A user who ignores setup can still chat freely and watch their recents
 *   populate, with the setup card sitting as a persistent reminder.
 */
import { ArrowRightIcon, CheckIcon } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";

export type SetupStepKey = "channel" | "teammate" | "integration" | "skill" | "schedule";

interface StepDef {
  key: SetupStepKey;
  label: string;
  description: string;
  cta: string;
}

const STEPS: StepDef[] = [
  { key: "channel", label: "Connect a channel", description: "Sketch lives in your DMs.", cta: "Connect" },
  { key: "teammate", label: "Invite a teammate", description: "Bring someone else in.", cta: "Invite" },
  {
    key: "integration",
    label: "Connect an integration",
    description: "Give Sketch context about your tools.",
    cta: "Connect",
  },
  {
    key: "skill",
    label: "Create your first skill",
    description: "Teach Sketch a workflow your team uses.",
    cta: "Create",
  },
  { key: "schedule", label: "Schedule a task", description: "Automate something you do every week.", cta: "Schedule" },
];

export interface SetupChecklistProps {
  /** Index of the current step (1-based, 1–5). Earlier indices render completed. */
  currentStep: number;
  onAdvance?: () => void;
  className?: string;
}

export function SetupChecklist({ currentStep, onAdvance, className }: SetupChecklistProps) {
  return (
    <section
      className={cn("flex flex-col rounded-[12px] border border-border bg-card", "px-[20px] py-[18px]", className)}
    >
      <div className="mb-[14px] flex items-baseline justify-between px-[2px]">
        <h2 className="font-mono text-xs uppercase text-foreground" style={{ letterSpacing: "0.08em" }}>
          Get started
        </h2>
        <span
          className="font-mono text-[10px] uppercase text-muted-foreground tabular-nums"
          style={{ letterSpacing: "0.07em" }}
        >
          {Math.max(0, currentStep - 1)} of 5
        </span>
      </div>

      <ol className="flex flex-col gap-[2px]">
        {STEPS.map((step, idx) => {
          const stepNumber = idx + 1;
          const completed = stepNumber < currentStep;
          const current = stepNumber === currentStep;
          const upcoming = stepNumber > currentStep;
          return (
            <li
              key={step.key}
              className={cn(
                "flex items-start gap-[12px] rounded-[8px] px-[10px] py-[10px]",
                "transition-colors duration-100 ease-out",
                current && "bg-[#FAF3BD]",
                completed && "opacity-65",
                upcoming && "opacity-50",
              )}
            >
              <StatusIcon completed={completed} current={current} />
              <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span
                  className={cn(
                    "text-[13.5px] leading-[1.3]",
                    current ? "font-medium text-brand-brown" : "font-medium text-foreground",
                  )}
                >
                  {step.label}
                </span>
                <span
                  className={cn("text-[12px] leading-[1.4]", current ? "text-brand-brown/80" : "text-muted-foreground")}
                >
                  {step.description}
                </span>
              </div>
              {current && (
                <button
                  type="button"
                  onClick={onAdvance}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-[4px] rounded-[6px]",
                    "bg-brand-brown text-brand-yellow px-[12px] py-[6px] text-[12px] font-medium",
                    "transition-all duration-100 ease-out cursor-pointer",
                    "hover:bg-brand-brown/90 active:scale-[0.97]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-brown/40",
                  )}
                  aria-label={`${step.cta}: ${step.label}`}
                >
                  <span>{step.cta}</span>
                  <ArrowRightIcon size={12} aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StatusIcon({ completed, current }: { completed: boolean; current: boolean }) {
  if (completed) {
    return (
      <span
        className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-foreground/15 text-foreground/60"
        aria-hidden
      >
        <CheckIcon size={11} weight="bold" />
      </span>
    );
  }
  if (current) {
    return (
      <span
        className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-brand-brown text-brand-yellow"
        aria-hidden
      >
        <ArrowRightIcon size={11} weight="bold" />
      </span>
    );
  }
  // upcoming
  return (
    <span
      className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-foreground/20"
      aria-hidden
    />
  );
}
