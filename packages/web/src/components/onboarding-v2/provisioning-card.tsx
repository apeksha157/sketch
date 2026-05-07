import { useEffect, useRef, useState } from "react";

interface ProvisioningCardProps {
  companyName: string;
  email: string;
  onComplete: () => void;
  /** Duration in ms before auto-completing (default 15000) */
  duration?: number;
  /** When true, render in the completed state instantly and skip timers. */
  frozen?: boolean;
}

const STATUS_MESSAGES = [
  "Creating your workspace",
  "Setting up secure storage",
  "Configuring your server",
  "Running final checks",
  "Almost there",
];

/** Provisioning progress card shown while the private instance is being set up. */
export function ProvisioningCard({
  companyName,
  email,
  onComplete,
  duration = 60_000,
  frozen = false,
}: ProvisioningCardProps) {
  const [elapsed, setElapsed] = useState(frozen ? duration : 0);
  const [complete, setComplete] = useState(frozen);
  const startRef = useRef(Date.now());
  const completedRef = useRef(frozen);

  // Elapsed timer
  useEffect(() => {
    if (frozen) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const ms = now - startRef.current;
      setElapsed(ms);

      if (ms >= duration && !completedRef.current) {
        completedRef.current = true;
        setComplete(true);
        clearInterval(interval);
        setTimeout(onComplete, 800);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [duration, onComplete, frozen]);

  const totalSteps = STATUS_MESSAGES.length;
  const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 100;

  // Bind step index to elapsed/duration so steps advance evenly across the actual duration —
  // previously the rotation was a fixed 15s interval, which decoupled it from total time
  // and made the demo (15s total) only ever show the first message.
  const stepIndex = duration > 0 ? Math.min(totalSteps - 1, Math.floor((elapsed / duration) * totalSteps)) : 0;

  // Remaining countdown (replaces elapsed). Floored to seconds; pad to MM:SS.
  const remainingMs = Math.max(0, duration - elapsed);
  const remainingMinutes = Math.floor(remainingMs / 60_000);
  const remainingSeconds = Math.floor((remainingMs % 60_000) / 1000);
  const remaining = `${String(remainingMinutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-provision-card">
        <div className="ob-provision-headline">Setting up your private instance</div>
        <p className="ob-provision-subhead">
          Spinning up a dedicated server for <strong>{companyName}</strong>.
        </p>
        <p className="ob-provision-privacy">Your data stays private, never shared.</p>

        {/* Progress block */}
        <div className="ob-provision-progress">
          <div className="ob-provision-progress-header">
            <span className="ob-provision-progress-label">
              Step {Math.min(stepIndex + 1, totalSteps)} of {totalSteps}
            </span>
            <span className="ob-provision-timer">{remaining} remaining</span>
          </div>
          {!complete && (
            <div className="ob-provision-status" key={stepIndex}>
              {STATUS_MESSAGES[stepIndex]}
            </div>
          )}
          <div className="ob-provision-bar-track">
            <div className="ob-provision-bar-fill" data-complete={complete} style={{ width: `${progress}%` }} />
          </div>
        </div>

        <p className="ob-provision-footnote">
          Takes 1-10 minutes. We'll email <strong>{email}</strong> when it's live.
        </p>

        {/* While you wait — compact CTA. Body line removed; the title now carries the
            "15 min with our founder" detail inline so the whole block stays at 2 rows max. */}
        <div className="ob-provision-wait-card">
          <div className="ob-provision-wait-content">
            <div className="ob-provision-wait-header">
              <div>
                <div className="ob-provision-wait-label">WHILE YOU WAIT</div>
                <div className="ob-provision-wait-title">Meet the team — 15 min with our founder</div>
              </div>
              <a
                href="https://calendly.com"
                target="_blank"
                rel="noopener noreferrer"
                className="ob-provision-wait-cta"
              >
                Book a call &rarr;
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
