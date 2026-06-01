interface TrialCardProps {
  onStart: () => void;
  /** When true, renders the post-click state (no CTA, confirmation footer). */
  frozen?: boolean;
}

/** Trial summary card — hero headline, post-trial pricing, escape-hatch links, and CTA. */
export function TrialCard({ onStart, frozen = false }: TrialCardProps) {
  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-trial-card" data-frozen={frozen}>
        <div className="ob-trial-card-header">
          <span>Trial</span>
          {frozen && (
            <span className="ob-trial-card-started">
              <CheckIcon />
              Started
            </span>
          )}
        </div>

        <div className="ob-trial-hero">
          <div className="ob-trial-hero-sparkle" aria-hidden="true">
            ✦
          </div>
          <div className="ob-trial-hero-text">
            <div className="ob-trial-hero-title">30 days free</div>
            <div className="ob-trial-hero-sub">No credit card needed</div>
          </div>
        </div>

        <div className="ob-trial-then">
          <div className="ob-trial-then-label">After trial</div>
          <div className="ob-trial-then-row">
            <span className="ob-trial-then-plan">Basic</span>
            <span className="ob-trial-then-price">$99/mo</span>
          </div>
          <div className="ob-trial-then-credits">Includes 10,000 credits every month</div>
        </div>

        <div className="ob-trial-card-links">
          <a href="/pricing" className="ob-trial-card-link" target="_blank" rel="noreferrer">
            How credits work
            <LinkIcon />
          </a>
          <a href="https://github.com/canvasxai/sketch" className="ob-trial-card-link" target="_blank" rel="noreferrer">
            Self-host free on GitHub
            <LinkIcon />
          </a>
        </div>

        {!frozen && (
          <button type="button" className="ob-btn ob-btn-primary ob-trial-card-cta" onClick={onStart}>
            Start trial
          </button>
        )}
      </div>
    </div>
  );
}

function LinkIcon() {
  return (
    <svg
      className="ob-trial-card-link-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
