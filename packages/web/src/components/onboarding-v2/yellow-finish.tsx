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
      <img src="/logos/sketch-logo-dark.png" alt="Sketch" style={{ height: 48, width: "auto" }} />
      <div className="ob-finish-heading">You're ready.</div>
      <div className="ob-finish-subtitle">Message Sketch to get started.</div>
      <button type="button" className="ob-btn ob-btn-dark" onClick={onCta}>
        {ctaLabel}
      </button>
    </div>
  );
}
