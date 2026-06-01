/**
 * Top banners — §4.2 of the spec.
 *
 * Three variants share the same shape (full-width of main pane, padding 11px 18px)
 * with different palettes:
 *   - <SetupBanner>  — neutral card surface, 5-dot progress, brand-yellow accent.
 *   - <ErrorBanner>  — yellow, remedial. Always paired with a CTA (Reconnect, etc.)
 *   - <DangerBanner> — red, critical. Used for credits-low and paused states.
 *
 * The slide-in animation comes from the keyframes in theme.css; reduced-motion
 * users see them appear in place.
 */
import { AlertTriangleIcon } from "@/components/sketch/icons";
import { STEPS } from "@/components/sketch/setup-steps";
import { XIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";

export type SetupStep = 1 | 2 | 3 | 4 | 5;

export interface SetupBannerProps {
  /** The step the user should tackle next (1–5). Earlier steps render as completed. */
  step: SetupStep;
  /** Click target — routes the user to the step's setup flow. */
  onAdvance?: () => void;
  /**
   * When provided, renders a dismiss (×) affordance on the right edge of the
   * banner. Dismissal moves the setup affordance to the sidebar nudge — it
   * does NOT abandon setup. Wire it to a state setter in the route.
   */
  onDismiss?: () => void;
}

/**
 * SetupBanner — slim sticky strip at the top of /home/setup.
 *
 * Designed for the banner context, not as a port of the v2 SetupChecklist
 * card. The banner is page chrome, not content; it earns a single glance,
 * not a study. That dictates everything below.
 *
 * Design decisions:
 *   - Surface direction: neutral `bg-card` instead of pale yellow. The yellow
 *     used to fight the dashboard's palette; making it the page chrome
 *     amplified the problem.
 *   - Brand yellow appears in exactly one place: the active dot.
 *   - Filled high-contrast CTA button (`bg-foreground text-background`).
 *   - Copy sourced from the canonical `STEPS` array in setup-steps.ts, so the
 *     banner and the sidebar nudge can't drift on titles or CTA verbs.
 *
 * What was tried and discarded as banner-inappropriate:
 *   - Hand-drawn Gloria Hallelujah numerals — a third font on a 40px row.
 *   - "GET STARTED" eyebrow in IBM Plex Mono — second font for one word.
 *   - Numbered 24px circles — too heavy a progress signal for chrome.
 *   - Time pill (`~1 MIN`) — earns its place in a card; clutter in chrome.
 *
 * Single font family. Single accent. Single line. The five dots carry the
 * progress signal; the CTA carries the action. The "Up next ·" prefix gives
 * context without inventing a typographic treatment for it — same font,
 * muted color.
 */
export function SetupBanner({ step, onAdvance, onDismiss }: SetupBannerProps) {
  const safeStep = Math.max(1, Math.min(STEPS.length, step)) as SetupStep;
  const stepDef = STEPS[safeStep - 1];

  return (
    <div
      className={cn(
        "sketch-banner-in flex w-full items-center gap-[16px]",
        "bg-card text-foreground border-b border-border",
        "px-[20px] py-[10px]",
      )}
      style={{ animation: "sketch-banner-in 200ms ease-out" }}
    >
      {/* Five-dot progress. No numerals: dot count + active highlight
       * carry the meaning at this size. The brand-yellow halo on the
       * active dot is the banner's one chromatic accent. */}
      <ProgressDots currentStep={safeStep} />

      {/* Title — one font, one weight. The prefix in muted-foreground
       * gives sequence context without a second typographic treatment;
       * its wording shifts with the step so it reads the user's position
       * in the arc, not just "another step":
       *   step 1 → "Get started"   (matches the v2 card's eyebrow)
       *   2–4    → "Up next"        (mid-flow, neutral)
       *   step 5 → "Almost done"    (signals the finish line) */}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight">
        <span className="text-muted-foreground">{prefixFor(safeStep)} ·</span>{" "}
        <span className="text-foreground">{stepDef.title}</span>
      </span>

      {/* CTA — same filled-foreground button as the v2 card. No arrow:
       * the button's contrast does the affordance work on its own. */}
      <button
        type="button"
        onClick={onAdvance}
        className={cn(
          "shrink-0 rounded-[8px] bg-foreground px-[14px] py-[6px] text-[12.5px] font-medium text-background",
          "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        )}
        aria-label={`${stepDef.cta} — ${stepDef.title}`}
      >
        {stepDef.cta}
      </button>

      {/* Dismiss × — moves the affordance to the sidebar nudge; does not
       * abandon setup. Sized down so it doesn't compete with the CTA. */}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss setup banner (continue from sidebar)"
          className={cn(
            "-mr-[6px] inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px]",
            "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            "transition-colors duration-100 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
          )}
        >
          <XIcon size={13} weight="bold" aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * Step-aware prefix for the banner's title line.
 *
 * The five-step arc has two transition points worth marking — the start
 * ("you're beginning") and the end ("you're almost there"). The middle
 * three reuse one phrase ("Up next") because at that point there's
 * nothing meaningful to distinguish them.
 *
 * Implemented as a function rather than a Record<SetupStep, string> map
 * so it stays correct if STEPS grows or shrinks — only the first and
 * last indices carry special copy, the rest fall through.
 */
function prefixFor(step: SetupStep): string {
  if (step === 1) return "Get started";
  if (step === STEPS.length) return "Almost done";
  return "Up next";
}

function ProgressDots({ currentStep }: { currentStep: number }) {
  return (
    // No `role="progressbar"` here: that role requires the element be
    // focusable, and a passive visual indicator inside a sticky banner
    // shouldn't be in the tab order. The aria-label gives screen readers
    // the same step-count context without the interactive contract.
    <div className="flex shrink-0 items-center gap-[8px]" aria-label={`Setup step ${currentStep} of ${STEPS.length}`}>
      {STEPS.map((step, idx) => {
        const n = idx + 1;
        const done = n < currentStep;
        const current = n === currentStep;
        return (
          <span
            key={step.key}
            aria-hidden
            className={cn(
              "h-[7px] w-[7px] rounded-full transition-colors",
              done && "bg-foreground",
              current && "bg-brand-yellow",
              !done && !current && "bg-foreground/[0.15]",
            )}
            style={{
              // Soft yellow halo on the active dot — the one place the
              // banner allows itself a chromatic moment. 3px ring with
              // 22% opacity reads as a glow, not a beacon.
              boxShadow: current ? "0 0 0 3px rgba(254,237,1,0.22)" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

export interface ErrorBannerProps {
  message: string;
  buttonLabel: string;
  onAction: () => void;
}

export function ErrorBanner({ message, buttonLabel, onAction }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        "sketch-banner-in flex w-full items-center gap-[12px] px-[18px] py-[11px]",
        // Same pale-yellow family as the previous SetupBanner — consistent
        // banner palette across remedial states (channel disconnected,
        // automation failed). Danger / billing states use DangerBanner.
        "bg-[#FAF3BD] text-brand-brown",
        "border-b border-brand-brown/15",
      )}
      style={{ animation: "sketch-banner-in 200ms ease-out" }}
    >
      <AlertTriangleIcon size={15} aria-hidden />
      <span className="flex-1 text-[12px] font-medium leading-tight">{message}</span>
      <button
        type="button"
        onClick={onAction}
        className={cn(
          "rounded-[6px] border border-brand-brown/60 px-[10px] py-[4px] text-[11px] font-medium",
          "bg-transparent text-brand-brown hover:bg-brand-brown/[0.08] transition-colors duration-100 ease-out cursor-pointer",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-brown/40",
        )}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

export interface DangerBannerProps {
  message: string;
  /** Optional inline action. Omit for informational-only banners. */
  action?: { label: string; onClick: () => void };
}

/**
 * DangerBanner — red, critical state (billing, paused workspace).
 *
 * CTA treatment is uniform across every consumer: outlined destructive stroke
 * at rest, solid destructive fill with white text on hover. The "outline →
 * solid on hover" idiom signals "ready to act" without the rest state ever
 * shouting — important here because the banner is already chromatically loud.
 */
export function DangerBanner({ message, action }: DangerBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        "sketch-banner-in flex w-full items-center gap-[12px] px-[18px] py-[11px]",
        "bg-destructive/15 text-foreground",
        "border-b border-[color:var(--destructive)]/35",
      )}
      style={{ animation: "sketch-banner-in 200ms ease-out" }}
    >
      <AlertTriangleIcon size={15} aria-hidden className="text-destructive" />
      <span className="flex-1 text-[12px] font-medium leading-tight">{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn(
            "rounded-[6px] border border-[color:var(--destructive)] bg-transparent px-[10px] py-[4px]",
            "text-[11px] font-medium text-destructive",
            "hover:bg-[color:var(--destructive)] hover:text-background",
            "transition-colors duration-100 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--destructive)]/40",
          )}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
