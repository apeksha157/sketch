interface WhatsAppPickerProps {
  canSkip: boolean;
  onConnect: () => void;
  onSkip: () => void;
}

/** Pill buttons: Connect WhatsApp / Maybe later. */
export function WhatsAppPicker({ canSkip, onConnect, onSkip }: WhatsAppPickerProps) {
  return (
    <div className="ob-widget ob-animate-in" style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <button type="button" className="ob-btn ob-btn-primary" onClick={onConnect}>
        Connect WhatsApp
      </button>
      {canSkip && (
        <button type="button" className="ob-btn ob-btn-ghost" onClick={onSkip}>
          Maybe later
        </button>
      )}
    </div>
  );
}
