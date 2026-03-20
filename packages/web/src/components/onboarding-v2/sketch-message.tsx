import { SparkAvatar } from "./spark-icon";

interface SketchMessageProps {
  text: string;
  step: number;
}

/** Left-aligned message from Sketch with spark avatar and "SKETCH" label. */
export function SketchMessage({ text, step }: SketchMessageProps) {
  return (
    <div className="ob-msg ob-animate-in" data-step={step}>
      <div className="ob-msg-label ob-msg-label-sketch">
        <SparkAvatar size={24} />
        SKETCH
      </div>
      <div className="ob-msg-body ob-msg-body-sketch">{text}</div>
    </div>
  );
}
