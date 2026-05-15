/**
 * Sidebar credits indicator — the v2 design.
 *
 * Goal: convey "how much do I have, when does it reset, is it healthy?" at a
 * glance, in roughly 36px of vertical space — instead of the heavy 80px card
 * the first pass shipped with.
 *
 * Layout:
 *   1,240 credits left            May 21
 *   ──────────────────────··             ← 2px progress, count vs total
 *
 * No card chrome by default. The whole block is the click target (opens Top-up).
 * Low-credits variant tints the count + the bar red and shows an alert glyph
 * inline with the renewal date — same surface, just a palette swap.
 */
import { AlertTriangleIcon } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";

export interface CreditsCardProps {
  count: number;
  total: number;
  /** Free-text renewal label, e.g. "May 21" or "Renews May 21". */
  renewsAt: string;
  /** Forces the low-credits variant; defaults to count/total < 0.1. */
  low?: boolean;
  onClick?: () => void;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Strip the "Renews " prefix if present — kept terse so it fits on one line. */
function shortDate(label: string): string {
  return label.replace(/^Renews\s+/i, "");
}

export function CreditsCard({ count, total, renewsAt, low, onClick }: CreditsCardProps) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, count / total)) : 0;
  const isLow = low ?? ratio < 0.1;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${formatCount(count)} credits left, renews ${renewsAt}`}
      className={cn(
        "group flex w-full flex-col gap-[6px] rounded-[6px] px-[8px] py-[8px] text-left",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.04]",
      )}
    >
      <span className="flex items-baseline justify-between gap-[8px]">
        <span className="text-[12px] leading-none">
          <span className={cn("font-medium tabular-nums", isLow ? "text-destructive" : "text-foreground")}>
            {formatCount(count)}
          </span>
          <span className="text-muted-foreground"> credits left</span>
        </span>
        <span className="flex shrink-0 items-center gap-[4px] text-[11px] text-muted-foreground/65 leading-none">
          {isLow && <AlertTriangleIcon size={11} className="text-destructive" aria-hidden />}
          <span>{shortDate(renewsAt)}</span>
        </span>
      </span>
      <span className="h-[2px] w-full overflow-hidden rounded-full bg-border" aria-hidden>
        <span
          className={cn("block h-full rounded-full", isLow ? "bg-destructive" : "bg-foreground")}
          style={{
            width: `${Math.max(2, ratio * 100)}%`,
            transition: "width 200ms ease-out, background-color 100ms ease-out",
          }}
        />
      </span>
    </button>
  );
}
