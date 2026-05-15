/**
 * Status indicators — §4.13 of the design spec.
 *
 * - NavBadge: red count chip used inside sidebar nav items when a section needs
 *   attention (disconnected channels, failed automations, etc.).
 * - RunningPulse: yellow pulsing dot with halo, used on the Scheduled tasks
 *   icon when a run is currently executing. Animation is the 1.4s loop spec'd
 *   in §3.6 and collapses to a static dot under prefers-reduced-motion.
 */
import { cn } from "@sketch/ui/lib/utils";

export function NavBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-[8px] px-[6px] py-[1px] text-[11px] font-medium",
        "bg-destructive/15 text-destructive",
        className,
      )}
      aria-label={`${count} attention${count === 1 ? "" : "s"}`}
    >
      {count}
    </span>
  );
}

export function RunningPulse({ className, label = "Run in progress" }: { className?: string; label?: string }) {
  return (
    <span className={cn("relative inline-flex h-[6px] w-[6px] shrink-0", className)} role="img" aria-label={label}>
      <span
        className="sketch-pulse absolute inset-0 rounded-full bg-brand-yellow"
        style={{
          boxShadow: "0 0 0 3px rgba(254, 237, 1, 0.18)",
          animation: "sketch-pulse 1.4s ease-in-out infinite",
        }}
      />
    </span>
  );
}
