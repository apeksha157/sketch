import { useCallback, useRef, useState } from "react";
import type { AuthMethod, ChatMessage, ErrorType, QueueItem } from "./types";
import { getMockDetectionResult } from "./use-mock-detection";

let msgId = 0;
function nextId() {
  return `msg-${++msgId}`;
}

interface MemberState {
  authMethod: AuthMethod | null;
  whatsappNumber: string | null;
  completed: boolean;
  errorState: ErrorType | "no-workspace" | null;
  userName: string | null;
  adminEmail: string | null;
}

const REDIRECT_TARGET = "/home";

/** Member onboarding flow: auth → detection → (Slack: redirect) | (Google: ask WhatsApp → redirect). */
export function useMemberFlow() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeWidget, setActiveWidget] = useState<ChatMessage | null>(null);
  const [state, setState] = useState<MemberState>({
    authMethod: null,
    whatsappNumber: null,
    completed: false,
    errorState: null,
    userName: null,
    adminEmail: null,
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
          // Not used in the member flow but kept for queue type compatibility
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

  const dismissWidget = useCallback(() => {
    setActiveWidget(null);
    processQueue();
  }, [processQueue]);

  // ── Step 0: Greeting + sign in ──

  const startFlow = useCallback(() => {
    msgId = 0;
    enqueue([
      { type: "sketch-message", text: "Hey! Your team's already on me — let's get you in.", step: 0 },
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

      const label = method === "slack" ? "Sign in with Slack" : "Sign in with Google";

      // Peek detection so error flows skip the success animation
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

  const handleConnComplete = useCallback(() => {
    const method = state.authMethod || "slack";
    const detection = getMockDetectionResult(method);

    // Error: not a company email
    if (detection && !detection.isCompanyEmail) {
      setActiveWidget(null);
      setState((prev) => ({ ...prev, errorState: "generic-email" }));
      enqueue([
        { type: "delay", ms: 500 },
        {
          type: "sketch-message",
          text: "Sketch is built for teams — I couldn't find a workspace for that email. Try again with your work email.",
          step: 0,
          danger: true,
        },
        { type: "delay", ms: 400 },
        { type: "widget", widgetType: "error-state", step: 0, props: { errorType: "generic-email" } },
      ]);
      return;
    }

    // Already has an account → log in
    if (detection?.accountExists) {
      setActiveWidget(null);
      const name = detection.userName || "there";
      setState((prev) => ({ ...prev, errorState: "already-registered", userName: name }));
      enqueue([
        { type: "delay", ms: 500 },
        {
          type: "sketch-message",
          text: `Hey ${name}, looks like you already have an account — head to login to get back in.`,
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

    // Freeze conn-card confirmation into history (success or unknown-detection paths)
    appendMessage({
      id: nextId(),
      kind: "widget",
      step: 0,
      widgetType: "conn-card",
      widgetProps: { authMethod: method, frozen: true },
    });
    setActiveWidget(null);

    // Workspace exists but admin not ready
    if (detection?.workspaceExists && !detection.workspaceReady) {
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

    // No workspace at all → wrong route, soft-redirect to admin onboarding
    if (detection && !detection.workspaceExists) {
      setState((prev) => ({ ...prev, errorState: "no-workspace" }));
      enqueue([
        { type: "delay", ms: 500 },
        {
          type: "sketch-message",
          text: "Looks like your team isn't on Sketch yet — taking you to set up.",
          step: 0,
        },
        { type: "delay", ms: 1200 },
      ]);
      window.setTimeout(() => {
        window.location.href = "/onboarding";
      }, 1800);
      return;
    }

    // Member success path — branch on auth method
    if (method === "slack") {
      setState((prev) => ({ ...prev, completed: true }));
      enqueue([
        { type: "delay", ms: 500 },
        {
          type: "sketch-message",
          text: "All set — taking you home.",
          step: 0,
        },
        { type: "delay", ms: 1500 },
      ]);
      window.setTimeout(() => {
        window.location.href = REDIRECT_TARGET;
      }, 2200);
      return;
    }

    // Google path → ask for WhatsApp number
    enqueue([
      { type: "delay", ms: 500 },
      {
        type: "sketch-message",
        text: "One last thing — what's your WhatsApp number? So your team can reach you on me.",
        step: 0,
      },
      { type: "delay", ms: 300 },
      { type: "widget", widgetType: "whatsapp-number-input", step: 0 },
    ]);
  }, [appendMessage, enqueue, state.authMethod]);

  /** Google branch: WhatsApp number submitted → redirect. */
  const handleWhatsAppNumberSubmit = useCallback(
    (fullNumber: string) => {
      setState((prev) => ({ ...prev, whatsappNumber: fullNumber, completed: true }));
      setActiveWidget(null);
      enqueue([
        { type: "user-message", text: fullNumber, step: 0 },
        { type: "delay", ms: 500 },
        {
          type: "sketch-message",
          text: "All set — taking you home.",
          step: 0,
        },
        { type: "delay", ms: 1500 },
      ]);
      window.setTimeout(() => {
        window.location.href = REDIRECT_TARGET;
      }, 2200);
    },
    [enqueue],
  );

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

  return {
    messages,
    activeWidget,
    state,
    startFlow,
    handleAuthSelect,
    handleConnComplete,
    handleWhatsAppNumberSubmit,
    handleRetryAuth,
    handleGoToLogin,
    dismissWidget,
  };
}
