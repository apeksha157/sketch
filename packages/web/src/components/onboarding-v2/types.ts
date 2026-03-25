/** Message queue item types for the conversational onboarding flow. */

export type AuthMethod = "slack" | "google";
export type ApiProvider = "bedrock" | "anthropic";

/** A visible message in the chat. */
export interface ChatMessage {
  id: string;
  kind: "sketch-message" | "user-message" | "divider" | "widget";
  step: number;
  text?: string;
  /** For dividers */
  label?: string;
  /** For widgets rendered inline in the chat history (after user interacts) */
  widgetType?: WidgetType;
  /** Props passed to the widget */
  widgetProps?: Record<string, unknown>;
}

export type WidgetType =
  | "auth-picker"
  | "conn-card"
  | "workspace-card"
  | "whatsapp-picker"
  | "qr-card"
  | "api-key-input"
  | "yellow-finish"
  | "example-prompts"
  | "section-continue"
  | "loading";

/** An instruction in the message queue (not yet processed). */
export type QueueItem =
  | { type: "sketch-message"; text: string; step: number }
  | { type: "user-message"; text: string; step: number; icon?: string }
  | { type: "divider"; label: string; step: number }
  | { type: "delay"; ms: number }
  | { type: "widget"; widgetType: WidgetType; step: number; props?: Record<string, unknown> }
  | { type: "action"; action: "set-step"; step: number };

export interface OnboardingState {
  authMethod: AuthMethod | null;
  isAdmin: boolean;
  whatsappConnected: boolean;
  currentStep: number;
  maxReached: number;
  apiProvider: ApiProvider | null;
  apiKeyValidated: boolean;
  completed: boolean;
  workspace: {
    name: string;
    members: number;
    channels: number;
    email?: string;
    role?: string;
    adminName?: string;
  } | null;
}

export const STEP_LABELS = ["Sign In", "Workspace", "Platforms", "API Key"] as const;
