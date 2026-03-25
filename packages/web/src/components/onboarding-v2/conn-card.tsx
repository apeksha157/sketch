import { useEffect, useState } from "react";
import { SparkAvatar } from "./spark-icon";

interface ConnCardProps {
  authMethod: "slack" | "google" | "whatsapp";
  onComplete: () => void;
  frozen?: boolean;
  phone?: string;
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
  whatsapp: {
    loading: "Connecting WhatsApp...",
    success: "WhatsApp connected.",
    detail: "Ready to go.",
  },
};

/** Connection card that shows a loading spinner then transitions to a success message in-place. */
export function ConnCard({ authMethod, onComplete, frozen = false, phone }: ConnCardProps) {
  const [done, setDone] = useState(frozen);

  useEffect(() => {
    if (frozen) return;
    // Show confirmation first, then proceed after a 2s pause
    const t1 = setTimeout(() => setDone(true), 2000);
    const t2 = setTimeout(() => onComplete(), 4000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [frozen, onComplete]);

  const { loading, success, detail } = copy[authMethod];
  const isWhatsApp = authMethod === "whatsapp" && phone;

  return (
    <div className="ob-msg ob-animate-in" data-step={0}>
      <div className="ob-msg-label ob-msg-label-sketch">
        <SparkAvatar size={24} />
        SKETCH
      </div>
      <div className="ob-msg-body ob-msg-body-sketch">
        {done ? (
          isWhatsApp ? (
            <>
              <span className="ob-conn-green">{phone} connected.</span> {detail}
            </>
          ) : (
            <>
              <span className="ob-conn-green">{success}</span> {detail}
            </>
          )
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
