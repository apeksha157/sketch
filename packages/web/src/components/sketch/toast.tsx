import type { IconProps } from "@/components/sketch/icons";
/**
 * Toast — §4.14. Transient surface, top-right of the main pane.
 *
 * The component here is the visual primitive only. The list of trigger events
 * and their copy is a separate work item (§9 open question). Routes that need
 * to demo a fresh-failure toast (e.g. /home/automation-failed) render a
 * single instance directly.
 */
import { cn } from "@sketch/ui/lib/utils";
import type { ComponentType, ReactNode } from "react";
import { useEffect } from "react";

export interface ToastItem {
  id: string;
  icon?: ComponentType<IconProps>;
  iconColorClass?: string;
  title: string;
  detail?: string;
  /** Where the toast deep-links when its body is clicked. */
  onActivate?: () => void;
  onDismiss?: () => void;
  /** Auto-dismiss after this many ms. Defaults to 6000. */
  autoDismissMs?: number;
}

export function Toast({ item }: { item: ToastItem }) {
  const Icon = item.icon;

  useEffect(() => {
    if (item.onDismiss === undefined) return;
    const ms = item.autoDismissMs ?? 6000;
    const id = window.setTimeout(() => item.onDismiss?.(), ms);
    return () => window.clearTimeout(id);
  }, [item]);

  /**
   * Two adjacent buttons (activate + dismiss) inside a non-interactive wrapper.
   * Nested clickables would be invalid HTML, so we deliberately don't put a
   * single onClick on the wrapper — each surface keeps its own keyboard path.
   */
  return (
    <output
      className={cn(
        "sketch-toast-in pointer-events-auto flex items-start gap-[10px]",
        "max-w-[320px] rounded-[7px] border border-border bg-card px-[14px] py-[12px]",
      )}
      style={{
        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
        animation: "sketch-toast-in 200ms ease-out",
      }}
    >
      <button
        type="button"
        onClick={item.onActivate}
        className={cn(
          "-m-[2px] flex min-w-0 flex-1 items-start gap-[10px] rounded-[5px] p-[2px] text-left",
          "transition-colors duration-100 ease-out cursor-pointer hover:bg-accent",
        )}
      >
        {Icon && <Icon size={15} className={cn("mt-[1px] shrink-0", item.iconColorClass)} aria-hidden />}
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="text-[12px] font-medium text-foreground leading-tight">{item.title}</span>
          {item.detail && <span className="text-[11px] text-muted-foreground leading-tight">{item.detail}</span>}
        </span>
      </button>
      <button
        type="button"
        onClick={item.onDismiss}
        className="shrink-0 text-muted-foreground/65 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
        aria-label="Dismiss"
      >
        <DismissGlyph />
      </button>
    </output>
  );
}

function DismissGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" role="img" aria-label="Dismiss">
      <title>Dismiss</title>
      <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** Vertical stack container — positions in top-right of the main pane (§4.14). */
export function ToastStack({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute right-[20px] top-[20px] z-30 flex flex-col gap-[8px]">{children}</div>
  );
}
