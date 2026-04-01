interface YellowFinishProps {
  isAdmin: boolean;
  slackConnected: boolean;
  whatsappConnected: boolean;
  onOpenSlack?: () => void;
  onOpenWhatsApp?: () => void;
  onDashboard?: () => void;
}

/** Yellow #FEED01 card with Gloria Hallelujah heading and dynamic CTAs. */
export function YellowFinish({
  isAdmin,
  slackConnected,
  whatsappConnected,
  onOpenSlack,
  onOpenWhatsApp,
  onDashboard,
}: YellowFinishProps) {
  const subtitle = isAdmin ? "Sketch is live for your team." : "Your team is already on Sketch.";

  return (
    <div className="ob-finish ob-animate-finish">
      <div className="ob-finish-heading">
        <img src="/logos/sketch-icon-light.png" alt="" aria-hidden="true" className="ob-finish-icon" />
        is now ready.
      </div>
      <div className="ob-finish-subtitle">{subtitle}</div>
      <div className="ob-finish-ctas">
        <div className="ob-finish-ctas-row">
          {slackConnected && (
            <button type="button" className="ob-btn ob-btn-dark" onClick={onOpenSlack}>
              Open Slack
            </button>
          )}
          {whatsappConnected && (
            <button type="button" className="ob-btn ob-btn-dark" onClick={onOpenWhatsApp}>
              Open WhatsApp
            </button>
          )}
        </div>
        <button type="button" className="ob-btn ob-btn-ghost ob-btn-ghost-on-yellow" onClick={onDashboard}>
          Go to dashboard
        </button>
      </div>
    </div>
  );
}
