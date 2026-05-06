import { cn } from "@sketch/ui/lib/utils";
import { useEffect, useState } from "react";
import { WALKTHROUGH_STEPS } from "./steps";
import type { WalkthroughStep } from "./types";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Padding (px) added around the target rect for highlight border (when room exists). */
const HIGHLIGHT_PADDING = 6;
/** Gap between the target's outer edge (highlight border) and the tooltip caret tip. */
const CARET_GAP = 22;
/** Tooltip width budget. */
const TOOLTIP_MAX_WIDTH = 320;
/** Tooltip height estimate used for vertical-center placement; close enough for caret alignment. */
const TOOLTIP_EST_HEIGHT = 120;
/** Exit-animation duration before we swap to the new step. Matches `.walkthrough-step-exit` keyframe. */
const EXIT_MS = 160;
/** Targets taller than this get the caret pointed at their upper-third (eye-entry zone)
 *  rather than vertical centre. Tuned so the sidebar (900 px) qualifies and the Skills
 *  nav item (~36 px) doesn't. */
const TALL_TARGET_THRESHOLD = 200;

function getRect(selector: string): Rect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/**
 * Tracks the bounding rect of the target element through scroll, resize,
 * and DOM mutations. Returns null until the target is mounted.
 */
function useTargetRect(selector: string): Rect | null {
  const [rect, setRect] = useState<Rect | null>(() => getRect(selector));

  useEffect(() => {
    const update = () => setRect(getRect(selector));
    update();

    const raf = requestAnimationFrame(update);
    const ro = new ResizeObserver(update);
    const target = document.querySelector(selector);
    if (target) ro.observe(target);
    ro.observe(document.body);

    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [selector]);

  return rect;
}

export function Walkthrough({
  stepIndex,
  onNext,
  onPause,
  onSkip,
}: {
  stepIndex: 1 | 2 | 3 | 4;
  onNext: () => void;
  /** Click-outside no longer dismisses — it pauses, and a Resume pill appears next to the bubble. */
  onPause: () => void;
  onSkip: () => void;
}) {
  const [displayedStep, setDisplayedStep] = useState<1 | 2 | 3 | 4>(stepIndex);
  const [phase, setPhase] = useState<"enter" | "exit">("enter");

  useEffect(() => {
    if (stepIndex === displayedStep) return;
    setPhase("exit");
    const swap = window.setTimeout(() => {
      setDisplayedStep(stepIndex);
      setPhase("enter");
    }, EXIT_MS);
    return () => window.clearTimeout(swap);
  }, [stepIndex, displayedStep]);

  const step = WALKTHROUGH_STEPS.find((s) => s.index === displayedStep) ?? WALKTHROUGH_STEPS[0];
  const rect = useTargetRect(step.selector);
  const exiting = phase === "exit";

  return (
    <>
      <Overlay rect={rect} onPause={onPause} exiting={exiting} />
      <Tooltip key={displayedStep} step={step} rect={rect} onNext={onNext} onSkip={onSkip} exiting={exiting} />
    </>
  );
}

/** Border-radius of the highlight; matches the path's rounded corners. */
const HIGHLIGHT_RADIUS = 10;

/**
 * Backdrop = a single inline SVG that paints "everything except the target rect"
 * with a dim colour. The hole is a rounded rectangle, so the cut-out edge is
 * flush with the highlight border. The card inside the hole is rendered by
 * the page directly — no blur, no dim, no clip-path quirks.
 *
 * Stack:
 *   - Click-catcher button (full viewport, transparent) for pause-on-outside-click.
 *   - SVG dim layer with rounded-rect hole.
 *   - Highlight border element (rounded, pulses).
 */
function Overlay({ rect, onPause, exiting }: { rect: Rect | null; onPause: () => void; exiting: boolean }) {
  const padded = rect ? clampHighlight(rect) : null;

  return (
    <>
      {/* Click-catcher — keyboard-reachable button, sits over the dim layer so
          clicks anywhere outside the tooltip trigger pause. */}
      <button
        type="button"
        aria-label="Pause walkthrough"
        onClick={onPause}
        className="walkthrough-overlay-fade fixed inset-0 cursor-default"
        style={{ zIndex: 100, background: "transparent" }}
      />

      {/* Dark-mode contrast lift: a subtle white wash over the cutout rect with
          mix-blend-mode: screen brightens the highlighted card by ~6 %. The page
          bg in dark mode is so close to the card surface that dim alone can't
          create separation — this lifts the card up rather than crushing the
          surroundings further. Hidden in light mode (rendered nothing). */}
      {padded ? (
        <div
          aria-hidden
          className="pointer-events-none fixed hidden mix-blend-screen dark:block"
          style={{
            zIndex: 99,
            top: padded.top,
            left: padded.left,
            width: padded.width,
            height: padded.height,
            borderRadius: HIGHLIGHT_RADIUS,
            background: "rgba(255, 255, 255, 0.07)",
          }}
        />
      ) : null}

      <DimLayer padded={padded} exiting={exiting} />

      {/* Four backdrop-blur panes positioned around the (rectangular) cutout.
          Blur surrounding area without applying any backdrop-filter to the
          cutout interior — backdrop-filter + clip-path/mask doesn't compose
          reliably across browsers, so we use four separate elements that
          each have an honest box around their own region. The dim layer
          above provides the rounded cutout shape; the blur cutout is
          rectangular but the rounded yellow border sits over the corner
          differential and visually conceals it. */}
      {padded ? <BlurPanes padded={padded} exiting={exiting} /> : null}

      {padded ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none fixed border-[2.5px] border-[#8B7A00] dark:border-[#FEED01]",
            exiting ? "walkthrough-step-exit" : "walkthrough-highlight-pulse",
          )}
          style={{
            zIndex: 102,
            top: padded.top,
            left: padded.left,
            width: padded.width,
            height: padded.height,
            borderRadius: HIGHLIGHT_RADIUS,
          }}
        />
      ) : null}
    </>
  );
}

function BlurPanes({ padded, exiting }: { padded: PaddedRect; exiting: boolean }) {
  const paneClass = cn("pointer-events-none fixed backdrop-blur-[4px]", exiting && "walkthrough-step-exit");
  const z = 101;
  return (
    <>
      <div aria-hidden className={paneClass} style={{ zIndex: z, top: 0, left: 0, right: 0, height: padded.top }} />
      <div
        aria-hidden
        className={paneClass}
        style={{ zIndex: z, top: padded.top + padded.height, left: 0, right: 0, bottom: 0 }}
      />
      <div
        aria-hidden
        className={paneClass}
        style={{ zIndex: z, top: padded.top, left: 0, width: padded.left, height: padded.height }}
      />
      <div
        aria-hidden
        className={paneClass}
        style={{ zIndex: z, top: padded.top, left: padded.left + padded.width, right: 0, height: padded.height }}
      />
    </>
  );
}

/**
 * SVG dim layer: a single <path> with the full viewport rectangle plus a
 * rounded inner rectangle, drawn with `fill-rule="evenodd"` so the inner
 * rectangle becomes a hole. Inside the hole the SVG paints nothing — the
 * page below shows through unmodified.
 */
function DimLayer({ padded, exiting }: { padded: PaddedRect | null; exiting: boolean }) {
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;

  return (
    <svg
      aria-hidden
      role="presentation"
      width={vw}
      height={vh}
      viewBox={`0 0 ${vw} ${vh}`}
      className={cn("pointer-events-none fixed inset-0", exiting && "walkthrough-step-exit")}
      style={{ zIndex: 101 }}
    >
      <title>Walkthrough dim backdrop</title>
      {padded ? (
        <path d={buildDimPath(padded, vw, vh)} fill="rgba(0, 0, 0, 0.55)" fillRule="evenodd" />
      ) : (
        // No target yet — paint the whole viewport.
        <rect width={vw} height={vh} fill="rgba(0, 0, 0, 0.55)" />
      )}
    </svg>
  );
}

/**
 * Build an SVG path that's the full viewport minus a rounded rectangle at
 * (padded). With `fill-rule="evenodd"`, the outer rect fills, the inner
 * rounded rect punches a hole.
 */
function buildDimPath(padded: PaddedRect, vw: number, vh: number): string {
  const r = HIGHLIGHT_RADIUS;
  const x = padded.left;
  const y = padded.top;
  const w = padded.width;
  const h = padded.height;

  return [
    // Outer rectangle — full viewport, clockwise.
    `M 0 0 H ${vw} V ${vh} H 0 Z`,
    // Inner rounded rectangle, clockwise; even-odd makes it the hole.
    `M ${x + r} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${y + h - r}`,
    `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h}`,
    `H ${x + r}`,
    `A ${r} ${r} 0 0 1 ${x} ${y + h - r}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    "Z",
  ].join(" ");
}

function Tooltip({
  step,
  rect,
  onNext,
  onSkip,
  exiting,
}: {
  step: WalkthroughStep;
  rect: Rect | null;
  onNext: () => void;
  onSkip: () => void;
  exiting: boolean;
}) {
  const pos = computeTooltipPosition(rect, step.placement);

  return (
    <div
      aria-label={`Walkthrough step ${step.index} of ${WALKTHROUGH_STEPS.length}`}
      className={cn(
        "fixed rounded-[12px] px-4 py-3.5",
        // Inverted in dark mode for the same on-page contrast we get in light:
        //   light page → dark tooltip;   dark page → light tooltip
        "bg-[#1a1a18] text-white dark:bg-white dark:text-[#1a1a18]",
        // Faint yellow halo line ties the tooltip back to the brand in both modes.
        "shadow-[0_8px_28px_rgba(0,0,0,0.32),0_0_0_1px_rgba(254,237,1,0.14)]",
        "max-w-[320px]",
        exiting ? "walkthrough-step-exit" : "walkthrough-tooltip-enter",
      )}
      style={{ zIndex: 103, top: pos.top, left: pos.left, width: TOOLTIP_MAX_WIDTH }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {pos.caret ? <Caret position={pos.caret} caretY={pos.caretYInTooltip} /> : null}

      <div className="flex items-start gap-2.5">
        <div className="sketch-avatar-wave mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[#FEED01]">
          <img src="/logos/sketch-icon-lightmode.png" alt="" className="size-2.5" />
        </div>
        <p className="text-xs leading-[1.4] text-white/95 dark:text-[#1a1a18]/90">{step.body}</p>
      </div>

      <div className="mt-3 flex items-center justify-between pl-[26px]">
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-white/40 transition-colors hover:text-white/70 dark:text-[#1a1a18]/45 dark:hover:text-[#1a1a18]/75"
        >
          Skip
        </button>
        <ProgressDots active={step.index} total={WALKTHROUGH_STEPS.length} />
        <button
          type="button"
          onClick={onNext}
          // Light tooltip = brand yellow on dark works. Dark mode tooltip is light bg → use olive
          // (the codebase's light-mode-yellow substitute) so the CTA reads against white.
          className="text-xs font-medium text-[#FEED01] transition-all hover:underline dark:text-[#8B7A00]"
        >
          {step.cta} →
        </button>
      </div>
    </div>
  );
}

function Caret({ position, caretY }: { position: "top" | "left"; caretY?: number }) {
  // Caret matches the tooltip's background per mode (dark in light mode, white in dark mode).
  if (position === "top") {
    return (
      <span
        aria-hidden
        className="absolute size-0 border-x-[7px] border-x-transparent border-b-[7px] border-b-[#1a1a18] dark:border-b-white"
        style={{ top: -7, left: 24 }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="absolute size-0 border-y-[7px] border-y-transparent border-r-[7px] border-r-[#1a1a18] dark:border-r-white"
      style={{ left: -7, top: caretY ?? 16 }}
    />
  );
}

function ProgressDots({ active, total }: { active: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => i + 1).map((i) => (
        <span
          key={i}
          className={cn(
            "block rounded-full transition-all duration-300",
            // Active = yellow pill in both modes. Inactive needs a per-mode neutral —
            // white/40 disappears against the white dark-mode tooltip background.
            i === active ? "h-2 w-3.5 bg-[#FEED01]" : "size-[7px] bg-white/40 dark:bg-[#1a1a18]/30",
          )}
        />
      ))}
    </div>
  );
}

interface PaddedRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Pad the target rect by HIGHLIGHT_PADDING on each side, but shrink toward
 * any viewport edge the target is touching so the border isn't clipped off-screen.
 */
function clampHighlight(rect: Rect): PaddedRect {
  if (typeof window === "undefined") {
    return { top: rect.y, left: rect.x, width: rect.width, height: rect.height };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const padTop = Math.min(HIGHLIGHT_PADDING, Math.max(0, rect.y));
  const padLeft = Math.min(HIGHLIGHT_PADDING, Math.max(0, rect.x));
  const padBottom = Math.min(HIGHLIGHT_PADDING, Math.max(0, vh - (rect.y + rect.height)));
  const padRight = Math.min(HIGHLIGHT_PADDING, Math.max(0, vw - (rect.x + rect.width)));
  return {
    top: rect.y - padTop,
    left: rect.x - padLeft,
    width: rect.width + padLeft + padRight,
    height: rect.height + padTop + padBottom,
  };
}

interface TooltipPosition {
  top: number;
  left: number;
  caret: "top" | "left" | null;
  /** Y coordinate of the caret tip *inside* the tooltip — only set for "left" caret. */
  caretYInTooltip?: number;
}

/**
 * Compute fixed-position coords for the tooltip.
 *
 * - "bottom": tooltip below the target, horizontally centred. Flips to above
 *   the target if it would overflow the viewport bottom.
 * - "right": tooltip to the right of the target. For tall targets (e.g. the
 *   full sidebar) the caret points at the upper third (eye-entry zone) rather
 *   than the geometric middle, which would land on something arbitrary inside
 *   a long list. Short targets still get vertically-centred caret.
 */
function computeTooltipPosition(rect: Rect | null, placement: "bottom" | "right"): TooltipPosition {
  if (typeof window === "undefined" || !rect) {
    return { top: 200, left: 200, caret: null };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tooltipW = TOOLTIP_MAX_WIDTH;
  const tooltipH = TOOLTIP_EST_HEIGHT;

  if (placement === "bottom") {
    const wouldOverflowDown = rect.y + rect.height + CARET_GAP + tooltipH > vh;
    if (wouldOverflowDown) {
      const top = rect.y - CARET_GAP - tooltipH;
      const left = clamp(rect.x + rect.width / 2 - tooltipW / 2, 12, vw - tooltipW - 12);
      return { top: Math.max(12, top), left, caret: null };
    }
    const top = rect.y + rect.height + CARET_GAP;
    const left = clamp(rect.x + rect.width / 2 - tooltipW / 2, 12, vw - tooltipW - 12);
    return { top, left, caret: "top" };
  }

  // "right" placement
  const isTall = rect.height > TALL_TARGET_THRESHOLD;
  // Tall: aim the caret at the upper third (where the eye enters). Short: dead-centre.
  const targetAnchorY = isTall ? rect.y + rect.height * 0.3 : rect.y + rect.height / 2;
  const wouldOverflowRight = rect.x + rect.width + CARET_GAP + tooltipW > vw;
  const desiredTop = targetAnchorY - tooltipH / 2;
  const top = clamp(desiredTop, 12, vh - tooltipH - 12);
  const caretYInTooltip = clamp(targetAnchorY - top, 16, tooltipH - 16);

  if (wouldOverflowRight) {
    const left = Math.max(12, rect.x - CARET_GAP - tooltipW);
    return { top, left, caret: null };
  }
  const left = rect.x + rect.width + CARET_GAP;
  return { top, left, caret: "left", caretYInTooltip };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
