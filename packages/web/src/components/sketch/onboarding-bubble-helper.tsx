import { CheckIcon, CompassIcon, HandWavingIcon, LifebuoyIcon, PlayCircleIcon, XIcon } from "@phosphor-icons/react";
/**
 * OnboardingBubbleHelper — the Shape A persistent surface used by the Concept
 * 4 bubble variant (/home/onboarding-concept-4-bubble).
 *
 * A small floating Sketch-icon bubble pinned to the bottom-right of the page.
 * Click toggles a panel above it with:
 *   1. Setup checklist — 5 stacked rows with status
 *   2. Re-take the walkthrough
 *   3. Watch the intro (2 min from our founder)
 *
 * The bubble hides while the coach-mark tour is active because the tour's
 * tooltip carries its own floating avatar (visually the same bubble) —
 * pretending the bubble has "moved" up to the tooltip and will return to
 * the corner when the tour ends.
 */
import { cn } from "@sketch/ui/lib/utils";

const BUBBLE_SIZE = 52;

export interface BubbleStep {
  id: string;
  label: string;
  done: boolean;
}

export interface OnboardingBubbleHelperProps {
  steps: BubbleStep[];
  /** When true, the bubble icon is hidden (because the tour avatar is
   *  standing in for it). The panel is also forced closed in that state. */
  hidden?: boolean;
  open: boolean;
  onToggle: () => void;
  onReplayTour: () => void;
  /** When set, opens the welcome video. Wired from the route so the same
   *  overlay used in the initial onboarding is reused here. */
  onWatchVideo?: () => void;
  /** Wired to a contact / support flow. */
  onContact?: () => void;
  /**
   * Drops the 5-step setup checklist from the panel and shows the
   * post-setup contents instead: Re-take walkthrough · Re-watch video ·
   * Contact our team. Use after all 5 setup steps are complete.
   */
  setupComplete?: boolean;
}

export function OnboardingBubbleHelper({
  steps,
  hidden = false,
  open,
  onToggle,
  onReplayTour,
  onWatchVideo,
  onContact,
  setupComplete = false,
}: OnboardingBubbleHelperProps) {
  const doneCount = steps.filter((s) => s.done).length;
  const total = steps.length;

  if (hidden) return null;

  return (
    <div className="fixed bottom-[20px] right-[20px] z-30 flex flex-col items-end gap-[12px]">
      {open && (
        <BubblePanel
          steps={steps}
          setupComplete={setupComplete}
          onClose={onToggle}
          onReplayTour={onReplayTour}
          onWatchVideo={onWatchVideo}
          onContact={onContact}
        />
      )}
      {/* Relative wrapper holds the bubble button + a one-shot arrival
       *  halo that expands behind it. The halo plays once on mount and
       *  fades to opacity 0. Only fires after setup is complete — that's
       *  the moment the bubble's arrival is a "celebration" beat; in
       *  earlier mid-setup states the bubble shouldn't draw special
       *  attention. */}
      <div className="relative" style={{ width: BUBBLE_SIZE, height: BUBBLE_SIZE }}>
        {setupComplete && (
          <span
            aria-hidden
            className="sketch-bubble-arrival-halo pointer-events-none absolute inset-0 rounded-full"
            style={{
              backgroundColor: "var(--brand-yellow)",
            }}
          />
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label="Open Sketch helper"
          className={cn(
            "relative flex items-center justify-center rounded-full bg-[#FEED01] cursor-pointer",
            "shadow-[0_8px_24px_rgba(0,0,0,0.22)] transition-transform duration-150 ease-out",
            "hover:scale-[1.04] active:scale-[0.98]",
            !open && "sketch-bubble-pulse",
          )}
          style={{ width: BUBBLE_SIZE, height: BUBBLE_SIZE }}
        >
          <img src="/logos/sketch-icon-lightmode.png" alt="" className="size-[26px]" draggable={false} />
          {/* Tiny progress badge — only relevant while setup is incomplete.
           * After setup, the bubble is purely a help affordance and shouldn't
           * carry a stale 5/5. */}
          {!setupComplete && doneCount < total && (
            <span
              className={cn(
                "absolute -top-[2px] -right-[2px] flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-[5px]",
                "bg-[#1a1a18] text-[10px] font-medium text-white",
                "ring-[2px] ring-background",
              )}
            >
              {doneCount}/{total}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

function BubblePanel({
  steps,
  setupComplete,
  onClose,
  onReplayTour,
  onWatchVideo,
  onContact,
}: {
  steps: BubbleStep[];
  setupComplete: boolean;
  onClose: () => void;
  onReplayTour: () => void;
  onWatchVideo?: () => void;
  onContact?: () => void;
}) {
  const nextIdx = steps.findIndex((s) => !s.done);

  return (
    <div
      className={cn(
        "pointer-events-auto w-[320px] rounded-[14px] border border-border bg-card",
        "shadow-[0_16px_40px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.04)]",
        "sketch-bubble-panel-in",
      )}
    >
      {/* Section headings use the codebase mono eyebrow (10px uppercase
       *  tracked), matching sidebar "SETUP", quick-jump "AVAILABLE",
       *  sketch-widget "QUICK ACTIONS". The X close button lives inline
       *  with whichever eyebrow is at the top of the panel — when setup
       *  is incomplete, X sits next to "SET UP SKETCH"; when complete,
       *  next to "HELP". Avoids floating absolute positioning. */}

      {/* Setup checklist section — only rendered while setup is incomplete.
       *
       * Counter dropped — the chip pills below already show progress
       * visually (filled yellow = next, checked = done, ghost = pending).
       * "0 of 5 done" text is redundant. */}
      {!setupComplete && (
        <div className="px-[12px] pt-[14px] pb-[8px]">
          <div className="mb-[8px] flex items-center justify-between gap-[12px] px-[6px]">
            <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.07em" }}>
              Set up Sketch
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close helper"
              className={cn(
                "-mr-[2px] inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]",
                "text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground cursor-pointer",
                "transition-colors duration-150",
              )}
            >
              <XIcon size={13} />
            </button>
          </div>
          <ul className="flex flex-col gap-[1px]">
            {steps.map((step, idx) => (
              <li key={step.id}>
                <SetupRow step={step} index={idx + 1} isNext={idx === nextIdx} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Helper actions section. After setup completes, this section
       * gains a third "Contact our team" row — the bubble graduates into
       * a help/support surface. When setup is at top, this section gets
       * a divider; when help is at top (setupComplete), it gets the
       * "HELP" eyebrow + the inline X. */}
      {setupComplete && (
        <div className="flex items-center justify-between gap-[12px] px-[14px] pt-[14px] pb-[6px]">
          <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.07em" }}>
            How can I help?
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close helper"
            className={cn(
              "-mr-[4px] inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]",
              "text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground cursor-pointer",
              "transition-colors duration-150",
            )}
          >
            <XIcon size={13} />
          </button>
        </div>
      )}

      <div
        className={cn(
          "flex flex-col px-[8px] pb-[10px]",
          !setupComplete && "mx-[12px] border-t border-border/60 pt-[8px]",
        )}
      >
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
        {setupComplete && (
          <HelpRow
            icon={<LifebuoyIcon size={16} weight="regular" />}
            title="Talk to us"
            subtitle="Real humans, fast replies"
            onClick={onContact}
          />
        )}
      </div>
    </div>
  );
}

function SetupRow({ step, index, isNext }: { step: BubbleStep; index: number; isNext: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-center gap-[10px] rounded-[8px] px-[8px] py-[7px] text-left",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.04]",
      )}
    >
      <span
        className={cn(
          "inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full text-[10px] font-mono",
          step.done && "bg-foreground/15 text-foreground/55",
          !step.done && isNext && "bg-foreground text-background",
          !step.done && !isNext && "bg-foreground/[0.07] text-foreground/55",
        )}
      >
        {step.done ? <CheckIcon size={11} weight="bold" /> : index}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          step.done && "text-muted-foreground line-through decoration-muted-foreground/50",
          !step.done && "text-foreground",
        )}
      >
        {step.label}
      </span>
      {isNext && (
        <span className="font-mono text-[9px] uppercase text-muted-foreground" style={{ letterSpacing: "0.12em" }}>
          Next
        </span>
      )}
    </button>
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
  // Inset rounded tile (Linear / Vercel command-menu pattern). Fixed
  // 16px icon slot keeps title left edges aligned across different
  // icon shapes. Brand-yellow lives only in the panel header — these
  // rows are utility affordances.
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
