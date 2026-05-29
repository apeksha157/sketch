import { ArrowRightIcon, XIcon } from "@phosphor-icons/react";
/**
 * OnboardingResumeBanner — slim sticky banner shown on the regular dashboard
 * after a user has skipped or exited the new-user onboarding flow.
 *
 * Each Concept (1 — chat-led, 2 — tile dashboard) needs its own way to pull
 * a user back into setup. The mechanic is the same: a slim banner pinned to
 * the top of the page with progress + a CTA that returns them to their
 * concept-specific onboarding route. The flavor differs slightly:
 *
 *   variant="chat" → "Sketch is waiting on you" framing. The setup is mid-
 *     conversation, so the language reflects that. CTA: Resume chat.
 *
 *   variant="setup" → Direct progress framing. CTA: Continue setup.
 *
 * Renders a dismiss × that hides the banner — in production this would
 * trigger the sidebar nudge fallback so the affordance is always somewhere
 * on screen.
 */
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";

export interface OnboardingResumeBannerProps {
  /** Visual flavor — chat-led concept vs. direct setup concept. */
  variant: "chat" | "setup";
  /** Number of steps completed (out of total). */
  doneCount: number;
  /** Total number of steps (defaults to 5). */
  total?: number;
  /** Route the CTA navigates to (concept-specific onboarding URL). */
  resumeHref: string;
  /** When provided, renders a dismiss ×. */
  onDismiss?: () => void;
}

export function OnboardingResumeBanner({
  variant,
  doneCount,
  total = 5,
  resumeHref,
  onDismiss,
}: OnboardingResumeBannerProps) {
  return (
    <div
      className={cn(
        "sketch-banner-in flex w-full items-center gap-[16px]",
        "border-b border-border bg-card text-foreground",
        "px-[20px] py-[10px]",
      )}
      style={{ animation: "sketch-banner-in 200ms ease-out" }}
    >
      {/* Identity / progress segment — depends on variant. */}
      {variant === "chat" ? (
        <div className="flex shrink-0 items-center gap-[10px]">
          <span
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-[#FEED01]"
            aria-hidden
          >
            <img src="/logos/sketch-icon-lightmode.png" alt="" className="size-[14px]" />
          </span>
          <ProgressDots doneCount={doneCount} total={total} />
        </div>
      ) : (
        <ProgressDots doneCount={doneCount} total={total} />
      )}

      {/* Title line. */}
      <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
        {variant === "chat" ? (
          <>
            <span className="text-muted-foreground">Sketch is waiting on you ·</span>{" "}
            <span className="text-foreground font-medium">
              {doneCount} of {total} done
            </span>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">Finish setting up Sketch ·</span>{" "}
            <span className="text-foreground font-medium">
              {doneCount} of {total} done
            </span>
          </>
        )}
      </span>

      {/* CTA. */}
      <Link
        to={resumeHref}
        className={cn(
          "inline-flex shrink-0 items-center gap-[6px] rounded-[8px] px-[14px] py-[6px]",
          "text-[12.5px] font-medium bg-foreground text-background",
          "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/90",
        )}
      >
        {variant === "chat" ? "Resume chat" : "Continue setup"}
        <ArrowRightIcon size={12} weight="bold" aria-hidden />
      </Link>

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={cn(
            "-mr-[6px] inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px]",
            "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors duration-100 ease-out cursor-pointer",
          )}
        >
          <XIcon size={13} weight="bold" aria-hidden />
        </button>
      )}
    </div>
  );
}

function ProgressDots({ doneCount, total }: { doneCount: number; total: number }) {
  return (
    <div className="flex shrink-0 items-center gap-[7px]" aria-label={`${doneCount} of ${total} steps done`}>
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
        const done = n <= doneCount;
        return (
          <span
            key={n}
            aria-hidden
            className={cn(
              "h-[7px] w-[7px] rounded-full transition-colors",
              done ? "bg-foreground" : "bg-foreground/[0.15]",
            )}
          />
        );
      })}
    </div>
  );
}
