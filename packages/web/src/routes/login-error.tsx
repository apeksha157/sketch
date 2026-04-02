import { useTheme } from "@/hooks/use-theme";
import "@/components/onboarding-v2/onboarding.css";
import { AuthPicker } from "@/components/onboarding-v2/auth-picker";
import { SectionDivider } from "@/components/onboarding-v2/section-divider";
import { SketchMessage } from "@/components/onboarding-v2/sketch-message";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { rootRoute } from "./root";

export const loginErrorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login-error",
  component: LoginErrorPage,
});

function LoginErrorPage() {
  const { resolvedTheme, setTheme } = useTheme();
  const [showError, setShowError] = useState(false);

  return (
    <div className="onboarding-root">
      <div className="ob-container ob-login-container">
        {/* Header */}
        <div className="ob-header">
          <div className="ob-header-left">
            <img
              src={resolvedTheme === "dark" ? "/logos/sketch-logo-light.png" : "/logos/sketch-logo-dark.png"}
              alt="Sketch"
              style={{ height: 40, width: "auto" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="ob-theme-toggle"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {resolvedTheme === "dark" ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        <div className="ob-login-body">
          <SectionDivider label="Login" step={0} />

          <SketchMessage text="Good to have you back." step={0} />
          <SketchMessage text="How would you like to sign in?" step={0} hideLabel />

          <AuthPicker
            onSelect={(method) => {
              if (method === "google") {
                setShowError(true);
              }
            }}
          />

          {showError && (
            <SketchMessage
              text="That looks like a personal email — Sketch requires a work email to sign in. Try again with your company email."
              step={0}
              hideLabel
              danger
            />
          )}

          <div className="ob-login-footer">
            Don't have an account?{" "}
            <a href="/onboarding" className="ob-login-signup-link">
              Sign up →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
