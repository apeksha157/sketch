/**
 * Persistent setup nudge that lives in the sidebar — the always-visible
 * follow-up to the dismissable banner / inline card on /home/setup.
 *
 * Two reasons this exists in the sidebar (not just the home surface):
 *   1. The inline card on /home/setup-v2 only shows on the home page. The
 *      moment the user navigates elsewhere (Channels, Integrations, etc.)
 *      they lose all view of setup progress. The sidebar nudge keeps the
 *      affordance present everywhere.
 *   2. Dismissing the top banner / inline card shouldn't make setup vanish
 *      entirely. The cross moves the nudge *here*, not into the void.
 *
 * Visual language mirrors CreditsCard — same ~36px height, same hover bg,
 * same thin 2px progress bar at the bottom. The slot in the sidebar
 * (above the credits card / profile chip) is the natural pre-credits home
 * for this affordance: once setup completes, the credits card slides in.
 *
 * Collapsed-sidebar variant: a 24×24 circle with the step number inside,
 * tooltip carries the verbose label. Stays inside the bottom block so its
 * vertical position matches the expanded card.
 */
import { ArrowRightIcon } from "@/components/sketch/icons";
import { useSidebarState } from "@/components/sketch/sidebar-context";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";

export interface SidebarSetupNudgeProps {
  /** Current step the user is on (1-based, 1–5). */
  currentStep: number;
  /** Total number of steps. Defaults to 5 to match the canonical onboarding. */
  totalSteps?: number;
  /** Short label for the next action — e.g. "Invite a teammate". */
  nextLabel: string;
  /** Route to navigate to when the nudge is clicked. */
  href: string;
}

export function SidebarSetupNudge({ currentStep, totalSteps = 5, nextLabel, href }: SidebarSetupNudgeProps) {
  const { collapsed } = useSidebarState();
  const safeStep = Math.max(1, Math.min(totalSteps, currentStep));
  const completed = Math.max(0, safeStep - 1);
  const ratio = totalSteps > 0 ? completed / totalSteps : 0;
  const ariaLabel = `Continue setup — step ${safeStep} of ${totalSteps}, ${nextLabel}`;

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
        "group/nudge flex w-full flex-col gap-[6px] rounded-[6px] px-[8px] py-[8px] text-left",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.04]",
      )}
    >
      <span className="flex items-baseline justify-between gap-[8px]">
        <span className="flex min-w-0 items-baseline gap-[6px] text-[12px] leading-none">
          <span className="font-medium text-foreground">Get started</span>
          <span className="truncate text-muted-foreground">{nextLabel}</span>
        </span>
        <span className="flex shrink-0 items-center gap-[4px] text-[11px] text-muted-foreground/65 tabular-nums leading-none">
          <span>
            {safeStep}/{totalSteps}
          </span>
          <ArrowRightIcon
            size={11}
            aria-hidden
            className="transition-transform duration-150 ease-out group-hover/nudge:translate-x-[2px]"
          />
        </span>
      </span>
      <span className="h-[2px] w-full overflow-hidden rounded-full bg-border" aria-hidden>
        <span
          className="block h-full rounded-full bg-foreground"
          style={{
            width: `${Math.max(2, ratio * 100)}%`,
            transition: "width 200ms ease-out",
          }}
        />
      </span>
    </Link>
  );
}
