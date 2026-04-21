import type { ReactNode } from "react";

interface UserMessageProps {
  text: string;
  step: number;
  icon?: ReactNode;
}

/** Right-aligned message showing user's selection as a pill with optional brand icon. */
export function UserMessage({ text, step, icon }: UserMessageProps) {
  return (
    <div className="ob-msg ob-animate-in" data-step={step}>
      <div className="ob-msg-label ob-msg-label-user">YOU</div>
      <div className="ob-msg-body ob-msg-body-user">
        <span className="ob-user-pill">
          {icon}
          {text}
        </span>
      </div>
    </div>
  );
}
