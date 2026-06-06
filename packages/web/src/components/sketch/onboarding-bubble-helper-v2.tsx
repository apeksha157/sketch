import { HelpPanelV2 } from "@/components/sketch/help-panel-v2";
/**
 * OnboardingBubbleHelperV2 — v2 of the bubble helper used by the
 * /home/onboarding-v2 route.
 *
 * Identical bubble button + arrival halo as v1. The expanded panel is now
 * the shared tabbed HelpPanelV2 (Contact / Videos / News). When setup is
 * incomplete, the 5-step setup checklist sits above the HelpPanelV2 as a
 * separate section inside the same panel surface.
 */
import { cn } from "@sketch/ui/lib/utils";

const BUBBLE_SIZE = 52;

export interface BubbleStep {
  id: string;
  label: string;
  done: boolean;
}

export interface OnboardingBubbleHelperV2Props {
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

export function OnboardingBubbleHelperV2({
  steps,
  hidden = false,
  open,
  onToggle,
  onReplayTour,
  onWatchVideo,
  setupComplete = false,
}: OnboardingBubbleHelperV2Props) {
  const doneCount = steps.filter((s) => s.done).length;
  const total = steps.length;

  if (hidden) return null;

  return (
    <div className="fixed bottom-[20px] right-[20px] z-30 flex flex-col items-end gap-[12px]">
      {open && <HelpPanelV2 onClose={onToggle} onReplayTour={onReplayTour} onWatchVideo={onWatchVideo} />}
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
          <img src="/logos/sketch-icon-light.png" alt="" className="size-[26px]" draggable={false} />
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

// BubblePanel, SetupRow, HelpRow removed in v2 — the bubble's expanded
// panel is now the shared HelpPanelV2 component (see help-panel-v2.tsx).
// In the v2 route, the bubble is only shown after setupComplete, so the
// in-panel setup checklist is no longer relevant — chip progress lives
// in the tray, and the bubble's expanded surface is a pure help center.
