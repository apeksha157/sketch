/**
 * The quiet text action used on one-line review rows and band headers —
 * 11px, no chrome, `emphasis` marks the primary verb. One component so the
 * review band, WhatsApp lane, verdict lanes, and suggestion rows all read
 * identically.
 */
import { cn } from "@sketch/ui/lib/utils";

export function CompactAction({
  label,
  emphasis,
  disabled = false,
  className,
  onClick,
  "data-testid": testId,
}: {
  label: string;
  emphasis?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "px-1.5 py-0.5 text-[11px] disabled:opacity-40",
        emphasis ? "font-medium text-foreground hover:underline" : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {label}
    </button>
  );
}
