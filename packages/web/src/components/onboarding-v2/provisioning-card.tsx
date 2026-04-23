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

const STATUS_INTERVAL = 15_000;

/** Provisioning progress card shown while the private instance is being set up. */
export function ProvisioningCard({
  companyName,
  email,
  onComplete,
  duration = 60_000,
  frozen = false,
}: ProvisioningCardProps) {
  const [elapsed, setElapsed] = useState(frozen ? duration : 0);
  const [statusIndex, setStatusIndex] = useState(0);
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

  // Rotating status message
  useEffect(() => {
    if (frozen) return;
    const interval = setInterval(() => {
      setStatusIndex((prev) => (prev + 1) % STATUS_MESSAGES.length);
    }, STATUS_INTERVAL);
    return () => clearInterval(interval);
  }, [frozen]);

  const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 100;

  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  const timer = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

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
            <span className="ob-provision-progress-label">Provisioning your instance</span>
            <span className="ob-provision-timer">{timer} elapsed</span>
          </div>
          {!complete && (
            <div className="ob-provision-status" key={statusIndex}>
              {STATUS_MESSAGES[statusIndex]}
            </div>
          )}
          <div className="ob-provision-bar-track">
            <div className="ob-provision-bar-fill" data-complete={complete} style={{ width: `${progress}%` }} />
          </div>
        </div>

        <p className="ob-provision-footnote">
          Takes 1-10 minutes. We'll email <strong>{email}</strong> when it's live.
        </p>

        {/* While you wait card */}
        <div className="ob-provision-wait-card">
          <div className="ob-provision-wait-content">
            <div className="ob-provision-wait-header">
              <div>
                <div className="ob-provision-wait-label">WHILE YOU WAIT</div>
                <div className="ob-provision-wait-title">Want to meet the team?</div>
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
            <p className="ob-provision-wait-body">Grab 15 min with our founder — ask anything or say hi.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
