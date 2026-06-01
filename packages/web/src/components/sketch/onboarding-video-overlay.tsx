import { XIcon } from "@phosphor-icons/react";
/**
 * OnboardingVideoOverlay — full-screen dim with a centered iframe playing
 * the product intro video.
 *
 * Used in two places:
 *   1. First state of the new onboarding flow — auto-opens as soon as the
 *      user lands on the dashboard after signup.
 *   2. Pulled up on demand from the bubble helper ("Re-watch the intro").
 *
 * Sizing: the iframe fills ~70% of the viewport on desktop, scales down on
 * narrow screens. Skip is intentionally prominent (top-right of the iframe
 * + a secondary text link below) so the bottom-third of users who'd bail
 * on a video gate can do so without friction.
 */
import { cn } from "@sketch/ui/lib/utils";

export interface OnboardingVideoOverlayProps {
  /** Tertiary close — the user wants out of the overlay entirely. Lands
   *  on the dashboard (tray visible, tour reachable via tray's help panel). */
  onDismiss: () => void;
  /** Secondary action — "I don't want to watch, take me straight to the
   *  walkthrough." Jumps directly to the coach-marked tour. */
  onSkipToWalkthrough?: () => void;
  /**
   * iframe src — defaults to a YouTube embed placeholder. In production
   * this would be the actual founder intro video.
   */
  videoSrc?: string;
}

const DEFAULT_VIDEO_SRC = "https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&showinfo=0";

export function OnboardingVideoOverlay({
  onDismiss,
  onSkipToWalkthrough,
  videoSrc = DEFAULT_VIDEO_SRC,
}: OnboardingVideoOverlayProps) {
  return (
    <div
      // biome-ignore lint/a11y/useSemanticElements: <dialog> requires showModal() to open; this overlay is conditionally rendered by the parent route.
      className={cn("fixed inset-0 z-[200] flex items-center justify-center", "sketch-video-overlay-in")}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome video"
    >
      {/* Backdrop — click to dismiss (same intent as the × close). */}
      <button
        type="button"
        aria-label="Close welcome video"
        onClick={onDismiss}
        className="absolute inset-0 cursor-default bg-black/70"
      />

      {/*
       * Card — solid surface holds every element so they stop fighting
       * the dim. System: px-24 sides throughout, 20px card edges
       * vertically, 18px around the iframe. Outer card carries the
       * ring + shadow; the iframe keeps a hairline ring only.
       *
       * Background: black bled with 14% brand-brown so the surface reads
       * warm/Sketch rather than cool slate. Color-mix references
       * --brand-brown directly so the brand palette is the source of
       * truth — no invented hex.
       *
       * Brand accent: a thin yellow gradient lives in the top 26px of
       * the card (≈ the top-padding zone). Peaks at brand-yellow / 70%
       * and fades to 0 before reaching the title — a quiet "Sketch is
       * speaking" cue at the welcome moment.
       */}
      <div
        className={cn("relative z-[1] w-[68vw] max-w-[940px] overflow-hidden rounded-[18px]")}
        style={{
          backgroundColor: "color-mix(in oklab, var(--brand-brown) 14%, #000)",
          // box-shadow does double duty: a 1px outset ring at 15% brand-yellow
          // for a quiet branded edge, plus the regular drop shadow.
          boxShadow: [
            "0 0 0 1px color-mix(in oklab, var(--brand-yellow) 15%, transparent)",
            "0 24px 60px rgba(0, 0, 0, 0.5)",
          ].join(", "),
        }}
      >
        {/* Yellow top-edge gradient — lives only in the top padding zone,
         *  fades to zero before reaching the title. Peaks at 15% so it
         *  reads as a hint of brand colour rather than a band. */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 right-0 h-[18px]"
          style={{
            background:
              "linear-gradient(to bottom, color-mix(in oklab, var(--brand-yellow) 15%, transparent) 0%, color-mix(in oklab, var(--brand-yellow) 0%, transparent) 100%)",
          }}
        />

        {/* Header — title on the left, × vertically centered on the
         *  right. items-center handles the alignment automatically. */}
        <div className="relative flex items-center justify-between gap-[24px] px-[24px] pt-[20px] pb-[18px]">
          {/* Title — "Welcome to" in Inter semibold (system font), "Sketch"
           *  in Gloria Hallelujah (the handwritten brand face already used
           *  in the trial banner). A tiny brand personality moment at the
           *  welcome surface without breaking the rest of the type system.
           *
           *  Both at 20px so they read as one phrase. The Sketch span gets
           *  a small negative left margin because Gloria Hallelujah has
           *  generous built-in left bearing — the space between the two
           *  words looks too wide otherwise. */}
          <h2 className="min-w-0 text-[20px] font-semibold leading-none text-white">
            Welcome to
            <span className="ml-[8px] font-normal text-white" style={{ fontFamily: "'Gloria Hallelujah', cursive" }}>
              Sketch
            </span>
          </h2>

          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close welcome video"
            className={cn(
              "-mr-[6px] inline-flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px]",
              "text-white/45 transition-colors duration-150 ease-out cursor-pointer",
              "hover:bg-white/[0.08] hover:text-white/90",
            )}
          >
            <XIcon size={14} weight="bold" aria-hidden />
          </button>
        </div>

        {/* Iframe — same px-24 inset as header/footer so all three rows
         *  share the same internal grid. Hairline ring only — the card
         *  chrome already provides separation from the dim. */}
        <div className="px-[24px]">
          <div
            className="relative w-full overflow-hidden rounded-[12px] bg-black ring-1 ring-white/[0.06]"
            style={{ aspectRatio: "16 / 9" }}
          >
            <iframe
              src={videoSrc}
              title="Sketch intro video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 h-full w-full"
              style={{ border: 0 }}
            />
          </div>
        </div>

        {/* Footer — caption left, text-link skip right. Both sentence-case,
         *  sans-serif, 13px. Hierarchy comes from color + weight: caption
         *  is passive info (white/40, regular); skip is the action
         *  (white/70, medium, brightens + underlines on hover). */}
        <div className="flex items-center justify-between gap-[16px] px-[24px] pt-[18px] pb-[20px]">
          <span className="text-[13px] text-white/40">Get oriented · 2 min</span>

          {onSkipToWalkthrough && (
            <button
              type="button"
              onClick={onSkipToWalkthrough}
              className={cn(
                "group -mr-[4px] inline-flex items-center gap-[6px] rounded-[6px] px-[4px] py-[2px]",
                "text-[13px] font-medium text-white/70 transition-colors duration-150 ease-out cursor-pointer",
                "hover:text-white",
              )}
            >
              <span>Skip to walkthrough</span>
              {/* Arrow flips to brand-yellow + shifts right ~2px on hover
               *  — the yellow is the brand cue, the shift is the motion
               *  cue. No underline; the colour change carries the
               *  affordance. */}
              <span
                aria-hidden
                className={cn(
                  "inline-block text-white/50 transition-all duration-150 ease-out",
                  "group-hover:translate-x-[2px] group-hover:text-brand-yellow",
                )}
              >
                →
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
