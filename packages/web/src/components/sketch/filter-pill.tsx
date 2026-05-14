/**
 * Filter pill — §4.9. Used on /conversations for channel filtering.
 *
 * Active palette uses solid greys (#ededeb in light, rgba(255,255,255,0.10)
 * in dark) so it reads as a state, not as an accent. Count appears in 70%
 * opacity to subordinate it to the label.
 */
import { cn } from "@sketch/ui/lib/utils";

export interface FilterPillProps {
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
}

export function FilterPill({ label, count, active, onClick }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-[6px] rounded-full px-[10px] py-[5px] text-[11px]",
        "border transition-colors duration-100 ease-out cursor-pointer",
        active
          ? "bg-[#ededeb] dark:bg-white/10 border-[#dcdcd7] dark:border-white/15 text-foreground font-medium"
          : "bg-card border-border text-muted-foreground font-normal hover:bg-accent",
      )}
      style={{ borderWidth: "0.5px" }}
    >
      <span>{label}</span>
      <span className="opacity-70 tabular-nums">{count}</span>
    </button>
  );
}
