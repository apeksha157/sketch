/**
 * Filter pill — §4.9. Used on /conversations for channel filtering.
 *
 * Active palette uses solid greys (#ededeb in light, rgba(255,255,255,0.10)
 * in dark) so it reads as a state, not as an accent. Count appears in 70%
 * opacity to subordinate it to the label.
 *
 * Channel-specific pills can pass a small leading icon so the filter row
 * echoes the channel glyphs used on the conversation rows below.
 */
import type { IconProps } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";
import type { ComponentType } from "react";

export interface FilterPillProps {
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
  /** Optional leading icon — e.g., a channel brand glyph. */
  icon?: ComponentType<IconProps>;
  /**
   * Phosphor weight for the leading icon. Defaults to "regular"; pass
   * "bold" or "fill" for line-art icons (e.g., the 3×3 grid) that need
   * to match the visual weight of denser brand glyphs.
   */
  iconWeight?: IconProps["weight"];
}

export function FilterPill({ label, count, active, onClick, icon: Icon, iconWeight = "regular" }: FilterPillProps) {
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
      {Icon && <Icon size={11} weight={iconWeight} aria-hidden className="shrink-0" />}
      <span>{label}</span>
      <span className="opacity-70 tabular-nums">{count}</span>
    </button>
  );
}
