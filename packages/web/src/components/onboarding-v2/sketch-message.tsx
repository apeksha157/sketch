import { SparkAvatar } from "./spark-icon";

interface SketchMessageProps {
  text: string;
  step: number;
  /** When true, omit the avatar + label row (message is a continuation of the previous batch). */
  hideLabel?: boolean;
  /** When true, renders as smaller dimmed tertiary copy. */
  dim?: boolean;
}

/** Left-aligned message from Sketch. Hides avatar/label when it's a continuation of a batch. */
export function SketchMessage({ text, step, hideLabel = false, dim = false }: SketchMessageProps) {
  return (
    <div className={`ob-msg ob-animate-in${hideLabel ? " ob-msg-continued" : ""}`} data-step={step}>
      {!hideLabel && (
        <div className="ob-msg-label ob-msg-label-sketch">
          <SparkAvatar size={24} />
          SKETCH
        </div>
      )}
      <div className={`ob-msg-body ob-msg-body-sketch${dim ? " ob-msg-body-dim" : ""}`}>{text}</div>
    </div>
  );
}
