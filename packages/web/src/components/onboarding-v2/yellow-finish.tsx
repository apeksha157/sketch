import { SketchIcon } from "./spark-icon";
import type { AuthMethod } from "./types";

interface YellowFinishProps {
  authMethod: AuthMethod;
  onCta: () => void;
}

/** Yellow #FEED01 card with Gloria Hallelujah heading and CTA. */
export function YellowFinish({ authMethod, onCta }: YellowFinishProps) {
  const ctaLabel = authMethod === "slack" ? "OPEN SLACK →" : "OPEN WHATSAPP →";

  return (
    <div className="ob-finish ob-animate-finish">
      <SketchIcon size={36} variant="light" />
      <div className="ob-finish-heading">You're ready.</div>
      <div className="ob-finish-subtitle">Message Sketch to get started.</div>
      <button type="button" className="ob-finish-cta" onClick={onCta}>
        {ctaLabel}
      </button>
    </div>
  );
}
