interface WhatsAppPickerProps {
  /** Google auth users can't skip — no "Maybe later" option */
  canSkip: boolean;
  onConnect: () => void;
  onSkip: () => void;
}

/** Pill buttons: Connect WhatsApp / Maybe later. */
export function WhatsAppPicker({ canSkip, onConnect, onSkip }: WhatsAppPickerProps) {
  return (
    <div className="ob-widget ob-animate-in" style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <button type="button" className="ob-cta ob-cta-primary" onClick={onConnect}>
        Connect WhatsApp
      </button>
      {canSkip && (
        <button type="button" className="ob-pill ob-pill-ghost" onClick={onSkip}>
          Maybe later
        </button>
      )}
    </div>
  );
}
