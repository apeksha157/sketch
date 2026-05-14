/**
 * Date group header — §4.8.
 *
 * Used between conversation groups on /conversations. 11px/500, tertiary,
 * uppercase, 0.04em letter-spacing. The spacing in the spec (mt 14px / mb 6px)
 * is applied by the consumer rather than the component so the first group
 * doesn't need a custom collapse for its top margin.
 */
import { cn } from "@sketch/ui/lib/utils";

export function DateGroupHeader({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn("px-[2px] font-mono text-[10px] uppercase text-muted-foreground", className)}
      style={{ letterSpacing: "0.07em" }}
    >
      {label}
    </div>
  );
}
