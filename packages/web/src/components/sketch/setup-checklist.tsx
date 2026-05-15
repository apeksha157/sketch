import { CheckIcon, ClockIcon, XIcon } from "@phosphor-icons/react";
/**
 * Setup checklist card — the "Get started" affordance for /home/setup-v2.
 *
 * Built to the locked design spec (Get Started Card — Design Spec). Three
 * horizontal bands:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Get started                                          ×  │   Header
 *   │   ✓ ─── 2 ─── 3 ─── 4 ─── 5                              │   Stepper
 *   │  Channel  Teammate  Integration  Skill  Schedule         │
 *   │  ─────────────────────────────────────────────────────   │   Hairline
 *   │  Invite a teammate  [~1 MIN]               Step 2 of 5   │
 *   │  Bring someone else into the workspace —                 │   Action
 *   │  Sketch gets sharper with more context.    [Add member]  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Locked decisions (do not re-litigate without re-reading the spec):
 *   - Brand yellow appears in exactly one place: the active step indicator.
 *     The check inside completed circles is white, not yellow. The CTA arrow
 *     is gone (it was decoration on a high-contrast filled button).
 *   - Action area is a 2-col CSS grid with align-items: end so the CTA's
 *     bottom edge tracks the description's bottom edge regardless of
 *     description length. No floating button vs. empty column.
 *   - Sentence-case mono for the card label and step counter, not
 *     ALL-CAPS — calmer, more current than a decade-old SaaS pattern.
 *   - Dismiss button is absolutely positioned in the top-right and isolated
 *     from any other header metadata: it's destructive and shouldn't share
 *     visual weight with anything.
 *   - Time pill ("~1 MIN") only appears when the step has a duration; the
 *     pill earns its place because step 4 reads ~3 min — variance is what
 *     makes metadata informative.
 */
import { cn } from "@sketch/ui/lib/utils";

export type SetupStepKey = "channel" | "teammate" | "integration" | "skill" | "schedule";

interface StepDef {
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

const STEPS: StepDef[] = [
  {
    key: "channel",
    shortLabel: "Channel",
    title: "Set up your channel",
    description: "Hook up Slack or WhatsApp — Sketch can live where your team already talks.",
    time: "~30 sec",
    cta: "Create",
  },
  {
    key: "teammate",
    shortLabel: "Teammate",
    title: "Invite a teammate",
    description: "Bring someone else into the workspace — Sketch gets sharper with more context.",
    time: "~1 min",
    cta: "Add member",
  },
  {
    key: "integration",
    shortLabel: "Integration",
    title: "Connect an integration",
    description: "Hook up Gmail, Notion, Drive, Linear, or any of 300+ others — Sketch gets the context it needs.",
    time: "~2 min",
    cta: "Connect",
  },
  {
    key: "skill",
    shortLabel: "Skill",
    title: "Create a skill",
    description: "Teach Sketch a workflow your team uses — it can then run on a schedule or on demand.",
    time: "~3 min",
    cta: "Build",
  },
  {
    key: "schedule",
    shortLabel: "Schedule",
    title: "Choose a schedule",
    description: "Pick when Sketch runs your skill — daily, weekly, or on a custom cadence.",
    time: "~1 min",
    cta: "Set up",
  },
];

export interface SetupChecklistProps {
  /** 1-based index of the current step (1–5). Earlier indices render as done. */
  currentStep: number;
  onAdvance?: () => void;
  /**
   * When provided, renders the dismiss × in the top-right. Dismissal collapses
   * the card down to the sidebar nudge — it does not abandon setup.
   */
  onDismiss?: () => void;
  className?: string;
}

export function SetupChecklist({ currentStep, onAdvance, onDismiss, className }: SetupChecklistProps) {
  const safeStep = Math.max(1, Math.min(STEPS.length, currentStep));
  const currentDef = STEPS[safeStep - 1];

  return (
    <section
      className={cn(
        "relative flex flex-col rounded-[12px] border border-border",
        // Sourced from the dashboard's design tokens (bg-card / border-border)
        // so the card harmonizes with every other surface in the app and
        // survives a theme switch. Earlier pass used a hard-coded cream
        // (#F8F6F0) per the spec; trading that for the token because the
        // spec hex was authored for an isolated artboard, not in-place.
        "bg-card",
        "pt-[22px] pb-[26px] px-[32px]",
        className,
      )}
    >
      {/* Header — card label on the left, dismiss × absolutely positioned
       * top-right so it stands isolated from any metadata. */}
      <h2 className="font-mono text-[11px] text-foreground" style={{ letterSpacing: "0.14em" }}>
        Get started
      </h2>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss setup card (continue from sidebar)"
          className={cn(
            "absolute top-[16px] right-[16px] inline-flex h-[32px] w-[32px] items-center justify-center rounded-[8px]",
            "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors duration-100 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
          )}
        >
          <XIcon size={18} aria-hidden />
        </button>
      )}

      {/* Stepper — 5 circles connected by a thin line at vertical center.
       * 32px from the header above (spec). */}
      <div className="mt-[32px]">
        <Stepper currentStep={safeStep} />
      </div>

      {/* Hairline divider — 28px below the stepper, 22px above the action
       * area. The divider visually separates "where you are in the journey"
       * from "what to do next." */}
      <div className="mt-[28px] border-t border-border" />

      {/* Action area — 2-col grid. Row 1: title (with optional time pill) +
       * step counter. Row 2: description + CTA. align-items: end on the grid
       * + align-self: end on the CTA pins the CTA's bottom edge to row 2's
       * bottom edge, so the CTA tracks the description regardless of length. */}
      <div className="mt-[22px] grid items-end gap-x-[24px] gap-y-[8px]" style={{ gridTemplateColumns: "1fr auto" }}>
        {/* Row 1 / Col 1 — title + inline time pill */}
        <div
          className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]"
          style={{ alignSelf: "start", gridRow: 1, gridColumn: 1 }}
        >
          <h3 className="text-[16px] font-medium text-foreground leading-tight">{currentDef.title}</h3>
          {currentDef.time && <TimePill label={currentDef.time} />}
        </div>

        {/* Row 1 / Col 2 — step counter, top-aligned right */}
        <span
          className="font-mono text-[11px] text-muted-foreground tabular-nums"
          style={{
            alignSelf: "start",
            justifySelf: "end",
            gridRow: 1,
            gridColumn: 2,
            letterSpacing: "0.14em",
          }}
        >
          Step {safeStep} of {STEPS.length}
        </span>

        {/* Row 2 / Col 1 — description, capped at 46ch so line length stays
         * comfortable and the block sits as ~2 lines at default widths. */}
        <p
          className="text-[14px] text-muted-foreground max-w-[46ch]"
          style={{ alignSelf: "start", gridRow: 2, gridColumn: 1, lineHeight: 1.55 }}
        >
          {currentDef.description}
        </p>

        {/* Row 2 / Col 2 — primary CTA pinned to the bottom-right of row 2.
         * Intentionally no arrow icon: a high-contrast filled button at the
         * bottom-right of an action area already reads "click me" via
         * position and contrast; an arrow on top of that was decoration. */}
        <button
          type="button"
          onClick={onAdvance}
          className={cn(
            "rounded-[10px] bg-foreground px-[22px] py-[11px] text-[14px] font-medium text-background",
            "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          )}
          style={{ alignSelf: "end", justifySelf: "end", gridRow: 2, gridColumn: 2 }}
          aria-label={`${currentDef.cta} — ${currentDef.title}`}
        >
          {currentDef.cta}
        </button>
      </div>
    </section>
  );
}

function TimePill({ label }: { label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-full bg-foreground/[0.05]",
        "px-[9px] py-[3px] font-mono text-[10.5px] uppercase text-muted-foreground",
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      <ClockIcon size={11} aria-hidden />
      <span>{label}</span>
    </span>
  );
}

function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex flex-col">
      {/* Circles + connectors — flex row with space-between so circles sit at
       * fixed positions and the 1px connectors fill the gaps between them. */}
      <div className="flex items-center">
        {STEPS.map((step, idx) => {
          const stepNumber = idx + 1;
          const completed = stepNumber < currentStep;
          const current = stepNumber === currentStep;
          const isLast = idx === STEPS.length - 1;

          // The connector AFTER this circle is filled iff this circle is done.
          // Rule of thumb: a segment is "covered" when the user has finished
          // the step on its left side.
          const connectorFilled = completed;

          return (
            <div key={step.key} className="flex flex-1 items-center last:flex-none">
              <StatusCircle completed={completed} current={current} stepNumber={stepNumber} />
              {!isLast && (
                <span
                  aria-hidden
                  className={cn("h-[1px] flex-1 mx-[6px]", connectorFilled ? "bg-foreground" : "bg-foreground/20")}
                />
              )}
            </div>
          );
        })}
      </div>
      {/* Labels — sit 14px under the circles, centered under each. Using a
       * 5-column grid keeps each label centered under its corresponding
       * circle regardless of the connector widths above. */}
      <div className="mt-[14px] grid grid-cols-5">
        {STEPS.map((step, idx) => {
          const stepNumber = idx + 1;
          const current = stepNumber === currentStep;
          return (
            <span
              key={step.key}
              className={cn(
                "text-center text-[12px] leading-[1.2]",
                current ? "font-medium text-foreground" : "font-normal text-muted-foreground",
              )}
            >
              {step.shortLabel}
            </span>
          );
        })}
      </div>
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
        "flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-full",
        "transition-colors duration-150 ease-out",
        // Done: solid foreground fill with a background-tone check. The check
        // is not yellow because brand yellow lives ONLY on the active circle.
        completed && "bg-foreground text-background",
        // Active: brand-yellow fill with a soft yellow halo so the eye lands
        // here first. The numeral inside is dark, weight 500.
        current && "bg-brand-yellow text-foreground",
        // Todo: transparent fill with a hairline border + muted numeral.
        !completed && !current && "border border-foreground/20 text-muted-foreground",
      )}
      style={current ? { boxShadow: "0 0 0 5px rgba(254,237,1,0.22)" } : undefined}
      aria-hidden
    >
      {completed ? (
        <CheckIcon size={14} weight="bold" />
      ) : (
        <span className="text-[12px] font-medium tabular-nums leading-none">{stepNumber}</span>
      )}
    </span>
  );
}
