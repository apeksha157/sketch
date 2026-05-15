/**
 * Top banners — §4.2 of the spec.
 *
 * Three variants share the same shape (full-width of main pane, padding 11px 18px)
 * with different palettes:
 *   - <SetupBanner>  — yellow, forward-looking, 5-dot progress.
 *   - <ErrorBanner>  — yellow, remedial. Always paired with a CTA (Reconnect, etc.)
 *   - <DangerBanner> — red, critical. Used for credits-low and paused states.
 *
 * The slide-in animation comes from the keyframes in theme.css; reduced-motion
 * users see them appear in place.
 */
import { AlertTriangleIcon, ArrowRightIcon } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";

export type SetupStep = 1 | 2 | 3 | 4 | 5;

const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  1: "Connect a channel",
  2: "Invite a teammate",
  3: "Connect an integration",
  4: "Create your first skill",
  5: "Set up an automation",
};

export interface SetupBannerProps {
  /** The step the user should tackle next (1–5). Earlier steps render as completed dots. */
  step: SetupStep;
  /** Click target — routes the user to the step's setup flow. */
  onAdvance?: () => void;
}

export function SetupBanner({ step, onAdvance }: SetupBannerProps) {
  return (
    <button
      type="button"
      onClick={onAdvance}
      className={cn(
        "sketch-banner-in group flex w-full items-center gap-[12px] px-[18px] py-[11px] cursor-pointer",
        // Pale-yellow surface matches the tile icon containers so brand
        // identity reads consistently across the page. Brown text holds the
        // contrast; hover steps the bg slightly darker for affordance.
        "bg-[#FAF3BD] text-brand-brown text-left",
        "border-b border-brand-brown/15",
        "transition-colors duration-100 ease-out hover:bg-[#F4E89E]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-brown/40 focus-visible:ring-inset",
      )}
      style={{ animation: "sketch-banner-in 200ms ease-out" }}
      aria-label={`Continue setup: ${SETUP_STEP_LABELS[step]}`}
    >
      <div className="flex items-center gap-[6px]" aria-hidden>
        {[1, 2, 3, 4, 5].map((dot) => {
          const completed = dot < step;
          const current = dot === step;
          return (
            <span
              key={dot}
              className={cn(
                "h-[6px] w-[6px] rounded-full transition-colors",
                completed && "bg-brand-brown",
                current && "bg-brand-brown ring-2 ring-brand-brown/25 ring-offset-1 ring-offset-[#FAF3BD]",
                !completed && !current && "bg-brand-brown/25",
              )}
            />
          );
        })}
      </div>
      <span className="flex-1 text-[12px] font-medium leading-tight">
        <span className="opacity-65">Up next ·</span> <span>{SETUP_STEP_LABELS[step]}</span>
      </span>
      <ArrowRightIcon
        size={14}
        aria-hidden
        className="transition-transform duration-150 ease-out group-hover:translate-x-[2px]"
      />
    </button>
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
        // Same pale-yellow family as SetupBanner — consistent banner palette
        // across remedial states (channel disconnected, automation failed).
        // Danger / billing states use the red DangerBanner instead.
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
