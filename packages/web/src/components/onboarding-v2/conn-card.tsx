import { useEffect, useState } from "react";
import { SparkAvatar } from "./spark-icon";

interface ConnCardProps {
  authMethod: "slack" | "google";
  onComplete: () => void;
}

const copy = {
  slack: {
    loading: "Connecting to Slack...",
    success: "Slack connected.",
    detail: "Sketch has joined your workspace.",
  },
  google: {
    loading: "Setting up Google...",
    success: "Google connected.",
    detail: "Your workspace is ready.",
  },
};

/** Connection card that shows a loading spinner then transitions to a success message in-place. */
export function ConnCard({ authMethod, onComplete }: ConnCardProps) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDone(true);
      onComplete();
    }, 2000);
    return () => clearTimeout(timer);
  }, [onComplete]);

  const { loading, success, detail } = copy[authMethod];

  return (
    <div className="ob-msg ob-animate-in" data-step={0}>
      <div className="ob-msg-label ob-msg-label-sketch">
        <SparkAvatar size={24} />
        SKETCH
      </div>
      <div className="ob-msg-body ob-msg-body-sketch">
        {done ? (
          <>
            <span className="ob-conn-green">{success}</span> {detail}
          </>
        ) : (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span className="ob-spinner" />
            <span style={{ color: "var(--ob-text-dim)" }}>{loading}</span>
          </span>
        )}
      </div>
    </div>
  );
}
