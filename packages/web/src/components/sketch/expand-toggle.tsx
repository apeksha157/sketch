/**
 * Shared expand-toggle — the vertical drawer pull-handle that sits on the
 * right edge of any collapsed rail (workspace sidebar, chat composer card).
 *
 * One affordance idiom across both rails so the user learns it once.
 *
 * Three-step interaction ladder, every state uses SOLID colors (no
 * opacity-based tints — those read as "translucent button" rather than
 * "active button"):
 *   1. Rest — 10×56, white bg, muted chevron. Always visible (good for
 *      first-time discoverability on desktop AND touch).
 *   2. Rail hover — widens to 12px, warm card tone (#FBFAF6), chevron
 *      brightens. Fires when the cursor is anywhere on the parent rail
 *      (parent must own `group/rail`). No-op on touch — but that's fine;
 *      rest state is already discoverable.
 *   3. Direct hover — widens to 16px, pale brand-yellow tint (#FFFAD0),
 *      yellow-warm border, full-contrast chevron, shadow lifts.
 */
import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";

export interface ExpandToggleProps {
  onClick: () => void;
  ariaLabel: string;
}

export function ExpandToggle({ onClick, ariaLabel }: ExpandToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "absolute right-[-5px] top-1/2 z-30 -translate-y-1/2",
        "flex h-[56px] w-[10px] items-center justify-center rounded-full",
        "border border-border bg-background shadow-sm",
        "cursor-pointer transition-all duration-200 ease-out",
        "touch-manipulation",
        "group-hover/rail:w-[12px] group-hover/rail:bg-[#FBFAF6]",
        "hover:w-[16px] hover:bg-[#FFFAD0] hover:border-[#F5E27A] hover:shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
      )}
    >
      <CaretRightIcon
        size={10}
        weight="bold"
        aria-hidden
        className={cn(
          "text-muted-foreground/70 transition-colors duration-150 ease-out",
          "group-hover/rail:text-foreground/85",
          "hover:text-foreground",
        )}
      />
    </button>
  );
}
