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
 *   - Uppercase IBM Plex Mono for the card label and step counter. This
 *     overrides the spec's sentence-case decision: the rest of the product
 *     (recents header, credits-card meta, sidebar eyebrows) renders mono
 *     eyebrows in ALL CAPS, and consistency across the dashboard outweighs
 *     the standalone spec.
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
    shortLabel: "Chat",
    title: "Plug Sketch into your chat",
    description: "Slack or WhatsApp — wherever your team's already talking.",
    time: "~30 sec",
    cta: "Connect",
  },
  {
    key: "teammate",
    shortLabel: "Crew",
    title: "Bring in a teammate",
    description: "Sketch gets sharper the more of your team it works with.",
    time: "~1 min",
    cta: "Invite",
  },
  {
    key: "integration",
    shortLabel: "Tools",
    title: "Hook up a tool",
    description: "Gmail, Notion, Drive, Linear, or any of 300+ others — give Sketch the context it needs.",
    time: "~2 min",
    cta: "Connect",
  },
  {
    key: "skill",
    shortLabel: "Skill",
    title: "Teach Sketch a skill",
    description: "Show it a workflow once — it'll run that on a schedule or whenever you ask.",
    time: "~3 min",
    cta: "Build",
  },
  {
    key: "schedule",
    shortLabel: "Rhythm",
    title: "Set a schedule",
    description: "Pick a cadence — Sketch runs it on its own from there.",
    time: "~1 min",
    cta: "Choose",
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
       * top-right so it stands isolated from any metadata.
       *
       * Uppercase IBM Plex Mono is the product-wide convention for mono
       * eyebrow / label text (matches "RECENT CONVERSATIONS", credits-card
       * meta, etc.) — overrides the spec's sentence-case decision. */}
      <h2 className="font-mono text-[11px] uppercase text-foreground" style={{ letterSpacing: "0.14em" }}>
        Get started
      </h2>
      {onDismiss && (
        // Sized to match the 11px eyebrow's visual weight. Previous pass
        // had a 32x32 hit target with an 18px glyph -- the X dwarfed the
        // "Get started" label next to it. Dropped to a 28x28 hit target
        // with a 14px glyph so the corners of the header read balanced.
        // 28 stays comfortably above the 24x24 minimum touch target.
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss setup card (continue from sidebar)"
          className={cn(
            "absolute top-[14px] right-[14px] inline-flex h-[28px] w-[28px] items-center justify-center rounded-[8px]",
            "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors duration-100 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
          )}
        >
          <XIcon size={14} aria-hidden />
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

      {/* Action area — left column stacks title (with optional time pill)
       * and description; right column holds the CTA, vertically centered
       * against the full height of the left stack.
       *
       * Earlier pass used a 2-col grid with the CTA pinned to row 2's
       * bottom edge so it tracked the description. That worked while a
       * step counter occupied row 1 / col 2, but once the counter was
       * dropped the bottom-pin left a void above the CTA. Switching to
       * flex + items-center centers the CTA against the whole left
       * stack instead, so the right column reads balanced regardless of
       * description length.
       *
       * Intentionally no arrow icon on the CTA: a high-contrast filled
       * button at the right of an action area already reads "click me"
       * via position and contrast; an arrow on top of that was decoration. */}
      <div className="mt-[22px] flex items-center gap-[24px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[8px]">
          <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
            <h3 className="text-[17px] font-medium text-foreground leading-tight">{currentDef.title}</h3>
            {currentDef.time && <TimePill label={currentDef.time} />}
          </div>
          {/* Description — capped at 46ch so line length stays comfortable
           * and the block sits as ~2 lines at default widths. */}
          <p className="text-[14px] text-muted-foreground max-w-[46ch]" style={{ lineHeight: 1.55 }}>
            {currentDef.description}
          </p>
        </div>
        <button
          type="button"
          onClick={onAdvance}
          className={cn(
            "shrink-0 rounded-[10px] bg-foreground px-[22px] py-[11px] text-[14px] font-medium text-background",
            "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          )}
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
  // Each step owns ONE grid column carrying both its circle (with the two
  // connector halves on either side) and its label below. Same column for
  // both rows = circle and label are guaranteed to share a centerline.
  // The earlier flex-with-flex-1 layout broke alignment because the last
  // step shrank to circle-width while the others kept connector room,
  // pushing every circle off the column center of its label.
  return (
    <div className="grid grid-cols-5">
      {STEPS.map((step, idx) => {
        const stepNumber = idx + 1;
        const completed = stepNumber < currentStep;
        const current = stepNumber === currentStep;
        const isFirst = idx === 0;
        const isLast = idx === STEPS.length - 1;

        // Each circle owns the two connector halves around it.
        // - Left half is filled when the user has reached this step (done or current).
        // - Right half is filled only when this step is done (we've moved past it).
        // - Outer edges (left half of step 1, right half of step 5) are invisible
        //   so the line doesn't dangle past the first/last circles.
        const leftFilled = !isFirst && (completed || current);
        const rightFilled = !isLast && completed;

        return (
          <div key={step.key} className="flex flex-col items-center">
            <div className="flex w-full items-center">
              <ConnectorHalf visible={!isFirst} filled={leftFilled} />
              <StatusCircle completed={completed} current={current} stepNumber={stepNumber} />
              <ConnectorHalf visible={!isLast} filled={rightFilled} />
            </div>
            {/* Milestone label — Gloria Hallelujah to echo the script
             * numerals inside the circles, so the whole stepper carries
             * the same ceremonial personality. GH is single-weight, so
             * the active/inactive distinction lives purely in color
             * (foreground vs muted-foreground); the size stays uniform. */}
            <span
              className={cn(
                "mt-[12px] text-center text-[16px] leading-[1.1]",
                current ? "text-foreground" : "text-muted-foreground",
              )}
              style={{ fontFamily: "'Gloria Hallelujah', cursive" }}
            >
              {step.shortLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ConnectorHalf({ visible, filled }: { visible: boolean; filled: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-[1px] flex-1",
        !visible && "bg-transparent",
        visible && filled && "bg-foreground",
        visible && !filled && "bg-foreground/20",
      )}
    />
  );
}

function StatusCircle({
  completed,
  current,
  stepNumber,
}: { completed: boolean; current: boolean; stepNumber: number }) {
  // All three states render as filled shapes -- same outer weight, contrast
  // comes from fill color. Previous pass mixed a solid-dark done, a solid-
  // yellow active, and a hairline-bordered todo; the border on todo made it
  // read as a different kind of object than the others. Soft foreground/[0.06]
  // fill on todo gives the same shape weight as done/active while staying
  // recessive.
  //
  // 40x40 (was 32x32) so the Gloria Hallelujah numerals have room to breathe.
  // GH renders smaller than system faces; at 20px in a 32px circle it felt
  // cramped. 24px in a 40px circle reads cleanly.
  return (
    <span
      className={cn(
        "flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full",
        "transition-colors duration-150 ease-out",
        // Done: solid foreground fill, background-tone check. Brand yellow
        // lives only on the active circle, so the check here is neutral.
        completed && "bg-foreground text-background",
        // Active: brand-yellow fill + soft yellow halo. The eye lands here.
        current && "bg-brand-yellow text-foreground",
        // Todo: soft foreground tint, no border. Same shape weight as the
        // other two; recessive via lower contrast, not via missing fill.
        !completed && !current && "bg-foreground/[0.06] text-muted-foreground",
      )}
      style={current ? { boxShadow: "0 0 0 5px rgba(254,237,1,0.22)" } : undefined}
      aria-hidden
    >
      {completed ? (
        <CheckIcon size={16} weight="bold" />
      ) : (
        // Hand-drawn numerals in Gloria Hallelujah -- same family the
        // onboarding / trial banners use for ceremonial moments. Gives the
        // stepper a touch of personality without introducing a second accent
        // color. Lives on every numeral circle so it reads as the stepper's
        // personality; the brand-yellow halo + fill on the active circle do
        // the "you are here" signaling on their own.
        //
        // GH's baseline sits a touch low inside its em-box; nudging the
        // glyph up 1px restores optical centering inside the circle.
        <span
          className="text-[24px] leading-none"
          style={{
            fontFamily: "'Gloria Hallelujah', cursive",
            transform: "translateY(-1px)",
          }}
        >
          {stepNumber}
        </span>
      )}
    </span>
  );
}
