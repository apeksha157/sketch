/** Message queue item types for the conversational onboarding flow. */

export type AuthMethod = "slack" | "google";
export type ApiProvider = "bedrock" | "anthropic" | "max";
export type UserRole = "admin" | "member";
export type ErrorType = "generic-email" | "already-registered" | "workspace-not-ready";

/** Result of post-auth detection checks. */
export interface DetectionResult {
  isCompanyEmail: boolean;
  workspaceExists: boolean;
  accountExists: boolean;
  workspaceReady: boolean;
  role: UserRole | null;
  userName?: string;
  adminEmail?: string;
}

/** A visible message in the chat. */
export interface ChatMessage {
  id: string;
  kind: "sketch-message" | "user-message" | "divider" | "widget";
  step: number;
  text?: string;
  /** When true, renders as smaller dimmed tertiary copy */
  dim?: boolean;
  /** When set, renders in danger color */
  danger?: boolean;
  /** When true, marks the message with a subtle yellow accent. */
  highlight?: boolean;
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
  | "trial-opt-in"
  | "error-state"
  | "provisioning-card"
  | "loading";

/** An instruction in the message queue (not yet processed). */
export type QueueItem =
  | { type: "sketch-message"; text: string; step: number; dim?: boolean; danger?: boolean; highlight?: boolean }
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
  /** Tracks whether step track should be visible (only after role is confirmed as admin). */
  showStepTrack: boolean;
  /** Error/edge state detected after auth. */
  errorState: ErrorType | null;
  /** Detected user name from auth. */
  userName: string | null;
  /** Admin email for holding screen. */
  adminEmail: string | null;
  workspace: {
    name: string;
    members: number;
    channels: number;
    email?: string;
    role?: string;
    adminName?: string;
  } | null;
}

export const STEP_LABELS = ["Account", "Workspace", "Platforms", "API Key", "Ready"] as const;
