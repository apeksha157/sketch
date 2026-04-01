import type { ErrorType } from "./types";

interface ErrorStateProps {
  errorType: ErrorType;
  name?: string;
  adminEmail?: string;
  onRetry?: () => void;
  onLogin?: () => void;
}

/** Inline error/edge state rendered within the chat flow. */
export function ErrorState({ errorType, name, adminEmail, onRetry, onLogin }: ErrorStateProps) {
  switch (errorType) {
    case "generic-email":
      return (
        <div className="ob-widget ob-animate-in">
          <button type="button" className="ob-btn ob-btn-ghost" onClick={onRetry}>
            Try a different account
          </button>
        </div>
      );

    case "already-registered":
      return (
        <div className="ob-widget ob-animate-in">
          <button type="button" className="ob-btn ob-btn-primary" onClick={onLogin}>
            Get back in
          </button>
        </div>
      );

    case "workspace-not-ready":
      return null;

    default:
      return null;
  }
}
