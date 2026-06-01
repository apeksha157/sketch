import type { ReactNode } from "react";
import { SparkAvatar } from "./spark-icon";

interface SketchMessageProps {
  text: string;
  step: number;
  /** When true, omit the avatar + label row (message is a continuation of the previous batch). */
  hideLabel?: boolean;
  /** When true, renders as smaller dimmed tertiary copy. */
  dim?: boolean;
  /** When true, renders in danger/error color. */
  danger?: boolean;
  /** When true, marks the message with a subtle yellow accent for added emphasis. */
  highlight?: boolean;
  /** Optional children override — when provided, renders instead of text. */
  children?: ReactNode;
}

/** Left-aligned message from Sketch. Hides avatar/label when it's a continuation of a batch. */
export function SketchMessage({
  text,
  step,
  hideLabel = false,
  dim = false,
  danger = false,
  highlight = false,
  children,
}: SketchMessageProps) {
  const bodyClass = [
    "ob-msg-body ob-msg-body-sketch",
    dim && "ob-msg-body-dim",
    danger && "ob-msg-body-danger",
    highlight && "ob-msg-body-highlight",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`ob-msg ob-animate-in${hideLabel ? " ob-msg-continued" : ""}`} data-step={step}>
      {!hideLabel && (
        <div className="ob-msg-label ob-msg-label-sketch">
          <SparkAvatar size={24} />
          SKETCH
        </div>
      )}
      <div className={bodyClass}>{children || text}</div>
    </div>
  );
}
