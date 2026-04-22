import { useCallback, useRef, useState } from "react";
import type { ApiProvider, AuthMethod, ChatMessage, OnboardingState, QueueItem } from "./types";
import { MOCK_WORKSPACE, getMockDetectionResult } from "./use-mock-detection";

let msgId = 0;
function nextId() {
  return `msg-${++msgId}`;
}

/** Trial intro block shown after workspace detection — trial context, sublinks, and opt-in button. */
function buildTrialIntro(): QueueItem[] {
  return [
    { type: "delay", ms: 700 },
    { type: "sketch-message", text: "Quick heads up before I set everything up.", step: 1 },
    { type: "delay", ms: 500 },
    { type: "sketch-message", text: "[[30 days free — no card needed.]]", step: 1 },
    { type: "delay", ms: 500 },
    {
      type: "sketch-message",
      text: "After that, you're on our Basic plan — $99/mo and 10,000 AI credits every month.",
      step: 1,
    },
    { type: "delay", ms: 600 },
    { type: "sketch-message", text: "{Curious how credits work?|#}", step: 1, dim: true },
    { type: "sketch-message", text: "{Want to self-host instead? It's free on GitHub|#}", step: 1, dim: true },
    { type: "delay", ms: 500 },
    { type: "widget", widgetType: "trial-opt-in", step: 1 },
  ];
}

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
    showStepTrack: false,
    errorState: null,
    userName: null,
    adminEmail: null,
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
          appendMessage({
            id: nextId(),
            kind: "sketch-message",
            step: item.step,
            text: item.text,
            dim: item.dim,
            danger: item.danger,
            highlight: item.highlight,
          });
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
      { type: "divider", label: "Account", step: 0 },
      { type: "sketch-message", text: "Hey! I'm Sketch — your new AI coworker.", step: 0 },
      { type: "delay", ms: 1000 },
      { type: "sketch-message", text: "Let's get you set up. Takes about 2 minutes.", step: 0 },
      { type: "delay", ms: 800 },
      { type: "sketch-message", text: "How would you like to sign in?", step: 0 },
      { type: "delay", ms: 500 },
      { type: "widget", widgetType: "auth-picker", step: 0 },
    ]);
  }, [enqueue]);

  const handleAuthSelect = useCallback(
    (method: AuthMethod) => {
      setState((prev) => ({ ...prev, authMethod: method }));
      setActiveWidget(null);

      const label = method === "slack" ? "Continue with Slack" : "Sign in with Google";

      // Peek at detection to skip success animation for error flows
      const detection = getMockDetectionResult(method);
      const willError = detection && (!detection.isCompanyEmail || detection.accountExists);

      enqueue([
        { type: "user-message", text: label, step: 0, icon: method },
        { type: "delay", ms: 500 },
        {
          type: "widget",
          widgetType: "conn-card",
          step: 0,
          props: { authMethod: method, skipSuccess: !!willError },
        },
      ]);
    },
    [enqueue],
  );

  /** Called by ConnCard after its loading → success transition. Runs detection checks. */
  const handleConnComplete = useCallback(() => {
    const method = state.authMethod || "slack";

    // Run detection first (mock layer in dev, real API in production)
    const detection = getMockDetectionResult(method);

    // For error states, don't show the "connected" success — go straight to the error
    if (detection && !detection.isCompanyEmail) {
      setActiveWidget(null);
      setState((prev) => ({ ...prev, errorState: "generic-email" }));
      enqueue([
        { type: "delay", ms: 500 },
        {
          type: "sketch-message",
          text: "Sketch is built for teams — I couldn't find a workspace for that email. Try again with your work email to get started.",
          step: 0,
          danger: true,
        },
        { type: "delay", ms: 400 },
        { type: "widget", widgetType: "error-state", step: 0, props: { errorType: "generic-email" } },
      ]);
      return;
    }

    // Already registered — skip success confirmation, go straight to greeting
    if (detection?.accountExists) {
      setActiveWidget(null);
      const name = detection.userName || "there";
      setState((prev) => ({ ...prev, errorState: "already-registered", userName: name }));
      enqueue([
        { type: "delay", ms: 500 },
        {
          type: "sketch-message",
          text: `Hey ${name}, good to see you again! Looks like you already have an account — head over to login to get back in.`,
          step: 0,
        },
        { type: "delay", ms: 400 },
        {
          type: "widget",
          widgetType: "error-state",
          step: 0,
          props: { errorType: "already-registered", name },
        },
      ]);
      return;
    }

    // Freeze the confirmation into message history (only for non-error flows)
    appendMessage({
      id: nextId(),
      kind: "widget",
      step: 0,
      widgetType: "conn-card",
      widgetProps: { authMethod: method, frozen: true },
    });
    setActiveWidget(null);

    if (detection) {
      // ── Workspace exists but admin not ready ──
      if (detection.workspaceExists && !detection.workspaceReady) {
        const name = detection.userName || "there";
        const adminEmail = detection.adminEmail || "your admin";
        setState((prev) => ({
          ...prev,
          errorState: "workspace-not-ready",
          userName: name,
          adminEmail,
        }));
        enqueue([
          { type: "delay", ms: 500 },
          {
            type: "sketch-message",
            text: `I'm almost ready for you, ${name} — I just need ##${adminEmail}## to finish setting me up first. Check back soon!`,
            step: 0,
          },
        ]);
        return;
      }

      // ── Member flow: workspace exists, ready, no account ──
      if (detection.workspaceExists && detection.workspaceReady && !detection.accountExists) {
        setState((prev) => ({
          ...prev,
          isAdmin: false,
          completed: true,
        }));
        enqueue([
          { type: "delay", ms: 500 },
          { type: "sketch-message", text: "Your team is already on Sketch.", step: 0 },
          { type: "delay", ms: 600 },
          {
            type: "widget",
            widgetType: "yellow-finish",
            step: 0,
            props: { isMember: true },
          },
        ]);
        return;
      }

      // ── Admin flow: no workspace exists ──
      if (!detection.workspaceExists) {
        const workspace = method === "slack" ? MOCK_WORKSPACE.slack : MOCK_WORKSPACE.google;
        setState((prev) => ({
          ...prev,
          isAdmin: true,
          workspace,
          showStepTrack: true,
          currentStep: 1,
          maxReached: 1,
        }));
        enqueue([
          { type: "delay", ms: 500 },
          { type: "action", action: "set-step", step: 1 },
          { type: "divider", label: "Workspace", step: 1 },
          {
            type: "sketch-message",
            text: `Got it, I can see your whole team at ${workspace.name}. Two more steps and I'll be ready for them.`,
            step: 1,
          },
          ...buildTrialIntro(),
        ]);
        return;
      }
    }

    // Fallback: no mock, no detection — default to admin flow with demo data
    const workspace = method === "slack" ? MOCK_WORKSPACE.slack : MOCK_WORKSPACE.google;
    setState((prev) => ({
      ...prev,
      workspace,
      isAdmin: true,
      showStepTrack: true,
      currentStep: 1,
      maxReached: 1,
    }));
    enqueue([
      { type: "delay", ms: 500 },
      { type: "action", action: "set-step", step: 1 },
      { type: "divider", label: "Workspace", step: 1 },
      {
        type: "sketch-message",
        text: `Got it, I can see your whole team at ${workspace.name}. Two more steps and I'll be ready for them.`,
        step: 1,
      },
      ...buildTrialIntro(),
    ]);
  }, [appendMessage, enqueue, state.authMethod]);

  // ── Step 1: Workspace discovery complete ──

  /** Called when the user opts into the trial — kicks off provisioning. */
  const handleTrialOptIn = useCallback(() => {
    const workspace = state.workspace;
    setActiveWidget(null);
    enqueue([
      { type: "user-message", text: "Start trial", step: 1 },
      { type: "delay", ms: 600 },
      {
        type: "widget",
        widgetType: "provisioning-card",
        step: 1,
        props: {
          companyName: workspace?.name ?? "your company",
          email: workspace?.email ?? "your registered email",
        },
      },
    ]);
  }, [enqueue, state.workspace]);

  /** Called when provisioning card completes — continue to platforms. */
  const handleProvisioningComplete = useCallback(() => {
    // Freeze the provisioning card into message history
    const workspace = state.workspace;
    appendMessage({
      id: nextId(),
      kind: "widget",
      step: 1,
      widgetType: "provisioning-card",
      widgetProps: {
        companyName: workspace?.name ?? "your company",
        email: workspace?.email ?? "your registered email",
        frozen: true,
      },
    });
    setActiveWidget(null);
    enqueue([
      { type: "delay", ms: 600 },
      {
        type: "sketch-message",
        text:
          state.authMethod === "slack"
            ? "One more way to reach me — connect WhatsApp and your team can message me there too."
            : "This is how your team will reach me — let's get WhatsApp connected.",
        step: 1,
      },
      { type: "delay", ms: 700 },
      { type: "widget", widgetType: "section-continue", step: 1, props: { label: "Go to Platforms" } },
    ]);
  }, [appendMessage, enqueue, state.authMethod, state.workspace]);

  // ── Step 1 → 2: User clicks "Go to Platforms" ──

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
            ? "One more way to reach me — connect WhatsApp and your team can message me there too."
            : "This is how your team will reach me — let's get WhatsApp connected.",
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
      // Freeze WhatsApp confirmation into message history
      appendMessage({
        id: nextId(),
        kind: "widget",
        step: 2,
        widgetType: "conn-card",
        widgetProps: { authMethod: "whatsapp", phone, frozen: true },
      });
      setActiveWidget(null);
      enqueue([
        { type: "delay", ms: 600 },
        {
          type: "sketch-message",
          text: "WhatsApp is all set. Last step — let's get my brain connected.",
          step: 2,
        },
        { type: "delay", ms: 500 },
        { type: "widget", widgetType: "section-continue", step: 2, props: { label: "Continue to API Key" } },
      ]);
    },
    [appendMessage, enqueue],
  );

  const handlePlatformsContinue = useCallback(() => {
    setActiveWidget(null);
    enqueue([
      { type: "user-message", text: "Continue to API Key", step: 2 },
      { type: "delay", ms: 400 },
      { type: "action", action: "set-step", step: 3 },
      { type: "divider", label: "API Key", step: 3 },
      {
        type: "sketch-message",
        text: "Almost done — I just need to know which AI provider to run on.",
        step: 3,
      },
      {
        type: "sketch-message",
        text: "I run on Claude under the hood — it's why I'm good at reading between the lines.",
        step: 3,
        dim: true,
      },
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
      {
        type: "sketch-message",
        text: "Almost done — I just need to know which AI provider to run on.",
        step: 3,
      },
      {
        type: "sketch-message",
        text: "I run on Claude under the hood — it's why I'm good at reading between the lines.",
        step: 3,
        dim: true,
      },
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
        { type: "sketch-message", text: "Perfect, that's everything. Let's go.", step: 3 },
        { type: "delay", ms: 800 },
        { type: "action", action: "set-step", step: 4 },
        { type: "widget", widgetType: "yellow-finish", step: 4 },
      ]);
      setState((prev) => ({ ...prev, completed: true }));
    },
    [enqueue],
  );

  // ── Completion ──

  const handleFinishCta = useCallback(() => {
    // In production: deep link to Slack DM or WhatsApp conversation
  }, []);

  const handleDashboard = useCallback(() => {
    window.location.href = "/dashboard";
  }, []);

  // ── Error state handlers ──

  const handleRetryAuth = useCallback(() => {
    setState((prev) => ({ ...prev, errorState: null }));
    setActiveWidget(null);
    enqueue([
      { type: "delay", ms: 300 },
      { type: "sketch-message", text: "How would you like to sign in?", step: 0 },
      { type: "delay", ms: 400 },
      { type: "widget", widgetType: "auth-picker", step: 0 },
    ]);
  }, [enqueue]);

  const handleGoToLogin = useCallback(() => {
    window.location.href = "/login";
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
    handleTrialOptIn,
    handleProvisioningComplete,
    handleWorkspaceContinue,
    handlePlatformsContinue,
    handleWhatsAppConnect,
    handleWhatsAppConnected,
    handleWhatsAppSkip,
    handleApiKeyValidated,
    handleFinishCta,
    handleDashboard,
    handleRetryAuth,
    handleGoToLogin,
    handleStepClick,
  };
}
