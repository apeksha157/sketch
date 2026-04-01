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
      <img src="/logos/sketch-logo-dark.png" alt="Sketch" style={{ height: 48, width: "auto" }} />
      <div className="ob-finish-heading">Ready.</div>
      <div className="ob-finish-subtitle">{subtitle}</div>
      <div className="ob-finish-ctas">
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
        <button type="button" className="ob-btn ob-btn-ghost ob-btn-ghost-on-yellow" onClick={onDashboard}>
          Go to dashboard
        </button>
      </div>
    </div>
  );
}
