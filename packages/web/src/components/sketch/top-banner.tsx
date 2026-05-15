/**
 * Top banners — §4.2 of the spec.
 *
 * Three variants share the same shape (full-width of main pane, padding 11px 18px)
 * with different palettes:
 *   - <SetupBanner>  — soft card surface, hand-drawn stepper, brand-yellow accent.
 *   - <ErrorBanner>  — yellow, remedial. Always paired with a CTA (Reconnect, etc.)
 *   - <DangerBanner> — red, critical. Used for credits-low and paused states.
 *
 * The slide-in animation comes from the keyframes in theme.css; reduced-motion
 * users see them appear in place.
 */
import { AlertTriangleIcon } from "@/components/sketch/icons";
import { STEPS } from "@/components/sketch/setup-checklist";
import { CheckIcon, ClockIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { Fragment } from "react";

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
 * SetupBanner — slim, sticky-at-top variant of the v2 SetupChecklist card.
 *
 * Pulls the v2 card's visual language into a single-row format so the same
 * design system reads consistently whether it lives in a content card or in
 * the page chrome:
 *
 *   - Surface: `bg-card` + hairline `border-b` (was: pale-yellow #FAF3BD).
 *     Yellow is reserved for one accent — the active stepper circle.
 *   - Stepper: 5 × 24px circles, hand-drawn Gloria Hallelujah numerals,
 *     brand-yellow fill + halo on the current circle, `bg-foreground` with
 *     a white check on completed circles. Mirrors the v2 stepper at ~half
 *     the diameter so it fits a banner row.
 *   - Eyebrow: "GET STARTED" in uppercase IBM Plex Mono — product-wide
 *     convention for mono eyebrow text.
 *   - Title + optional time pill mirror v2's action area.
 *   - CTA: high-contrast `bg-foreground text-background` filled button.
 *     Verb-first ("Connect", "Invite", "Automate") — same labels v2 uses.
 *
 * Data source: `STEPS` is imported from setup-checklist.tsx so the banner
 * and the card cannot drift on copy.
 */
export function SetupBanner({ step, onAdvance, onDismiss }: SetupBannerProps) {
  const safeStep = Math.max(1, Math.min(STEPS.length, step)) as SetupStep;
  const stepDef = STEPS[safeStep - 1];

  return (
    <div
      className={cn(
        "sketch-banner-in relative flex w-full items-center gap-[18px]",
        "bg-card text-foreground border-b border-border",
        "px-[20px] py-[10px]",
      )}
      style={{ animation: "sketch-banner-in 200ms ease-out" }}
    >
      {/* Eyebrow — same mono-uppercase treatment as the v2 card's "Get
       * started" header. Reads as the banner's title; the stepper to its
       * right is the data. */}
      <span className="shrink-0 font-mono text-[10.5px] uppercase text-foreground" style={{ letterSpacing: "0.14em" }}>
        Get started
      </span>

      {/* Mini stepper — five hand-drawn circles, brand-yellow halo on the
       * active one. Doubles as a progress indicator + a visual signature
       * tying this banner to the v2 card. */}
      <BannerStepper currentStep={safeStep} />

      {/* Current step title + optional time pill. flex-1 with min-w-0
       * keeps the title from forcing the row to wrap when descriptions
       * are long; the CTA + dismiss sit on the right edge. */}
      <div className="flex min-w-0 flex-1 items-center gap-[10px]">
        <span className="truncate text-[13px] font-medium text-foreground">{stepDef.title}</span>
        {stepDef.time && <TimePill label={stepDef.time} />}
      </div>

      {/* CTA — verb-first, high contrast. Matches the v2 card's button. */}
      <button
        type="button"
        onClick={onAdvance}
        className={cn(
          "shrink-0 rounded-[8px] bg-foreground px-[16px] py-[7px] text-[12.5px] font-medium text-background",
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
            "shrink-0 -mr-[6px] inline-flex h-[26px] w-[26px] items-center justify-center rounded-[6px]",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]",
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
 * Single source of truth for the banner-stepper circle diameter. Same role as
 * CIRCLE_PX in setup-checklist.tsx, but scaled down (~half) so five circles +
 * four connectors fit a banner row without crowding the title and CTA.
 */
const BANNER_CIRCLE_PX = 24;

function BannerStepper({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex shrink-0 items-center gap-[6px]" aria-hidden>
      {STEPS.map((step, idx) => {
        const stepNumber = idx + 1;
        const completed = stepNumber < currentStep;
        const current = stepNumber === currentStep;
        const isLast = idx === STEPS.length - 1;
        return (
          <Fragment key={step.key}>
            <BannerCircle completed={completed} current={current} stepNumber={stepNumber} />
            {!isLast && (
              <span
                className={cn(
                  "h-[1px] w-[14px] rounded-full transition-colors",
                  completed ? "bg-foreground" : "bg-foreground/20",
                )}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function BannerCircle({
  completed,
  current,
  stepNumber,
}: {
  completed: boolean;
  current: boolean;
  stepNumber: number;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        "transition-colors duration-150 ease-out",
        completed && "bg-foreground text-background",
        current && "bg-brand-yellow text-foreground",
        !completed && !current && "bg-foreground/[0.07] text-muted-foreground",
      )}
      style={{
        height: BANNER_CIRCLE_PX,
        width: BANNER_CIRCLE_PX,
        // Halo matches the v2 card's ring effect on the active circle —
        // proportionally smaller (3px vs 5px) to suit the smaller circle.
        boxShadow: current ? "0 0 0 3px rgba(254,237,1,0.22)" : undefined,
      }}
    >
      {completed ? (
        <CheckIcon size={11} weight="bold" />
      ) : (
        // Hand-drawn numerals — identical font + nudge to the v2 card so
        // the personality reads consistent at both sizes.
        <span
          className="text-[13px] leading-none"
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

function TimePill({ label }: { label: string }) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center gap-[4px] rounded-full bg-foreground/[0.05]",
        "px-[8px] py-[2px] font-mono text-[10px] uppercase text-muted-foreground",
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      <ClockIcon size={10} aria-hidden />
      <span>{label}</span>
    </span>
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
  /** Optional inline action — if null/undefined, the banner is informational only (e.g. workspace-paused contact admin link). */
  action?: { label: string; onClick: () => void; asLink?: boolean };
}

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
      {action &&
        (action.asLink ? (
          <button
            type="button"
            onClick={action.onClick}
            className="text-[11px] font-medium text-destructive hover:underline cursor-pointer"
          >
            {action.label} →
          </button>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className={cn(
              "rounded-[6px] border border-[color:var(--destructive)] bg-transparent px-[10px] py-[4px]",
              "text-[11px] font-medium text-destructive",
              "hover:bg-[color:var(--destructive)]/10 transition-colors duration-100 ease-out cursor-pointer",
            )}
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}
