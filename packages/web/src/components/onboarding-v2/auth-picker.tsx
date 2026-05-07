import type { AuthMethod } from "./types";

interface AuthPickerProps {
  onSelect: (method: AuthMethod) => void;
}

/** Slack 4-color logo */
function SlackLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5.042 15.166a2.528 2.528 0 0 1-2.52 2.521A2.528 2.528 0 0 1 0 15.166a2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zm1.268 0a2.528 2.528 0 0 1 2.521-2.52 2.528 2.528 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.831 24a2.528 2.528 0 0 1-2.52-2.521v-6.313z"
        fill="#E01E5A"
      />
      <path
        d="M8.831 5.042a2.528 2.528 0 0 1-2.52-2.52A2.528 2.528 0 0 1 8.831 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.831zm0 1.268a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.52 2.521H2.52A2.528 2.528 0 0 1 0 8.831a2.528 2.528 0 0 1 2.522-2.52h6.309z"
        fill="#36C5F0"
      />
      <path
        d="M18.958 8.831a2.528 2.528 0 0 1 2.52-2.52A2.528 2.528 0 0 1 24 8.831a2.528 2.528 0 0 1-2.522 2.521h-2.52V8.831zm-1.268 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.52V2.52A2.528 2.528 0 0 1 15.169 0a2.528 2.528 0 0 1 2.52 2.522v6.309z"
        fill="#2EB67D"
      />
      <path
        d="M15.169 18.958a2.528 2.528 0 0 1 2.52 2.52A2.528 2.528 0 0 1 15.169 24a2.528 2.528 0 0 1-2.521-2.522v-2.52h2.52zm0-1.268a2.528 2.528 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.52-2.521h6.313A2.528 2.528 0 0 1 24 15.169a2.528 2.528 0 0 1-2.522 2.52h-6.309z"
        fill="#ECB22E"
      />
    </svg>
  );
}

/** Google 4-color "G" logo */
function GoogleLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

/** Two stacked cards for Slack OAuth and Google Auth with brand SVG logos. */
export function AuthPicker({ onSelect }: AuthPickerProps) {
  return (
    <div className="ob-widget ob-animate-in" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button type="button" className="ob-auth-card" onClick={() => onSelect("slack")}>
        <div className="ob-auth-icon-container">
          <SlackLogo size={24} />
        </div>
        <div>
          <div className="ob-auth-title">Sign in with Slack</div>
          <div className="ob-auth-subtitle">Adds Sketch to your workspace</div>
        </div>
      </button>
      <button type="button" className="ob-auth-card" onClick={() => onSelect("google")}>
        <div className="ob-auth-icon-container">
          <GoogleLogo size={24} />
        </div>
        <div>
          <div className="ob-auth-title">Sign in with Google</div>
          <div className="ob-auth-subtitle">No Slack? Start here</div>
        </div>
      </button>
      <p className="ob-auth-trial-note">Free for 30 days · No credit card</p>
    </div>
  );
}
