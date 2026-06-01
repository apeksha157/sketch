/**
 * Persistent setup nudge that lives in the sidebar — the always-visible
 * follow-up to the dismissable banner / inline card on /home/setup.
 *
 * Redesign brief:
 *   - Drop the "Get started" eyebrow + verbose verb-phrase ("Connect Slack").
 *     Too much copy for a sidebar slot. The eyebrow already exists on the
 *     on-page card; the sidebar carries the briefer reminder.
 *   - Make the step counter (X/5) the dominant element — it's the only piece
 *     of state the user needs at a glance.
 *   - Single-noun label sourced from the canonical STEPS.shortLabel vocabulary
 *     (PLATFORMS / TEAM / APPS / SKILLS / TASKS).
 *   - More brand identity: card chrome (tinted bg + thin border), IBM Plex
 *     Mono for the counter and label, brand-yellow underline on the current
 *     numeral, brand-yellow accents on the completed progress segments.
 *
 * The collapsed-sidebar variant keeps the existing 28px yellow step circle
 * — it already reads as a brand-coded affordance.
 */
import { STEPS } from "@/components/sketch/setup-steps";
import { useSidebarState } from "@/components/sketch/sidebar-context";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";

export interface SidebarSetupNudgeProps {
  /** Current step the user is on (1-based, 1–5). */
  currentStep: number;
  /** Total number of steps. Defaults to 5 to match the canonical onboarding. */
  totalSteps?: number;
  /** Route to navigate to when the nudge is clicked. */
  href: string;
}

export function SidebarSetupNudge({ currentStep, totalSteps = 5, href }: SidebarSetupNudgeProps) {
  const { collapsed } = useSidebarState();
  const safeStep = Math.max(1, Math.min(totalSteps, currentStep));
  const completed = Math.max(0, safeStep - 1);
  const shortLabel = STEPS[safeStep - 1]?.shortLabel ?? "Setup";
  const ariaLabel = `Continue setup — step ${safeStep} of ${totalSteps}, ${shortLabel}`;

  if (collapsed) {
    return (
      <span className="group/tooltip relative inline-flex mx-auto">
        <Link
          to={href}
          aria-label={ariaLabel}
          className={cn(
            "flex h-[28px] w-[28px] items-center justify-center rounded-full",
            "bg-brand-yellow text-foreground ring-1 ring-foreground/15",
            "transition-transform duration-100 ease-out cursor-pointer hover:scale-[1.06]",
          )}
        >
          <span className="text-[11px] font-semibold tabular-nums leading-none">{safeStep}</span>
        </Link>
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-[8px] z-50",
            "whitespace-nowrap rounded-[6px] px-[9px] py-[4px] text-[11px] font-medium",
            "bg-foreground text-background",
            "opacity-0 transition-opacity duration-[120ms] ease-out",
            "group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
          )}
        >
          Setup · {safeStep} of {totalSteps}
        </span>
      </span>
    );
  }

  return (
    <Link
      to={href}
      aria-label={ariaLabel}
      className={cn(
        "group/nudge flex w-full flex-col gap-[8px] rounded-[8px] border border-border/70 bg-foreground/[0.025]",
        "px-[10px] py-[9px] text-left",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.05]",
      )}
    >
      <span className="flex items-center justify-between gap-[8px]">
        <span className="flex items-baseline gap-[2px] font-mono tabular-nums leading-none">
          {/* Active step gets a brand-yellow underline — the yellow sits behind
           * the numeral on the white sidebar, so it stays a visible accent
           * without ever being the figure itself (yellow-on-white isn't legible
           * for indicators on its own — see feedback_yellow_on_white). */}
          <span className="relative text-[15px] font-medium text-foreground">
            {safeStep}
            <span
              aria-hidden
              className="absolute left-[-1px] right-[-1px] bottom-[-3px] h-[3px] rounded-full bg-brand-yellow"
            />
          </span>
          <span className="text-[11px] text-muted-foreground/80">/{totalSteps}</span>
        </span>
        <span
          className="ml-auto font-mono text-[10.5px] uppercase tracking-[0.12em] text-foreground/80"
          style={{ letterSpacing: "0.14em" }}
        >
          {shortLabel}
        </span>
      </span>
      <ProgressSegments completed={completed} total={totalSteps} />
    </Link>
  );
}

/**
 * 5 chunky segments — filled = brand-brown (introduces the dormant brand-brown
 * token without violating the no-yellow-on-white rule), empty = subtle bg.
 * Reads at-a-glance as "3 done, 2 to go" without needing the numeral.
 */
function ProgressSegments({ completed, total }: { completed: number; total: number }) {
  return (
    <span className="flex h-[5px] gap-[3px]" aria-hidden>
      {Array.from({ length: total }, (_, i) => i).map((i) => (
        <span
          key={i}
          className={cn(
            "flex-1 rounded-[2px] transition-colors duration-150 ease-out",
            i < completed ? "bg-brand-brown" : "bg-foreground/[0.08]",
          )}
        />
      ))}
    </span>
  );
}
