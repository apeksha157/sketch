/**
 * CoachMark — tooltip + spotlight primitive used by the onboarding tour.
 * Takes a CSS selector + body + step counter as props so a route can drive
 * a multi-step walkthrough by swapping the props as the user advances.
 *
 * Layout (from top to bottom):
 *   1. A Sketch icon avatar that floats OUTSIDE the tooltip box, overlapping
 *      its top-left corner — gives the tooltip identity without crowding the
 *      copy inside.
 *   2. Tooltip body — `STEP X OF N` eyebrow + larger body copy (14px).
 *   3. Footer — Skip on the left, progress dots in the middle, Next on the
 *      right. Each control gets its own breathing room (no jamming dots
 *      between Skip and Next).
 *
 * The route owns the tour sequence (which steps, in what order, with what
 * copy) — this component is just the on-screen renderer.
 */
import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const HIGHLIGHT_PADDING = 8;
const HIGHLIGHT_RADIUS = 12;
const CARET_GAP = 26;
const TOOLTIP_WIDTH = 340;
/** Generous estimate — the longer "what + how + why" copy in the new tour
 *  cards comes in around 240–260px tall with the avatar + footer. Estimating
 *  short caused the tooltip to clamp flush against the viewport bottom when
 *  anchored on bottom-of-sidebar items like Team. */
const TOOLTIP_EST_HEIGHT = 270;
/** Minimum gap between the tooltip and any viewport edge. Was 12 — too
 *  tight; the card visibly touched the screen bottom. */
const TOOLTIP_VIEWPORT_MARGIN = 28;
const AVATAR_SIZE = 36;

export interface CoachMarkProps {
  /** CSS selector for the element to anchor onto. */
  selector: string;
  /** 1-based step number. */
  stepIndex: number;
  totalSteps: number;
  /** Body copy. */
  body: ReactNode;
  /** Tooltip placement relative to the target. */
  placement?: "top" | "bottom" | "left" | "right";
  /** Click handler for the Next button. */
  onNext: () => void;
  /** Click handler for the Skip Tour link. */
  onSkip: () => void;
  /** CTA label. Defaults to "Next". */
  cta?: string;
  /**
   * When true, render the Sketch icon avatar as a *separate floating bubble*
   * sitting beside the tooltip rather than overlapping its corner. Used by
   * the bubble variant where the avatar is also the persistent surface.
   */
  avatarFloating?: boolean;
}

export function CoachMark({
  selector,
  stepIndex,
  totalSteps,
  body,
  placement = "right",
  onNext,
  onSkip,
  cta = "Next",
  avatarFloating = false,
}: CoachMarkProps) {
  const rect = useTargetRect(selector);
  const padded = rect ? clampHighlight(rect) : null;

  return (
    <>
      {/* Click-catcher — anywhere outside the tooltip triggers Skip. */}
      <button
        type="button"
        aria-label="Skip walkthrough"
        onClick={onSkip}
        className="walkthrough-overlay-fade fixed inset-0 cursor-default"
        style={{ zIndex: 100, background: "transparent" }}
      />

      <DimLayer padded={padded} />

      {padded && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none fixed border-[2.5px] border-[#8B7A00] dark:border-[#FEED01]",
            "walkthrough-highlight-pulse",
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
      )}

      <Tooltip
        rect={rect}
        placement={placement}
        body={body}
        stepIndex={stepIndex}
        totalSteps={totalSteps}
        onNext={onNext}
        onSkip={onSkip}
        cta={cta}
        avatarFloating={avatarFloating}
      />
    </>
  );
}

// ─── internals ──────────────────────────────────────────────────────────────

function getRect(selector: string): Rect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

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

interface PaddedRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

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

function DimLayer({ padded }: { padded: PaddedRect | null }) {
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;

  return (
    <svg
      aria-hidden
      role="presentation"
      width={vw}
      height={vh}
      viewBox={`0 0 ${vw} ${vh}`}
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 101 }}
    >
      <title>Coach mark dim backdrop</title>
      {padded ? (
        <path d={buildDimPath(padded, vw, vh)} fill="rgba(0, 0, 0, 0.55)" fillRule="evenodd" />
      ) : (
        <rect width={vw} height={vh} fill="rgba(0, 0, 0, 0.55)" />
      )}
    </svg>
  );
}

function buildDimPath(padded: PaddedRect, vw: number, vh: number): string {
  const r = HIGHLIGHT_RADIUS;
  const x = padded.left;
  const y = padded.top;
  const w = padded.width;
  const h = padded.height;
  return [
    `M 0 0 H ${vw} V ${vh} H 0 Z`,
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

interface TooltipPosition {
  top: number;
  left: number;
  caret: "top" | "bottom" | "left" | "right" | null;
  caretYInTooltip?: number;
}

function computeTooltipPosition(
  rect: Rect | null,
  placement: "top" | "bottom" | "left" | "right",
  tooltipH: number,
): TooltipPosition {
  if (typeof window === "undefined" || !rect) {
    return { top: 200, left: 200, caret: null };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tooltipW = TOOLTIP_WIDTH;

  const m = TOOLTIP_VIEWPORT_MARGIN;
  // The left/right caret is a 16px-tall triangle positioned by its top
  // edge. Its *tip* sits at the vertical centre of the box — so 8px below
  // the `top` we set. We subtract that 8 here so the tip (not the bbox
  // top) lands on the target's mid-Y.
  const CARET_TIP_OFFSET = 8;

  if (placement === "right" || placement === "left") {
    const targetMidY = rect.y + rect.height / 2;
    const desiredTop = targetMidY - tooltipH / 2;
    const top = clamp(desiredTop, m, vh - tooltipH - m);
    const caretYInTooltip = clamp(
      targetMidY - top - CARET_TIP_OFFSET,
      CARET_TIP_OFFSET,
      tooltipH - 16 - CARET_TIP_OFFSET,
    );

    if (placement === "right") {
      const wouldOverflowRight = rect.x + rect.width + CARET_GAP + tooltipW > vw - m;
      if (wouldOverflowRight) {
        const left = Math.max(m, rect.x - CARET_GAP - tooltipW);
        return { top, left, caret: "right", caretYInTooltip };
      }
      const left = rect.x + rect.width + CARET_GAP;
      return { top, left, caret: "left", caretYInTooltip };
    }

    // left
    const wouldOverflowLeft = rect.x - CARET_GAP - tooltipW < m;
    if (wouldOverflowLeft) {
      const left = Math.min(vw - tooltipW - m, rect.x + rect.width + CARET_GAP);
      return { top, left, caret: "left", caretYInTooltip };
    }
    const left = rect.x - CARET_GAP - tooltipW;
    return { top, left, caret: "right", caretYInTooltip };
  }

  const desiredLeft = rect.x + rect.width / 2 - tooltipW / 2;
  const left = Math.max(m, Math.min(vw - tooltipW - m, desiredLeft));

  if (placement === "top") {
    const wouldOverflowUp = rect.y - CARET_GAP - tooltipH < m;
    if (wouldOverflowUp) {
      const top = rect.y + rect.height + CARET_GAP;
      return { top, left, caret: "top" };
    }
    const top = rect.y - CARET_GAP - tooltipH;
    return { top, left, caret: "bottom" };
  }

  const wouldOverflowDown = rect.y + rect.height + CARET_GAP + tooltipH > vh - m;
  if (wouldOverflowDown) {
    const top = Math.max(m, rect.y - CARET_GAP - tooltipH);
    return { top, left, caret: "bottom" };
  }
  const top = rect.y + rect.height + CARET_GAP;
  return { top, left, caret: "top" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function Tooltip({
  rect,
  placement,
  body,
  stepIndex,
  totalSteps,
  onNext,
  onSkip,
  cta,
  avatarFloating,
}: {
  rect: Rect | null;
  placement: "top" | "bottom" | "left" | "right";
  body: ReactNode;
  stepIndex: number;
  totalSteps: number;
  onNext: () => void;
  onSkip: () => void;
  cta: string;
  avatarFloating: boolean;
}) {
  // Measure the actual rendered card height instead of trusting the static
  // estimate. The "what + how + why" copy in the tour cards renders taller
  // than any reasonable estimate, and the old approach left the tooltip
  // floating off-center against its target — caret pointing at the right
  // spot but the card body shifted up or down.
  const cardRef = useRef<HTMLDivElement>(null);
  const [measuredH, setMeasuredH] = useState(TOOLTIP_EST_HEIGHT);

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const el = cardRef.current;
    const update = () => setMeasuredH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pos = computeTooltipPosition(rect, placement, measuredH);

  return (
    <div
      aria-label={`Walkthrough step ${stepIndex} of ${totalSteps}`}
      className="fixed walkthrough-tooltip-enter"
      style={{ zIndex: 103, top: pos.top, left: pos.left, width: TOOLTIP_WIDTH }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {/* Sketch icon avatar — floats OUTSIDE the black box. Two modes:
       *  - overlap (default): sits at the tooltip's top-left corner, half
       *    overlapping the dark surface so it reads as a label on the card.
       *  - floating: sits as a separate bubble to the left of the tooltip
       *    (used by the bubble variant where the icon doubles as the
       *    persistent surface). */}
      <SketchAvatar floating={avatarFloating} caret={pos.caret} />

      {/* The tooltip card itself. */}
      <div
        ref={cardRef}
        className={cn(
          "relative rounded-[14px] px-[20px] pt-[26px] pb-[18px]",
          "bg-[#1a1a18] text-white dark:bg-white dark:text-[#1a1a18]",
          "shadow-[0_12px_36px_rgba(0,0,0,0.34),0_0_0_1px_rgba(254,237,1,0.14)]",
          avatarFloating ? "ml-[52px]" : "",
        )}
      >
        {pos.caret && <Caret position={pos.caret} caretY={pos.caretYInTooltip} />}

        {/* Header — step counter + dots, on their own row so they're not
         * cramped between Skip and Next. */}
        <div className="mb-[12px] flex items-center justify-between">
          <span
            className="font-mono text-[10px] uppercase text-white/55 dark:text-[#1a1a18]/55"
            style={{ letterSpacing: "0.14em" }}
          >
            Step {stepIndex} of {totalSteps}
          </span>
          <ProgressDots active={stepIndex} total={totalSteps} />
        </div>

        {/* Body — larger so the copy gets room to breathe. */}
        <p className="text-[14px] leading-[1.5] text-white/95 dark:text-[#1a1a18]/90">{body}</p>

        {/* Divider before footer actions so the eye can rest. */}
        <div className="my-[14px] h-px bg-white/10 dark:bg-[#1a1a18]/10" />

        {/* Footer — Skip left, Next right, full row each. No dots between
         * them; dots live in the header. */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onSkip}
            className="text-[12px] text-white/50 transition-colors hover:text-white/80 dark:text-[#1a1a18]/55 dark:hover:text-[#1a1a18]/85 cursor-pointer"
          >
            Skip tour
          </button>
          <button
            type="button"
            onClick={onNext}
            className={cn(
              "inline-flex items-center gap-[6px] rounded-[8px] px-[14px] py-[7px] text-[12px] font-medium",
              "bg-[#FEED01] text-[#1a1a18] hover:brightness-95 transition-all cursor-pointer",
              "dark:bg-[#8B7A00] dark:text-white dark:hover:brightness-110",
            )}
          >
            {cta}
            {/* Last step (Finish) shows a tick — the action is completion,
             *  not "more to come". All other steps keep the forward arrow. */}
            {stepIndex === totalSteps ? <CheckIcon size={12} weight="bold" aria-hidden /> : <span aria-hidden>→</span>}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Sketch icon avatar — either overlapping the tooltip top-left corner or
 * floating as a separate bubble to the left of the tooltip (bubble variant).
 *
 * When floating, also pulses softly so the eye sees the icon as the
 * persistent affordance.
 */
function SketchAvatar({ floating, caret }: { floating: boolean; caret: TooltipPosition["caret"] }) {
  if (floating) {
    // Sits to the left of the tooltip, aligned to its top.
    return (
      <div
        className={cn(
          "absolute top-0 left-0 flex items-center justify-center rounded-full bg-[#FEED01]",
          "shadow-[0_4px_12px_rgba(0,0,0,0.18)]",
          "sketch-bubble-pulse",
        )}
        style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
      >
        <img src="/logos/sketch-icon-lightmode.png" alt="" className="size-[18px]" />
      </div>
    );
  }

  // Default — overlapping the tooltip top-left corner. Sits half outside the
  // tooltip box so it reads as a label, not as part of the body row.
  return (
    <div
      className={cn(
        "absolute z-[1] flex items-center justify-center rounded-full bg-[#FEED01]",
        "shadow-[0_4px_12px_rgba(0,0,0,0.18)] ring-[3px] ring-[#1a1a18] dark:ring-white",
      )}
      style={{
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        top: -AVATAR_SIZE / 2,
        // When the caret is on the left, nudge the avatar a touch to the
        // right so it doesn't collide with the caret. Otherwise sit flush
        // to the left edge.
        left: caret === "left" ? 18 : -8,
      }}
    >
      <img src="/logos/sketch-icon-lightmode.png" alt="" className="size-[18px]" />
    </div>
  );
}

function Caret({ position, caretY }: { position: "top" | "bottom" | "left" | "right"; caretY?: number }) {
  if (position === "top") {
    return (
      <span
        aria-hidden
        className="absolute size-0 border-x-[8px] border-x-transparent border-b-[8px] border-b-[#1a1a18] dark:border-b-white"
        style={{ top: -8, left: "50%", transform: "translateX(-50%)" }}
      />
    );
  }
  if (position === "bottom") {
    return (
      <span
        aria-hidden
        className="absolute size-0 border-x-[8px] border-x-transparent border-t-[8px] border-t-[#1a1a18] dark:border-t-white"
        style={{ bottom: -8, left: "50%", transform: "translateX(-50%)" }}
      />
    );
  }
  if (position === "left") {
    return (
      <span
        aria-hidden
        className="absolute size-0 border-y-[8px] border-y-transparent border-r-[8px] border-r-[#1a1a18] dark:border-r-white"
        style={{ left: -8, top: caretY ?? 20 }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="absolute size-0 border-y-[8px] border-y-transparent border-l-[8px] border-l-[#1a1a18] dark:border-l-white"
      style={{ right: -8, top: caretY ?? 20 }}
    />
  );
}

function ProgressDots({ active, total }: { active: number; total: number }) {
  return (
    <div className="flex items-center gap-[5px]">
      {Array.from({ length: total }, (_, i) => i + 1).map((i) => (
        <span
          key={i}
          className={cn(
            "block rounded-full transition-all duration-300",
            i === active ? "h-[6px] w-[14px] bg-[#FEED01]" : "size-[6px] bg-white/30 dark:bg-[#1a1a18]/25",
          )}
        />
      ))}
    </div>
  );
}
