import { useTheme } from "@sketch/ui";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import "./onboarding.css";

import { AuthPicker } from "./auth-picker";
import { BRAND_ICONS, hasRichMarker, isSketchOrigin, renderRichMessage } from "./chat-helpers";
import { ConnCard } from "./conn-card";
import { ErrorState } from "./error-state";
import { SectionDivider } from "./section-divider";
import { SketchMessage } from "./sketch-message";
import type { ChatMessage } from "./types";
import { useMemberFlow } from "./use-member-flow";
import { UserMessage } from "./user-message";
import { WhatsAppNumberInput } from "./whatsapp-number-input";

/** Member onboarding chat — shorter flow than the admin's. Auth → detection → (Slack: redirect) | (Google: WhatsApp number → redirect). */
export function OnboardingMemberChat() {
  const { resolvedTheme, setTheme } = useTheme();
  const chatRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  const userScrollingRef = useRef(false);
  const userScrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastActiveWidgetIdRef = useRef<string | null>(null);

  const {
    messages,
    activeWidget,
    state,
    startFlow,
    handleAuthSelect,
    handleConnComplete,
    handleWhatsAppNumberSubmit,
    handleRetryAuth,
    handleGoToLogin,
  } = useMemberFlow();

  // Start once (StrictMode-safe)
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startFlow();
  }, [startFlow]);

  const handleWheel = useCallback(() => {
    userScrollingRef.current = true;
    clearTimeout(userScrollTimerRef.current);
    userScrollTimerRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, 2000);
  }, []);

  /** Auto-scroll to keep newest content in view, unless the user is actively scrolling. */
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    if (userScrollingRef.current) return;

    const currentWidgetId = activeWidget?.id ?? null;
    const widgetChanged = currentWidgetId !== lastActiveWidgetIdRef.current;
    lastActiveWidgetIdRef.current = currentWidgetId;

    if (!widgetChanged && messages.length > 0) return;

    const spacerEl = el.querySelector<HTMLElement>(".ob-bottom-spacer");
    const contentEndY = spacerEl
      ? spacerEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
      : el.scrollHeight;

    const viewportBottom = el.scrollTop + el.clientHeight;
    if (contentEndY > viewportBottom + 10) {
      const target = contentEndY - el.clientHeight + 20;
      if (target > el.scrollTop + 1) {
        el.scrollTo({ top: target, behavior: "smooth" });
      }
    }
  }, [messages, activeWidget]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages and activeWidget trigger spacer recalc
  useLayoutEffect(() => {
    const el = chatRef.current;
    const spacer = spacerRef.current;
    if (!el || !spacer) return;
    spacer.style.height = state.completed ? "28px" : "0px";
  }, [messages, activeWidget, state.completed]);

  const renderMessage = (msg: ChatMessage, index: number) => {
    switch (msg.kind) {
      case "sketch-message": {
        const hideLabel = isSketchOrigin(messages[index - 1]);
        const rich = hasRichMarker(msg.text);
        return (
          <SketchMessage
            key={msg.id}
            text={rich ? "" : msg.text || ""}
            step={msg.step}
            hideLabel={hideLabel}
            dim={msg.dim}
            danger={msg.danger}
            highlight={msg.highlight}
          >
            {rich ? renderRichMessage(msg.text || "") : undefined}
          </SketchMessage>
        );
      }
      case "user-message": {
        const iconKey = msg.widgetProps?.icon as string | undefined;
        return (
          <UserMessage
            key={msg.id}
            text={msg.text || ""}
            step={msg.step}
            icon={iconKey ? BRAND_ICONS[iconKey] : undefined}
          />
        );
      }
      case "divider":
        return <SectionDivider key={msg.id} label={msg.label || ""} step={msg.step} />;
      case "widget":
        return renderInlineWidget(msg);
      default:
        return null;
    }
  };

  const renderInlineWidget = (msg: ChatMessage) => {
    switch (msg.widgetType) {
      case "conn-card": {
        const props = msg.widgetProps as { authMethod: "slack" | "google" | "whatsapp"; phone?: string };
        return <ConnCard key={msg.id} authMethod={props.authMethod} phone={props.phone} onComplete={() => {}} frozen />;
      }
      default:
        return null;
    }
  };

  const renderActiveWidget = () => {
    if (!activeWidget) return null;

    switch (activeWidget.widgetType) {
      case "auth-picker":
        return <AuthPicker onSelect={handleAuthSelect} />;
      case "conn-card": {
        const props = activeWidget.widgetProps as { authMethod: "slack" | "google"; skipSuccess?: boolean };
        return (
          <ConnCard authMethod={props.authMethod} onComplete={handleConnComplete} skipSuccess={props.skipSuccess} />
        );
      }
      case "whatsapp-number-input":
        return (
          <WhatsAppNumberInput
            onSubmit={handleWhatsAppNumberSubmit}
            helpText="I'll remember this so your team can find you on WhatsApp."
          />
        );
      case "error-state": {
        const props = activeWidget.widgetProps as {
          errorType: "generic-email" | "already-registered" | "workspace-not-ready";
          name?: string;
        };
        return (
          <ErrorState
            errorType={props.errorType}
            name={props.name}
            onRetry={handleRetryAuth}
            onLogin={handleGoToLogin}
          />
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="onboarding-root">
      <div className="ob-container">
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

        {/* Chat area — no StepTrack: member flow is short enough to skip the rail */}
        <div className="ob-chat" ref={chatRef} onWheel={handleWheel} onTouchMove={handleWheel}>
          {messages.map(renderMessage)}
          {renderActiveWidget()}
          <div ref={spacerRef} className="ob-bottom-spacer" data-completed={state.completed} />
        </div>
      </div>
    </div>
  );
}
