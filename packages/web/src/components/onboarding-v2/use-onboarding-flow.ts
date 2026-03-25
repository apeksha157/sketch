import { useCallback, useRef, useState } from "react";
import type { ApiProvider, AuthMethod, ChatMessage, OnboardingState, QueueItem } from "./types";

let msgId = 0;
function nextId() {
  return `msg-${++msgId}`;
}

const DEMO_WORKSPACE_SLACK = {
  name: "Canvas AI",
  members: 4,
  channels: 12,
  email: "",
  role: "Admin",
};

const DEMO_WORKSPACE_GOOGLE = {
  name: "Canvas AI",
  members: 1,
  channels: 0,
  email: "you@canvas.ai",
  role: "Admin",
};

export function useOnboardingFlow() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeWidget, setActiveWidget] = useState<ChatMessage | null>(null);
  const [state, setState] = useState<OnboardingState>({
    authMethod: null,
    isAdmin: true,
    whatsappConnected: false,
    currentStep: 0,
    maxReached: 0,
    apiProvider: null,
    apiKeyValidated: false,
    completed: false,
    workspace: null,
  });

  const queueRef = useRef<QueueItem[]>([]);
  const processingRef = useRef(false);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift();
      if (!item) break;

      switch (item.type) {
        case "sketch-message":
          appendMessage({ id: nextId(), kind: "sketch-message", step: item.step, text: item.text });
          break;
        case "user-message":
          appendMessage({
            id: nextId(),
            kind: "user-message",
            step: item.step,
            text: item.text,
            widgetProps: item.icon ? { icon: item.icon } : undefined,
          });
          break;
        case "divider":
          appendMessage({ id: nextId(), kind: "divider", step: item.step, label: item.label });
          break;
        case "delay":
          await new Promise((r) => setTimeout(r, item.ms));
          break;
        case "widget": {
          const widget: ChatMessage = {
            id: nextId(),
            kind: "widget",
            step: item.step,
            widgetType: item.widgetType,
            widgetProps: item.props,
          };
          setActiveWidget(widget);
          processingRef.current = false;
          return;
        }
        case "action":
          if (item.action === "set-step") {
            setState((prev) => ({
              ...prev,
              currentStep: item.step,
              maxReached: Math.max(prev.maxReached, item.step),
            }));
          }
          break;
      }
    }

    processingRef.current = false;
  }, [appendMessage]);

  const enqueue = useCallback(
    (items: QueueItem[]) => {
      queueRef.current.push(...items);
      processQueue();
    },
    [processQueue],
  );

  /** Dismiss active widget and continue processing */
  const dismissWidget = useCallback(() => {
    setActiveWidget(null);
    processQueue();
  }, [processQueue]);

  // ── Step 0: Sign in ──

  const startFlow = useCallback(() => {
    msgId = 0;
    enqueue([
      { type: "sketch-message", text: "Hey! I'm Sketch — your new AI coworker.", step: 0 },
      { type: "delay", ms: 1000 },
      { type: "sketch-message", text: "Let's get you set up. Takes about 2 minutes.", step: 0 },
      { type: "delay", ms: 1000 },
      { type: "sketch-message", text: "How would you like to sign in?", step: 0 },
      { type: "delay", ms: 500 },
      { type: "widget", widgetType: "auth-picker", step: 0 },
    ]);
  }, [enqueue]);

  const handleAuthSelect = useCallback(
    (method: AuthMethod) => {
      setState((prev) => ({ ...prev, authMethod: method }));
      setActiveWidget(null);

      const label = method === "slack" ? "Add to Slack" : "Sign in with Google";

      enqueue([
        { type: "user-message", text: label, step: 0, icon: method },
        { type: "delay", ms: 500 },
        {
          type: "widget",
          widgetType: "conn-card",
          step: 0,
          props: { authMethod: method },
        },
      ]);
    },
    [enqueue],
  );

  /** Called by ConnCard after its 2s loading → success transition. */
  const handleConnComplete = useCallback(() => {
    const method = state.authMethod || "slack";
    const workspace = method === "slack" ? DEMO_WORKSPACE_SLACK : DEMO_WORKSPACE_GOOGLE;

    setState((prev) => ({
      ...prev,
      workspace,
      isAdmin: true,
    }));

    setActiveWidget(null);
    enqueue([
      { type: "delay", ms: 500 },
      { type: "action", action: "set-step", step: 1 },
      { type: "divider", label: "Workspace", step: 1 },
      {
        type: "widget",
        widgetType: "workspace-card",
        step: 1,
        props: { authMethod: method, data: workspace, isAdmin: true },
      },
    ]);
  }, [enqueue, state.authMethod]);

  // ── Step 1: Workspace discovery complete ──

  const handleWorkspaceComplete = useCallback(() => {
    const method = state.authMethod;
    const isAdmin = state.isAdmin;
    const workspace = state.workspace;

    const confirmMsg = isAdmin
      ? "You're the admin. Teammates join with the same email domain."
      : `You're joining ${workspace?.name}.`;

    // Persist the completed workspace card as a frozen inline message before clearing it.
    appendMessage({
      id: nextId(),
      kind: "widget",
      step: 1,
      widgetType: "workspace-card",
      widgetProps: { authMethod: method, data: workspace, isAdmin, frozen: true },
    });

    setActiveWidget(null);
    enqueue([
      { type: "delay", ms: 900 },
      { type: "sketch-message", text: confirmMsg, step: 1 },
      { type: "delay", ms: 1200 },
      {
        type: "sketch-message",
        text:
          state.authMethod === "slack"
            ? "You can also reach me on WhatsApp — scan a code and you're set."
            : "Let's connect WhatsApp. That's where I'll live.",
        step: 1,
      },
      { type: "delay", ms: 700 },
      { type: "widget", widgetType: "section-continue", step: 1, props: { label: "Go to Platforms" } },
    ]);
  }, [appendMessage, enqueue, state.authMethod, state.isAdmin, state.workspace]);

  // ── Step 1 → 2: User clicks "Next: Channels" ──

  const handleWorkspaceContinue = useCallback(() => {
    const method = state.authMethod;
    setActiveWidget(null);
    enqueue([
      { type: "user-message", text: "Go to Platforms", step: 1 },
      { type: "action", action: "set-step", step: 2 },
      { type: "divider", label: "Platforms", step: 2 },
      {
        type: "sketch-message",
        text:
          method === "slack"
            ? "You can also reach me on WhatsApp — scan a code and you're set."
            : "Let's connect WhatsApp. That's where I'll live.",
        step: 2,
      },
      { type: "delay", ms: 400 },
      { type: "widget", widgetType: "whatsapp-picker", step: 2, props: { canSkip: method === "slack" } },
    ]);
  }, [enqueue, state.authMethod]);

  // ── Step 2: Channel connection ──

  const handleWhatsAppConnect = useCallback(() => {
    setActiveWidget(null);
    enqueue([
      { type: "user-message", text: "Connect WhatsApp", step: 2, icon: "whatsapp" },
      { type: "delay", ms: 400 },
      { type: "widget", widgetType: "qr-card", step: 2 },
    ]);
  }, [enqueue]);

  const handleWhatsAppConnected = useCallback(
    (phone: string) => {
      setState((prev) => ({ ...prev, whatsappConnected: true }));
      setActiveWidget(null);
      enqueue([
        { type: "delay", ms: 600 },
        {
          type: "sketch-message",
          text: `WhatsApp connected — ${phone}. I'll be there whenever your team needs me.`,
          step: 2,
        },
        { type: "delay", ms: 600 },
        { type: "widget", widgetType: "section-continue", step: 2, props: { label: "Continue to API Key" } },
      ]);
    },
    [enqueue],
  );

  const handlePlatformsContinue = useCallback(() => {
    setActiveWidget(null);
    enqueue([
      { type: "user-message", text: "Continue to API Key", step: 2 },
      { type: "delay", ms: 400 },
      { type: "action", action: "set-step", step: 3 },
      { type: "divider", label: "API Key", step: 3 },
      { type: "sketch-message", text: "Last step — connect your AI provider so I can power the brains.", step: 3 },
      { type: "delay", ms: 350 },
      { type: "widget", widgetType: "api-key-input", step: 3 },
    ]);
  }, [enqueue]);

  const handleWhatsAppSkip = useCallback(() => {
    setActiveWidget(null);
    enqueue([
      { type: "user-message", text: "Maybe later", step: 2 },
      { type: "delay", ms: 400 },
      { type: "sketch-message", text: "No worries. You can connect anytime from settings.", step: 2 },
      { type: "delay", ms: 1000 },
      { type: "action", action: "set-step", step: 3 },
      { type: "divider", label: "API Key", step: 3 },
      { type: "sketch-message", text: "Last step — connect your AI provider so I can power the brains.", step: 3 },
      { type: "delay", ms: 350 },
      { type: "widget", widgetType: "api-key-input", step: 3 },
    ]);
  }, [enqueue]);

  // ── Step 3: API key ──

  const handleApiKeyValidated = useCallback(
    (provider: ApiProvider) => {
      setState((prev) => ({ ...prev, apiProvider: provider, apiKeyValidated: true }));
      setActiveWidget(null);

      const providerLabel = provider === "bedrock" ? "AWS Bedrock" : "Anthropic";
      const iconKey = provider === "bedrock" ? "aws" : "anthropic";

      enqueue([
        { type: "user-message", text: `${providerLabel} connected ✓`, step: 3, icon: iconKey },
        { type: "delay", ms: 400 },
        { type: "sketch-message", text: "Verified. You're all set.", step: 3 },
        { type: "delay", ms: 1000 },
        { type: "widget", widgetType: "example-prompts", step: 3 },
      ]);
    },
    [enqueue],
  );

  // ── Completion ──

  const handleExamplePromptsDone = useCallback(() => {
    appendMessage({
      id: nextId(),
      kind: "widget",
      step: 3,
      widgetType: "example-prompts",
      widgetProps: { frozen: true },
    });
    setActiveWidget(null);
    enqueue([
      { type: "sketch-message", text: "Mention @Sketch in any channel, or DM me directly.", step: 3 },
      { type: "delay", ms: 500 },
      { type: "widget", widgetType: "yellow-finish", step: 3 },
    ]);
    setState((prev) => ({ ...prev, completed: true }));
  }, [appendMessage, enqueue]);

  const handleFinishCta = useCallback(() => {
    // In production: deep link to Slack DM or WhatsApp conversation
  }, []);

  // ── Scroll to step ──

  const handleStepClick = useCallback((step: number) => {
    const el = document.querySelector(`[data-step="${step}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return {
    messages,
    activeWidget,
    state,
    startFlow,
    handleAuthSelect,
    handleConnComplete,
    handleWorkspaceComplete,
    handleWorkspaceContinue,
    handlePlatformsContinue,
    handleWhatsAppConnect,
    handleWhatsAppConnected,
    handleWhatsAppSkip,
    handleApiKeyValidated,
    handleExamplePromptsDone,
    handleFinishCta,
    handleStepClick,
  };
}
