import { CheckIcon, CompassIcon, ListChecksIcon, PlayCircleIcon, XIcon } from "@phosphor-icons/react";
/**
 * OnboardingSetupTray — persistent bottom tray used by the unified onboarding
 * flow at /home/onboarding.
 *
 * Sticky to the bottom of the page; shows progress + the 5 setup chips on the
 * left, and a Help button on the right that expands a panel above the tray
 * with three actions: continue setup, replay walkthrough, watch the intro.
 *
 * The tray has three lifecycle states the route can drive:
 *   - Default — 0–4 of 5 done. Compact progress + clickable chips.
 *   - Celebration — 5/5 done. Yellow swell + "Got it" CTA.
 *   - Leaving — set after Got it. Slides down so the route can swap in the
 *     bubble bottom-right without the surface just popping out of existence.
 *
 * Chips are clickable: tapping toggles done state so the prototype can be
 * walked end-to-end without faking the underlying setup actions. The "next"
 * chip carries a soft yellow glow so the eye keeps returning to it.
 */
import { cn } from "@sketch/ui/lib/utils";
import { useEffect, useRef, useState } from "react";

export interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
}

export interface OnboardingSetupTrayProps {
  steps: OnboardingStep[];
  helpOpen: boolean;
  onHelpToggle: () => void;
  /** Toggles a step's done state. Wired from the route so the prototype can
   *  drive progress without faking the underlying setup actions. */
  onStepClick: (id: string) => void;
  onReplayTour: () => void;
  onWatchVideo?: () => void;
  /** When all 5 steps are done, the route should pass this so the tray
   *  swaps to the celebratory "Nice work — Sketch is set up" state with a
   *  "Got it" CTA that collapses the tray into the bubble. */
  onAcknowledgeComplete?: () => void;
  /** When true the tray plays its slide-down exit animation. Driven by the
   *  route during the morph into the bubble helper. */
  leaving?: boolean;
}

export function OnboardingSetupTray({
  steps,
  helpOpen,
  onHelpToggle,
  onStepClick,
  onReplayTour,
  onWatchVideo,
  onAcknowledgeComplete,
  leaving = false,
}: OnboardingSetupTrayProps) {
  const doneCount = steps.filter((s) => s.done).length;
  const total = steps.length;
  const nextStep = steps.find((s) => !s.done);
  const allDone = doneCount === total;

  // When 5/5 hits, let the 5th chip's check-pop animation play through
  // (~280ms), then auto-dismiss the tray. No celebratory floating element
  // sits on the strip — the chrome handoff (tray fading out, bubble
  // appearing) IS the celebration. Modern apps (Linear, Stripe, Notion)
  // handle this same moment by letting the surface gracefully leave
  // instead of staging extra UI on it.
  const prevAllDoneRef = useRef(false);
  useEffect(() => {
    if (allDone && !prevAllDoneRef.current) {
      prevAllDoneRef.current = true;
      const dismissT = setTimeout(() => {
        onAcknowledgeComplete?.();
      }, 320);
      return () => clearTimeout(dismissT);
    }
    if (!allDone) {
      prevAllDoneRef.current = false;
    }
  }, [allDone, onAcknowledgeComplete]);

  const nextStepLabel = nextStep?.label;

  return (
    <div className={cn("sticky bottom-0 z-30", leaving ? "sketch-tray-out" : "sketch-tray-in")}>
      {/* Help panel — sits above the tray when expanded. Hidden during the
       * celebration state since the tray is about to collapse anyway. */}
      {helpOpen && !allDone && (
        <div className="pointer-events-none absolute right-[18px] bottom-[calc(100%+10px)] z-10">
          <HelpPanel
            nextStepLabel={nextStepLabel}
            onClose={onHelpToggle}
            onReplayTour={onReplayTour}
            onWatchVideo={onWatchVideo}
          />
        </div>
      )}

      {/* The tray itself — slim white strip at the bottom of the main pane.
       *
       * No separate celebration state. When 5/5 hits, all 5 chips visibly
       * show as done (checks + muted text), the Help affordance fades
       * out, and ~320ms later the whole strip slides + fades away. The
       * bubble enters from the corner. The chrome handoff is the
       * celebration moment — no floating icon, no leftover surface. */}
      <div
        className={cn(
          "relative flex w-full items-center gap-[28px] border-t border-border bg-card px-[20px] py-[10px]",
        )}
      >
        {/* Left — compact progress label + 5 chips. */}
        <div className="relative flex min-w-0 flex-1 items-center gap-[12px]">
          <span className="shrink-0 whitespace-nowrap text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground">Set up</span>
            <span className="mx-[6px] text-foreground/30">·</span>
            <span className="tabular-nums">
              {doneCount}/{total}
            </span>
          </span>

          <div className="flex min-w-0 items-center gap-[6px]">
            {steps.map((step, idx) => (
              <StepChip
                key={step.id}
                step={step}
                index={idx + 1}
                isNext={step === nextStep}
                onClick={() => onStepClick(step.id)}
              />
            ))}
          </div>
        </div>

        {/* Right — Help toggle. Neutral pill (yellow on white is invisible,
         *  so yellow stays only inside the brand mark) carrying a small
         *  Sketch icon in a yellow circle — literally a miniature preview
         *  of the bubble that appears after setup completes. The mark is
         *  the through-line: tiny Sketch here graduates to full Sketch
         *  bubble bottom-right once 5/5 is hit.
         *
         *  Fades out the instant 5/5 hits so the strip's content visibly
         *  resolves (5 done chips, nothing else) before the whole tray
         *  slides away. */}
        <button
          type="button"
          onClick={onHelpToggle}
          aria-expanded={helpOpen}
          aria-hidden={allDone}
          tabIndex={allDone ? -1 : 0}
          className={cn(
            "relative inline-flex shrink-0 items-center gap-[8px] rounded-full border py-[5px] px-[12px]",
            "text-[12px] font-medium text-foreground/85 cursor-pointer",
            "transition-[opacity,transform,background-color,border-color] duration-200 ease-out",
            "hover:-translate-y-[1px]",
            helpOpen
              ? "border-foreground/20 bg-foreground/[0.06]"
              : "border-foreground/15 bg-background hover:bg-foreground/[0.04]",
            allDone && "pointer-events-none opacity-0",
          )}
        >
          {/* Mini Sketch identity — the bubble's preview. 22px yellow
           *  circle with a 16px icon inside. Earlier 18px/11px ratio
           *  left too much yellow padding and the starburst lines
           *  disappeared into the bg — bumped both so the mark actually
           *  reads as the Sketch logo at this size. */}
          <span
            aria-hidden
            className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
            style={{
              backgroundColor: "var(--brand-yellow)",
              boxShadow: "0 1px 4px color-mix(in oklab, var(--brand-yellow) 35%, transparent)",
            }}
          >
            <img src="/logos/sketch-icon-light.png" alt="" className="size-[16px]" draggable={false} />
          </span>
          <span>Help</span>
        </button>
      </div>
    </div>
  );
}

function StepChip({
  step,
  index,
  isNext,
  onClick,
}: {
  step: OnboardingStep;
  index: number;
  isNext: boolean;
  onClick: () => void;
}) {
  // Track the chip's previous done state so we can pop the checkmark only
  // on the actual undone→done transition, not on every render.
  const prevDoneRef = useRef(step.done);
  const [popping, setPopping] = useState(false);
  useEffect(() => {
    if (step.done && !prevDoneRef.current) {
      setPopping(true);
      const t = setTimeout(() => setPopping(false), 280);
      return () => clearTimeout(t);
    }
    prevDoneRef.current = step.done;
  }, [step.done]);

  // All four chip states share one visual grammar so the row reads as a
  // family: borderless filled pill, every glyph in a tonal disc, every
  // hover darkens the fill. The grey fills are intentionally *very*
  // light — the row should feel airy, not grey-heavy. Yellow is the only
  // saturated surface; everything else just reads as "soft pill shape".
  //
  //   • pending — barely-there grey (foreground/[0.035]). Reads as a
  //               pill shape on close look, not as a saturated colour.
  //   • isNext  — full brand-yellow pill (#FEED01 / #1a1a18). The focal
  //               point; matches coach-mark's primary-CTA pattern.
  //   • done    — light grey (foreground/[0.06]) + check disc. Check,
  //               not line-through (line-through reads as "wrong").
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={step.done}
      aria-label={`${step.done ? "Mark incomplete" : "Mark done"}: ${step.label}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-[6px] rounded-full border border-transparent px-[10px] py-[4px]",
        "text-[11px] transition-all duration-150 ease-out cursor-pointer",
        "hover:-translate-y-[1px] active:translate-y-0",
        step.done && "bg-foreground/[0.06] text-foreground/65 hover:bg-foreground/[0.09]",
        !step.done && isNext && "bg-[#FEED01] text-[#1a1a18] hover:brightness-95",
        !step.done && !isNext && "bg-foreground/[0.035] text-foreground/65 hover:bg-foreground/[0.07]",
      )}
    >
      {/* Bare glyph — no disc. At these low pill-fill values, a disc
       *  behind the glyph stacks two low-contrast greys and the number
       *  disappears. Modern command-menu chips (Linear, Vercel, Notion)
       *  don't disc their numbers either — the chip itself is the
       *  container. Mono number distinguishes the index from the label
       *  typographically without needing a coloured backdrop. */}
      <span className={cn("inline-flex items-center justify-center", popping && "sketch-chip-check-pop")}>
        {step.done ? (
          <CheckIcon size={11} weight="bold" className="text-foreground/70" />
        ) : isNext ? (
          // Forced #1a1a18 so dark mode doesn't invert against yellow.
          <span className="font-mono text-[10px] font-semibold text-[#1a1a18]">{index}</span>
        ) : (
          <span className="font-mono text-[10px] text-foreground/60">{index}</span>
        )}
      </span>
      <span className="whitespace-nowrap">{step.label}</span>
    </button>
  );
}

// (Previously here: CelebrationSparkles. Removed — the new "graceful
//  handoff" celebration uses chrome motion only, no particles. The
//  redesigned sequence: chip pop-check → Help fades → tray slides out →
//  bubble enters. Particles read as fighting against the smoothness.)

function HelpPanel({
  nextStepLabel,
  onClose,
  onReplayTour,
  onWatchVideo,
}: {
  nextStepLabel?: string;
  onClose: () => void;
  onReplayTour: () => void;
  onWatchVideo?: () => void;
}) {
  return (
    <div
      className={cn(
        "pointer-events-auto w-[320px] rounded-[14px] border border-border bg-card",
        "shadow-[0_16px_40px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.04)]",
        "sketch-bubble-panel-in",
      )}
    >
      {/* Heading row — codebase mono eyebrow (10px uppercase tracked).
       *  Same register as sidebar "SETUP", quick-jump "AVAILABLE",
       *  sketch-widget "QUICK ACTIONS". Single-word label so it doesn't
       *  compete with the dashboard's own greeting in the same viewport. */}
      <div className="flex items-center justify-between gap-[12px] px-[14px] pt-[14px] pb-[6px]">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.07em" }}>
          How can I help?
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close help"
          className={cn(
            "-mr-[4px] inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]",
            "text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground cursor-pointer",
            "transition-colors duration-150",
          )}
        >
          <XIcon size={13} />
        </button>
      </div>

      {/* Rows live in an inset gutter so the hover wash reads as a
       *  rounded tile, not an edge-to-edge list row. Row metrics taken
       *  from Linear / Vercel command menus: ~16px icon in fixed slot,
       *  12px icon→text gap, 10/9 row padding, 14/12 text scale. */}
      <div className="flex flex-col px-[8px] pb-[10px]">
        <HelpRow
          icon={<ListChecksIcon size={16} weight="regular" />}
          title="Keep going"
          subtitle={nextStepLabel ? `Next: ${nextStepLabel}` : "All steps complete"}
          onClick={onClose}
        />
        <HelpRow
          icon={<CompassIcon size={16} weight="regular" />}
          title="Take the tour"
          subtitle="60-second walkthrough"
          onClick={onReplayTour}
        />
        <HelpRow
          icon={<PlayCircleIcon size={16} weight="regular" />}
          title="Watch the intro"
          subtitle="2 minutes from our founder"
          onClick={onWatchVideo}
        />
      </div>
    </div>
  );
}

function HelpRow({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick?: () => void;
}) {
  // Mirrors the HelpRow in onboarding-bubble-helper. Inset rounded
  // tile (Linear / Vercel command-menu pattern). Brand-yellow lives
  // only in the panel header — not on the rows.
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-[12px] rounded-[8px] px-[10px] py-[9px] text-left",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.05]",
      )}
    >
      <span
        className={cn(
          "inline-flex w-[16px] shrink-0 items-center justify-center",
          "text-foreground/55 transition-colors duration-150 group-hover:text-foreground",
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-medium text-foreground/90 transition-colors duration-150 group-hover:text-foreground">
          {title}
        </span>
        <span className="mt-[2px] text-[12px] text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  );
}
