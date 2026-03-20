import { type ReactNode, useCallback, useEffect, useRef } from "react";
import "./onboarding.css";

import { ApiKeyInput } from "./api-key-input";
import { AuthPicker } from "./auth-picker";
import { ConnCard } from "./conn-card";
import { QRCard } from "./qr-card";
import { SectionDivider } from "./section-divider";
import { SketchMessage } from "./sketch-message";
import { SketchIcon, SparkAvatar } from "./spark-icon";
import { StepTrack } from "./step-track";
import type { ChatMessage } from "./types";
import { useOnboardingFlow } from "./use-onboarding-flow";
import { UserMessage } from "./user-message";
import { WhatsAppPicker } from "./whatsapp-picker";
import { WorkspaceCard } from "./workspace-card";
import { YellowFinish } from "./yellow-finish";

/* ── Brand icons for user message pills ── */

function SlackMiniIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function GoogleMiniIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function WhatsAppMiniIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

function AwsMiniIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7.164 10.59c0 .262.028.475.077.632a4.08 4.08 0 0 0 .225.52c.035.056.05.112.05.161 0 .07-.043.14-.134.21l-.443.296a.34.34 0 0 1-.183.063c-.07 0-.14-.035-.21-.098a2.17 2.17 0 0 1-.254-.33 5.5 5.5 0 0 1-.218-.415c-.548.646-1.237.97-2.066.97-.59 0-1.062-.169-1.407-.506-.345-.337-.52-.786-.52-1.348 0-.597.21-1.08.639-1.444.428-.365 .998-.548 1.722-.548.24 0 .486.02.744.056.259.036.526.092.806.161v-.513c0-.534-.112-.906-.33-1.122-.224-.217-.604-.322-1.145-.322-.246 0-.499.03-.76.091a5.6 5.6 0 0 0-.76.24 2.02 2.02 0 0 1-.246.091.43.43 0 0 1-.113.021c-.098 0-.147-.07-.147-.217v-.345c0-.112.014-.196.05-.245.035-.05.098-.098.197-.148a4.07 4.07 0 0 1 .87-.316c.337-.09.695-.134 1.074-.134.818 0 1.416.186 1.799.555.379.37.57.932.57 1.688v2.223zm-2.852 1.067c.231 0 .47-.042.72-.126a1.56 1.56 0 0 0 .646-.44c.098-.112.17-.238.21-.38.042-.147.063-.322.063-.527v-.254a5.78 5.78 0 0 0-.645-.112 5.3 5.3 0 0 0-.66-.042c-.47 0-.815.092-1.043.28-.225.19-.334.456-.334.805 0 .33.084.576.259.744.168.175.415.26.785.26zm5.646.77a.37.37 0 0 1-.26-.064c-.042-.035-.084-.119-.119-.238l-1.33-4.378c-.034-.126-.05-.21-.05-.254 0-.098.05-.154.148-.154h.534c.105 0 .176.014.217.042.042.028.077.112.112.231l.952 3.746.883-3.746a.42.42 0 0 1 .105-.231c.042-.028.12-.042.224-.042h.436c.105 0 .183.014.224.042.042.028.077.119.105.231l.893 3.795.981-3.795c.035-.126.077-.21.113-.231a.42.42 0 0 1 .216-.042h.506c.098 0 .154.05.154.154 0 .028-.007.056-.014.091a.931.931 0 0 1-.042.17L12.87 12.12c-.035.126-.077.21-.12.238a.36.36 0 0 1-.258.064h-.471c-.105 0-.176-.014-.224-.049-.043-.028-.077-.112-.105-.224l-.878-3.655-.87 3.648c-.029.119-.063.203-.106.231-.042.028-.126.049-.224.049h-.47zm9.038.21c-.365 0-.73-.042-1.088-.126-.358-.085-.638-.175-.828-.28-.119-.063-.197-.133-.225-.197a.5.5 0 0 1-.042-.196v-.358c0-.147.056-.218.161-.218a.4.4 0 0 1 .126.021l.161.07a3.5 3.5 0 0 0 .708.224c.259.056.51.084.773.084.408 0 .726-.07.946-.21.22-.14.337-.345.337-.604a.57.57 0 0 0-.155-.414c-.105-.112-.3-.21-.583-.302l-.837-.26c-.421-.133-.732-.33-.926-.59-.196-.253-.296-.54-.296-.848 0-.245.056-.464.161-.653.105-.19.246-.357.422-.491.175-.14.373-.245.604-.322.231-.077.47-.112.73-.112.126 0 .26.007.387.028.133.02.253.049.38.077.12.035.231.07.337.112.105.042.183.084.231.126.07.042.119.084.147.133a.42.42 0 0 1 .042.196v.33c0 .148-.056.224-.161.224a.73.73 0 0 1-.267-.077 3.2 3.2 0 0 0-1.341-.274c-.372 0-.667.056-.87.175-.203.12-.308.302-.308.562 0 .175.063.33.19.456.126.126.358.252.687.365l.82.26c.414.133.715.316.897.548.183.23.274.498.274.793 0 .252-.05.478-.155.673a1.5 1.5 0 0 1-.435.506 1.94 1.94 0 0 1-.66.323c-.26.077-.534.112-.836.112z"
        transform="translate(1, 5)"
        fill="#FF9900"
      />
    </svg>
  );
}

function AnthropicMiniIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.508-4.065H5.248L3.727 20H0L6.569 3.52zm2.327 9.645l-2.166-5.837-2.166 5.837h4.332z"
        transform="translate(0, 1)"
      />
    </svg>
  );
}

const BRAND_ICONS: Record<string, ReactNode> = {
  slack: <SlackMiniIcon />,
  google: <GoogleMiniIcon />,
  whatsapp: <WhatsAppMiniIcon />,
  aws: <AwsMiniIcon />,
  anthropic: <AnthropicMiniIcon />,
};

/** Example prompts shown before the yellow finish card. */
function ExamplePrompts({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1500);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="ob-animate-in" style={{ marginBottom: 12 }}>
      <div className="ob-msg-label ob-msg-label-sketch" style={{ marginBottom: 6 }}>
        <SparkAvatar size={24} />
        SKETCH
      </div>
      <div className="ob-msg-body ob-msg-body-sketch" style={{ marginBottom: 8 }}>
        Here are some things to try:
      </div>
      <div className="ob-prompts">
        <div className="ob-prompt-item">→ "Summarize what happened across the company this week."</div>
        <div className="ob-prompt-item">→ "Show deals stuck in negotiation 2+ weeks."</div>
        <div className="ob-prompt-item">→ "Monitor competitor blogs. Alert me when they publish."</div>
      </div>
    </div>
  );
}

export function OnboardingChat() {
  const chatRef = useRef<HTMLDivElement>(null);
  const scrollLockRef = useRef(false);
  const scrollLockTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const userScrollingRef = useRef(false);
  const userScrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastStepRef = useRef(0);

  const {
    messages,
    activeWidget,
    state,
    startFlow,
    handleAuthSelect,
    handleConnComplete,
    handleWorkspaceComplete,
    handleWhatsAppConnect,
    handleWhatsAppConnected,
    handleWhatsAppSkip,
    handleApiKeyValidated,
    handleExamplePromptsDone,
    handleFinishCta,
    handleStepClick,
  } = useOnboardingFlow();

  // Start flow — guard against StrictMode double-invoke
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startFlow();
  }, [startFlow]);

  // Detect user scrolling vs programmatic
  const handleUserScroll = useCallback(() => {
    userScrollingRef.current = true;
    clearTimeout(userScrollTimerRef.current);
    userScrollTimerRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, 150);
  }, []);

  /**
   * Step-anchored auto-scroll:
   * When a new step divider appears, scroll it to ~20px from the top of the chat viewport.
   * Then suppress scroll-to-bottom for 6s so content loads below the anchor.
   * Normal messages still scroll to bottom when no lock is active.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages and activeWidget intentionally trigger scroll-to-bottom
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    if (userScrollingRef.current) return;

    // Check if a new step divider was added
    const currentStep = state.currentStep;
    if (currentStep > lastStepRef.current && currentStep > 0) {
      lastStepRef.current = currentStep;

      // Find the divider for this step and scroll it to the top
      requestAnimationFrame(() => {
        const divider = el.querySelector(`[data-step="${currentStep}"]`);
        if (divider) {
          const dividerTop = (divider as HTMLElement).offsetTop;
          el.scrollTo({ top: dividerTop - 20, behavior: "smooth" });

          // Lock scroll for 6 seconds
          scrollLockRef.current = true;
          clearTimeout(scrollLockTimerRef.current);
          scrollLockTimerRef.current = setTimeout(() => {
            scrollLockRef.current = false;
          }, 6000);
        }
      });
      return;
    }

    // Normal scroll-to-bottom (unless locked)
    if (!scrollLockRef.current) {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
  }, [messages, activeWidget, state.currentStep]);

  const renderMessage = (msg: ChatMessage) => {
    switch (msg.kind) {
      case "sketch-message":
        return <SketchMessage key={msg.id} text={msg.text || ""} step={msg.step} />;
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
      case "workspace-card": {
        const props = msg.widgetProps as {
          authMethod: "slack" | "google";
          data: { name: string; members: number; channels: number; email?: string; role?: string };
          isAdmin: boolean;
        };
        return (
          <WorkspaceCard
            key={msg.id}
            authMethod={props.authMethod}
            data={props.data}
            isAdmin={props.isAdmin}
            onComplete={handleWorkspaceComplete}
          />
        );
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
        const props = activeWidget.widgetProps as { authMethod: "slack" | "google" };
        return <ConnCard authMethod={props.authMethod} onComplete={handleConnComplete} />;
      }
      case "workspace-card": {
        const props = activeWidget.widgetProps as {
          authMethod: "slack" | "google";
          data: { name: string; members: number; channels: number; email?: string; role?: string };
          isAdmin: boolean;
        };
        return (
          <WorkspaceCard
            authMethod={props.authMethod}
            data={props.data}
            isAdmin={props.isAdmin}
            onComplete={handleWorkspaceComplete}
          />
        );
      }
      case "whatsapp-picker": {
        const canSkip = (activeWidget.widgetProps?.canSkip as boolean) ?? true;
        return <WhatsAppPicker canSkip={canSkip} onConnect={handleWhatsAppConnect} onSkip={handleWhatsAppSkip} />;
      }
      case "qr-card":
        return <QRCard onConnected={handleWhatsAppConnected} demo />;
      case "api-key-input":
        return <ApiKeyInput onValidated={handleApiKeyValidated} />;
      case "example-prompts":
        return <ExamplePrompts onDone={handleExamplePromptsDone} />;
      case "yellow-finish":
        return (
          <div className="ob-animate-finish" style={{ marginBottom: 12 }} data-step={3}>
            <YellowFinish authMethod={state.authMethod || "slack"} onCta={handleFinishCta} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="onboarding-root">
      <div className="ob-container">
        {/* Header */}
        <div className="ob-header">
          <div className="ob-header-left">
            <SketchIcon size={30} />
            <span className="ob-header-logo">sketch.</span>
          </div>
          <span className="ob-header-setup">SETUP</span>
        </div>

        {/* Step indicator */}
        <StepTrack currentStep={state.currentStep} maxReached={state.maxReached} onStepClick={handleStepClick} />

        {/* Chat area */}
        <div className="ob-chat" ref={chatRef} onScroll={handleUserScroll}>
          {messages.map(renderMessage)}
          {renderActiveWidget()}
          <div className="ob-bottom-spacer" />
        </div>
      </div>
    </div>
  );
}
