/**
 * Celebration card — §4.16.
 *
 * Slides in 200ms after page mount the first time a user lands on /home/default
 * after completing setup. Dismiss is permanent (storage flag handled by the
 * route; this component only renders + animates).
 */
import { cn } from "@sketch/ui/lib/utils";
import { useEffect, useState } from "react";

export interface CelebrationCardProps {
  /** Render delay in ms — spec defaults to 200ms after mount. */
  delayMs?: number;
  onDismiss?: () => void;
  className?: string;
}

export function CelebrationCard({ delayMs = 200, onDismiss, className }: CelebrationCardProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);

  if (!visible) return null;

  return (
    <section
      aria-label="Setup complete"
      className={cn(
        "sketch-celebration-in flex w-full items-center gap-[12px] rounded-[12px]",
        "bg-card border border-border px-[18px] py-[16px]",
        "border-l-4 border-l-[color:var(--brand-yellow)]",
        className,
      )}
      style={{ animation: "sketch-celebration-in 200ms ease-out" }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
        <span className="text-[13px] font-medium text-foreground">🎉 You're all set</span>
        <span className="text-[12px] text-muted-foreground leading-[1.4]">
          Try asking Sketch to send a Slack message, or schedule a recurring task to run on its own.
        </span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className={cn(
          "shrink-0 rounded-[6px] bg-brand-yellow text-brand-brown px-[12px] py-[5px]",
          "text-[11px] font-medium hover:bg-brand-yellow/90 transition-colors duration-100 ease-out cursor-pointer",
        )}
      >
        Got it
      </button>
    </section>
  );
}
