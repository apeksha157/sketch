interface WhatsAppPickerProps {
  canSkip: boolean;
  onConnect: () => void;
  onSkip: () => void;
}

/** Pill buttons: Connect WhatsApp / Maybe later. */
export function WhatsAppPicker({ canSkip, onConnect, onSkip }: WhatsAppPickerProps) {
  return (
    <div className="ob-widget ob-animate-in ob-cta-row">
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
