import { AutomationLockBanner } from "@/components/automations/lock-banner";
import {
  AUTOMATION_EDIT_LOCK_HEARTBEAT_INTERVAL_MS,
  AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
} from "@/components/automations/lock-banner";
import { AutomationLockHolderResponseDialog } from "@/components/automations/lock-holder-response-dialog";
import { AutomationLockStealDialog } from "@/components/automations/lock-steal-dialog";
import { AutomationShareDialog } from "@/components/automations/share-dialog";
import { ChatInput } from "@/components/sketch/chat-input";
import { SketchMessage, UserMessage } from "@/components/sketch/chat-message";
import {
  ChatThread,
  type ChatThreadInterruption,
  type ChatThreadMessage,
  type ChatThreadProgressItem,
  type ChatThreadTimelineEntry,
  questionBatchSignature,
} from "@/components/sketch/chat-thread";
import { WEB_CHAT_PROGRESS_MODES, useWebChatProgressSettings } from "@/hooks/use-web-chat-progress-settings";
import { mergeProgressMessageSnapshots, useWebChatReconciliation } from "@/hooks/use-web-chat-reconciliation";
import {
  ApiRequestError,
  type AutomationArtifact,
  type AutomationBuilderSaveRequest,
  type AutomationDefinition,
  type AutomationEditLockView,
  type AutomationRunRecord,
  type AutomationStepContent,
  type CanvasWebhookEndpoint,
  type ScheduledTaskConversationKind,
  type ScheduledTaskConversationLock,
  type ScheduledTaskConversationSummary,
  type ScheduledTaskConversationsResponse,
  type ScheduledTaskOriginChatMessage,
  type StepOutput,
  type WebChatConversationSummary,
  type WebChatQuestion,
  type WebChatQuestionAnswer,
  type WebChatQuestionBatch,
  type WebChatQuestionBatchAnswer,
  type WebChatQuestionOption,
  type WebChatStoredMessage,
  type WebChatUploadedAttachment,
  type WorkflowEdge,
  type WorkflowStep,
  type WorkflowTriggerConfig,
  api,
} from "@/lib/api";
import { getAutomationAuthoringSessionId } from "@/lib/automation-authoring-session";
import {
  AUTOMATION_ACTIVE_RUN_REFRESH_INTERVAL_MS,
  AUTOMATION_REFRESH_INTERVAL_MS,
  automationDefinitionQueryKey,
  invalidateAutomationQueries,
} from "@/lib/automation-refresh";
import { WEB_CHAT_CONVERSATIONS_QUERY_KEY } from "@/lib/web-chat-conversations";
import { useChat } from "@ai-sdk/react";
import {
  ArchiveIcon,
  ArrowClockwiseIcon,
  BellIcon,
  BellSlashIcon,
  BracketsCurlyIcon,
  BrainIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CircleIcon,
  CodeIcon,
  CopySimpleIcon,
  EnvelopeSimpleIcon,
  FunnelSimpleIcon,
  GitBranchIcon,
  GlobeHemisphereWestIcon,
  GoogleLogoIcon,
  type IconProps,
  LightningIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RobotIcon,
  ShareNetworkIcon,
  SidebarSimpleIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  TableIcon,
  TerminalWindowIcon,
  TrashIcon,
  WebhooksLogoIcon,
  WhatsappLogoIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@sketch/ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Textarea } from "@sketch/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sketch/ui/components/tooltip";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type AutomationExecutionMode,
  automationExecutionModeMetadata,
  recommendAutomationExecutionMode,
} from "@sketch/shared";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  type CSSProperties,
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { dashboardRoute, useDashboardAuth } from "./dashboard";

interface BuilderSearch {
  conversationId?: string;
  runId?: string;
}

const SAFE_AUTOMATION_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const BUILDER_MODE_SELECTION_MARKER = "[automation-setup-mode-selection]";

export function validateAutomationBuilderSearch(search: Record<string, unknown>): BuilderSearch {
  const conversationId = typeof search.conversationId === "string" ? search.conversationId.trim() : "";
  const runId = typeof search.runId === "string" ? search.runId.trim() : "";
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(runId && SAFE_AUTOMATION_RUN_ID.test(runId) ? { runId } : {}),
  };
}

function isPlaceholderDraft(automation: AutomationDefinition): boolean {
  return automation.isPlaceholderDraft === true;
}

interface DraftAutomation {
  title: string | null;
  description: string | null;
  prompt: string;
  scheduleType: AutomationDefinition["scheduleType"];
  scheduleValue: string;
  timezone: string;
  status: AutomationDefinition["status"];
  delivery: AutomationDefinition["delivery"];
  executionMode: AutomationDefinition["executionMode"];
  executionModeRecommendation: AutomationDefinition["executionModeRecommendation"];
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  stepContent: Record<string, AutomationStepContent>;
  revision: number;
}

interface ExecutionModeSelection {
  id: number;
  mode: AutomationExecutionMode;
}

type BuilderSourceContextMessage = Pick<ScheduledTaskOriginChatMessage, "id" | "text" | "createdAt">;

function sourceContextMessagesFromWebChat(messages: WebChatStoredMessage[]): BuilderSourceContextMessage[] {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) => {
      const text = message.parts
        .filter(
          (part): part is Extract<WebChatStoredMessage["parts"][number], { type: "text" }> => part.type === "text",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      return text ? [{ id: message.id, text, createdAt: message.createdAt ?? "" }] : [];
    })
    .slice(-4);
}

function sourceContextMessagesFromProvider(messages: ScheduledTaskOriginChatMessage[]): BuilderSourceContextMessage[] {
  return messages.filter((message) => message.role === "user" && message.text.trim()).slice(-4);
}

type UiStatus = "idle" | "running" | "success" | "failed" | "skipped";
export type AutomationRunLifecycleState = "pending" | "running" | "success" | "failure" | "aborted";

type RunLifecycleInput = {
  status?: string;
  type?: string;
  runType?: string;
  errorMessage?: string | null;
};

export function automationRunLifecycleState(
  run: RunLifecycleInput | null | undefined,
): AutomationRunLifecycleState | null {
  if (!run) return null;
  const status = run.status?.trim().toLowerCase();
  if (status === "pending" || status === "queued" || status === "starting") return "pending";
  if (status === "running" || status === "in_progress") return "running";
  if (status === "completed" || status === "success" || status === "succeeded") return "success";
  if (status === "aborted" || status === "cancelled" || status === "canceled") return "aborted";

  const persistedType = `${run.type ?? ""} ${run.runType ?? ""}`.toLowerCase();
  if (/\b(?:abort(?:ed|ion)?|cancel(?:led|ed)?|interrupt(?:ed|ion)?)\b/.test(persistedType)) return "aborted";
  if (status === "failed" || status === "failure" || status === "error") {
    const persistedError = run.errorMessage?.toLowerCase() ?? "";
    if (/\b(?:abort(?:ed|ion)?|cancel(?:led|ed)?|interrupt(?:ed|ion)?)\b/.test(persistedError)) return "aborted";
    return "failure";
  }
  return null;
}

function isTerminalRunLifecycleState(state: AutomationRunLifecycleState | null): boolean {
  return state === "success" || state === "failure" || state === "aborted";
}

function runStatusLabel(state: AutomationRunLifecycleState): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "failure":
      return "Failure";
    case "aborted":
      return "Aborted";
  }
}

type BuilderWebChatDataParts = {
  progress: {
    lines: string[];
    items?: ChatThreadProgressItem[];
  };
  file: {
    name: string;
    url: string;
    mediaType: string;
    sizeBytes?: number;
  };
  automation: AutomationArtifact;
  question: WebChatQuestion;
  "question-batch": WebChatQuestionBatch;
  "question-answer": WebChatQuestionAnswer;
  "question-batch-answer": WebChatQuestionBatchAnswer;
  interruption: ChatThreadInterruption;
};

type BuilderWebChatMetadata = {
  createdAt?: string;
};

type BuilderWebChatMessage = UIMessage<BuilderWebChatMetadata, BuilderWebChatDataParts> & {
  createdAt?: string | Date;
};

const builderButtonBaseClass =
  "h-8 rounded-[7px] text-[12px] font-medium shadow-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-accent/50";
const canvasToolbarButtonClass = cn(
  builderButtonBaseClass,
  "border-border/70 bg-card/90 px-2.5 text-foreground/80 backdrop-blur hover:bg-muted hover:text-foreground",
);
const canvasGhostButtonClass = cn(
  builderButtonBaseClass,
  "px-2 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
);
const canvasIconButtonClass =
  "size-8 shrink-0 rounded-[7px] text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-accent/50";
const canvasCompactIconButtonClass =
  "size-7 shrink-0 rounded-[8px] text-foreground/70 shadow-none transition-[color,background-color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/50";
const canvasPrimaryButtonClass =
  "h-8 rounded-[7px] bg-brand-accent px-2.5 text-[12px] font-medium text-[#161300] shadow-none transition-colors hover:bg-brand-accent/90 focus-visible:ring-2 focus-visible:ring-brand-accent/50";
/**
 * Single tray shell for every floating cluster in the builder toolbar (identity,
 * actions, panel toggles). One radius, one border, one height so the chrome reads
 * as one visual language instead of a pile of differently-styled pills.
 */
const builderTrayClass =
  "flex h-9 items-center rounded-[12px] border border-border/65 bg-card/95 shadow-[0_2px_10px_-4px_rgba(15,23,42,0.16)] backdrop-blur";

/**
 * Hover label for an icon-only control. Self-contained (bundles its own
 * TooltipProvider) so it can be dropped around any button without a root
 * provider, matching the pattern used elsewhere in the app.
 */
function IconTooltip({
  label,
  side = "bottom",
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={6} className="font-medium">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
const builderSidebarFrameClass =
  "absolute inset-y-0 z-40 flex h-full w-full max-w-none shrink-0 flex-col overflow-hidden bg-background text-foreground transition-[width,min-width,max-width,transform,border-color] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none lg:static lg:z-auto lg:h-auto lg:translate-x-0";
const builderSidebarContentClass =
  "flex h-full w-full min-w-0 flex-col overflow-hidden transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none";
/**
 * Shared responsive width for BOTH side drawers (chat + runs), so they always
 * stay equal. The width is a ratio of the viewport — `clamp(floor, vw, cap)` —
 * so the drawers grow on larger screens and hold a comfortable floor on smaller
 * ones. The floor keeps the chat transcript readable (~40 chars/line with the
 * message avatar in place); the cap stops either drawer from eating the canvas.
 */
const builderSidebarWidthClass = "lg:w-[clamp(340px,22vw,420px)] lg:min-w-[340px] lg:max-w-[420px]";
const builderInputClass =
  "h-10 rounded-[8px] border-input bg-background text-[13px] text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-brand-accent/55 focus-visible:ring-brand-accent/20";
const builderTextareaClass =
  "rounded-[8px] border-input bg-card text-[13px] leading-5 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-brand-accent/55 focus-visible:ring-brand-accent/20";
const builderReadOnlyInputClass = cn(
  builderInputClass,
  "cursor-default bg-muted/35 focus-visible:border-border focus-visible:ring-0",
);
const builderReadOnlyTextareaClass = cn(
  builderTextareaClass,
  "cursor-default bg-muted/35 focus-visible:border-border focus-visible:ring-0",
);
const flowEdgeStyle = {
  stroke: "var(--automation-builder-edge)",
  strokeWidth: 1.2,
  opacity: 0.84,
} satisfies CSSProperties;
const connectionLineStyle = {
  stroke: "var(--automation-builder-edge-active)",
  strokeWidth: 2,
  strokeDasharray: "5 5",
} satisfies CSSProperties;
export const automationBuilderRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/scheduled-tasks/$taskId/edit",
  validateSearch: validateAutomationBuilderSearch,
  component: AutomationBuilderPage,
});

function draftFromDefinition(automation: AutomationDefinition): DraftAutomation {
  const executionMode = automation.executionMode ?? "hybrid";
  const executionModeRecommendation =
    automation.executionModeRecommendation ??
    recommendAutomationExecutionMode(automation.steps, { legacy: automation.executionMode === undefined });
  return {
    title: automation.title,
    description: automation.description,
    prompt: automation.prompt,
    scheduleType: automation.scheduleType,
    scheduleValue: automation.scheduleValue,
    timezone: automation.timezone,
    status: automation.status,
    delivery: automation.delivery,
    executionMode,
    executionModeRecommendation,
    steps: automation.steps,
    edges: automation.edges,
    stepContent: automation.stepContent,
    revision: automation.revision,
  };
}

function saveRequestFromDraft(draft: DraftAutomation): AutomationBuilderSaveRequest {
  return {
    expectedRevision: draft.revision,
    title: draft.title,
    description: draft.description,
    prompt: draft.prompt,
    scheduleType: draft.scheduleType,
    scheduleValue: draft.scheduleValue,
    timezone: draft.timezone,
    status: draft.status,
    delivery: draft.delivery,
    executionMode: draft.executionMode,
    steps: draft.steps,
    edges: draft.edges,
    stepContent: draft.stepContent,
  };
}

type AutomationAuthoringLease = {
  clientSessionId: string;
  generation: number;
  holder: AutomationEditLockView;
};

type AutomationLeaseRequest = Pick<AutomationAuthoringLease, "clientSessionId" | "generation">;

function leaseRequest(lease: AutomationAuthoringLease): AutomationLeaseRequest {
  return { clientSessionId: lease.clientSessionId, generation: lease.generation };
}

function sameLease(left: AutomationLeaseRequest | null | undefined, right: AutomationLeaseRequest | null | undefined) {
  return Boolean(
    left && right && left.clientSessionId === right.clientSessionId && left.generation === right.generation,
  );
}

function isLeaseStaleError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.code === "LEASE_STALE";
}

function builderLoadErrorKind(error: unknown): "access" | "server" {
  if (error instanceof ApiRequestError) {
    if (error.status === 403 || error.status === 404 || error.code === "FORBIDDEN" || error.code === "NOT_FOUND") {
      return "access";
    }
  }
  return "server";
}

function BuilderLoadError({
  error,
  onRetry,
  onClose,
}: {
  error: unknown;
  onRetry: () => void;
  onClose: () => void;
}) {
  const kind = builderLoadErrorKind(error);
  const isAccessError = kind === "access";
  return (
    <main
      data-testid={`automation-builder-${kind}-error`}
      role="alert"
      className="flex min-h-[calc(100vh-3rem)] items-center justify-center bg-background px-6 text-foreground md:min-h-screen"
    >
      <div className="w-full max-w-md rounded-[10px] border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <XCircleIcon size={20} weight="fill" />
          </span>
          <div>
            <h1 className="text-sm font-semibold">
              {isAccessError ? "Automation unavailable" : "Unable to load automation"}
            </h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {isAccessError
                ? "This automation may have been deleted or you may not have access to it."
                : "Sketch could not load this automation. Try again or return to the automations list."}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="outline" className={canvasToolbarButtonClass} onClick={onRetry}>
            Try again
          </Button>
          <Button variant="ghost" className={canvasGhostButtonClass} onClick={onClose}>
            Back to automations
          </Button>
        </div>
      </div>
    </main>
  );
}

function BuilderDeleteDialog({
  automationTitle,
  open,
  isDeleting,
  onOpenChange,
  onConfirm,
}: {
  automationTitle: string;
  open: boolean;
  isDeleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <div className="flex flex-col gap-2">
          <div
            className="grid size-10 place-items-center rounded-[12px] bg-destructive/10 text-destructive"
            aria-hidden="true"
          >
            <TrashIcon size={20} />
          </div>
          <div className="flex flex-col gap-1">
            <AlertDialogTitle className="text-[17px] font-semibold leading-6 tracking-[-0.01em]">
              Delete automation?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px] leading-5">
              Permanently deletes <span className="font-medium text-foreground">{automationTitle}</span> and its run
              history. Future runs won't trigger — this can't be undone.
            </AlertDialogDescription>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost" className="h-9 rounded-[8px] px-4 text-[13px]" disabled={isDeleting}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="h-9 rounded-[8px] px-4 text-[13px]"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <SpinnerGapIcon size={15} className="animate-spin" />
                Deleting…
              </>
            ) : (
              "Delete automation"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AutomationSetupCard({
  mode,
  recommendation,
  onSelect,
}: {
  mode: AutomationExecutionMode | null;
  recommendation?: AutomationDefinition["executionModeRecommendation"];
  onSelect: (mode: AutomationExecutionMode) => void;
}) {
  const modes: AutomationExecutionMode[] = ["deterministic", "hybrid", "agent-led"];
  const initialRecommendationDiffers = Boolean(mode && recommendation && recommendation.mode !== mode);
  return (
    <section data-testid="automation-setup-card" className="w-full pb-1">
      <fieldset className="border-0 p-0">
        <legend className="text-[15px] font-semibold leading-5 text-foreground">
          How should Sketch run this automation?
        </legend>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          Choose how much of the workflow should be fixed and how much should use AI.
        </p>
        <div className="mt-3 grid gap-2">
          {modes.map((option) => {
            const metadata = automationExecutionModeMetadata[option];
            const selected = mode === option;
            const recommended = recommendation?.mode === option;
            return (
              <label
                key={option}
                data-testid={`automation-mode-${option}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2.5 transition-[border-color,background-color,box-shadow]",
                  "border-border/70 bg-background/35 hover:border-border hover:bg-muted/45 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-accent/55",
                  selected && "border-brand-accent/60 bg-brand-accent/[0.09] shadow-sm",
                )}
              >
                <input
                  type="radio"
                  name="automation-execution-mode"
                  value={option}
                  checked={selected}
                  aria-label={metadata.label}
                  className="sr-only"
                  onChange={() => onSelect(option)}
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1 size-3 shrink-0 rounded-full border border-muted-foreground/50",
                    selected && "border-brand-accent bg-brand-accent ring-[3px] ring-brand-accent/20",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-[13px] font-semibold leading-5 text-foreground">{metadata.label}</span>
                    {recommended ? (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        Recommended
                      </span>
                    ) : null}
                    {selected ? (
                      <span className="ml-auto text-[11px] font-medium text-brand-accent">Selected</span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                    {metadata.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {initialRecommendationDiffers && recommendation && mode ? (
        <p aria-live="polite" className="mt-2 text-[11px] leading-4 text-muted-foreground">
          You selected{" "}
          <span className="font-medium text-foreground">{automationExecutionModeMetadata[mode].label}</span>. Sketch
          recommended {automationExecutionModeMetadata[recommendation.mode].label} because{" "}
          {recommendation.reason.charAt(0).toLowerCase()}
          {recommendation.reason.slice(1)}
        </p>
      ) : recommendation && mode ? (
        <p aria-live="polite" className="mt-2 text-[11px] leading-4 text-muted-foreground">
          This matches Sketch’s recommendation for the setup.
        </p>
      ) : null}
    </section>
  );
}

export function AutomationBuilderPage() {
  const { taskId } = useParams({ from: automationBuilderRoute.id });
  const auth = useDashboardAuth();
  const clientSessionId = useMemo(() => getAutomationAuthoringSessionId(), []);
  const builderSearch = useSearch({ from: automationBuilderRoute.id }) as BuilderSearch;
  const requestedConversationId = builderSearch.conversationId;
  const requestedRunId =
    builderSearch.runId && SAFE_AUTOMATION_RUN_ID.test(builderSearch.runId) ? builderSearch.runId : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => automationDefinitionQueryKey(taskId), [taskId]);
  const [draft, setDraft] = useState<DraftAutomation | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [runInspectorOpen, setRunInspectorOpen] = useState(false);
  const [chatSidecarOpen, setChatSidecarOpen] = useState(true);
  const [triggeredRunId, setTriggeredRunId] = useState<string | null>(null);
  const [runRequestError, setRunRequestError] = useState<unknown | null>(null);
  const [savingPromptStepId, setSavingPromptStepId] = useState<string | null>(null);
  const [executionModeSelection, setExecutionModeSelection] = useState<ExecutionModeSelection | null>(null);
  const [setupExecutionMode, setSetupExecutionMode] = useState<AutomationExecutionMode | null>(null);
  const [discardingSetup, setDiscardingSetup] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [builderChatBusy, setBuilderChatBusy] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [stealDialogOpen, setStealDialogOpen] = useState(false);
  const [holderResponseDialogOpen, setHolderResponseDialogOpen] = useState(false);
  const [authoringLease, setAuthoringLease] = useState<AutomationAuthoringLease | null>(null);
  const surfacedStealRequestRef = useRef<string | null>(null);
  const executionModeSelectionIdRef = useRef(0);
  const executionModeRequestIdRef = useRef(0);
  const latestDraftRef = useRef<DraftAutomation | null>(null);
  const hydratedRevisionRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveCountRef = useRef(0);
  const runLeaseRef = useRef<AutomationLeaseRequest | null>(null);
  const testLeaseRef = useRef<AutomationLeaseRequest | null>(null);

  const navigateToAutomations = useCallback(() => {
    void navigate({ to: "/scheduled-tasks" });
  }, [navigate]);

  const navigateRun = useCallback(
    (runId: string | null) => {
      void navigate({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId },
        search: {
          ...(requestedConversationId ? { conversationId: requestedConversationId } : {}),
          ...(runId ? { runId } : {}),
        },
        replace: true,
      });
    },
    [navigate, requestedConversationId, taskId],
  );

  const automationQuery = useQuery({
    queryKey,
    queryFn: () => api.scheduledTasks.get(taskId, { clientSessionId }),
    refetchInterval: (query) =>
      query.state.data?.recentRuns.some((run) => {
        const state = automationRunLifecycleState(run);
        return state === "pending" || state === "running";
      })
        ? AUTOMATION_ACTIVE_RUN_REFRESH_INTERVAL_MS
        : AUTOMATION_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const editLockQueryKey = useMemo(
    () => ["automation-edit-lock", taskId, clientSessionId] as const,
    [clientSessionId, taskId],
  );
  const editLockQuery = useQuery({
    queryKey: editLockQueryKey,
    queryFn: async () => {
      const definition = await api.scheduledTasks.get(taskId, { clientSessionId });
      return definition.lock ?? null;
    },
    initialData: automationQuery.data?.lock ?? null,
    initialDataUpdatedAt: Date.now(),
    staleTime: AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
    refetchInterval: AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    enabled: Boolean(automationQuery.data),
  });
  const definitionLock = automationQuery.data?.lock ?? null;
  const lockView = editLockQuery.data ?? definitionLock;
  const canEditAutomation = automationQuery.data?.canEdit !== false;
  const lockHeldByOther = Boolean(lockView?.heldByUserId && !lockView.isHeldByMe);
  const exactLeaseHeld = Boolean(
    authoringLease?.holder.isHeldByMe && authoringLease.holder.generation === authoringLease.generation,
  );
  const builderReadOnly = !canEditAutomation || !exactLeaseHeld || lockHeldByOther;
  const isLockHolder = exactLeaseHeld;
  const authoringLeaseClientSessionId = authoringLease?.clientSessionId;
  const authoringLeaseGeneration = authoringLease?.generation;
  const authoringLeaseRequest = useMemo(
    () =>
      authoringLeaseClientSessionId && authoringLeaseGeneration
        ? { clientSessionId: authoringLeaseClientSessionId, generation: authoringLeaseGeneration }
        : null,
    [authoringLeaseClientSessionId, authoringLeaseGeneration],
  );
  const handleLeaseStale = useCallback(() => setAuthoringLease(null), []);
  const lockHolderRef = useRef<AutomationAuthoringLease | null>(authoringLease);
  useEffect(() => {
    lockHolderRef.current = authoringLease;
  }, [authoringLease]);

  useEffect(() => {
    const requestId = lockView?.isHeldByMe ? lockView.stealPending?.expiresAt : null;
    if (!requestId) {
      setHolderResponseDialogOpen(false);
      return;
    }
    if (surfacedStealRequestRef.current === requestId) return;
    surfacedStealRequestRef.current = requestId;
    setHolderResponseDialogOpen(true);
  }, [lockView?.isHeldByMe, lockView?.stealPending?.expiresAt]);

  useEffect(() => {
    if (lockView?.isHeldByMe) setStealDialogOpen(false);
  }, [lockView?.isHeldByMe]);

  const leaseIsCurrent = useCallback((lease: AutomationLeaseRequest) => {
    const current = lockHolderRef.current;
    return current?.clientSessionId === lease.clientSessionId && current.generation === lease.generation;
  }, []);

  useEffect(() => {
    return () => {
      const lease = lockHolderRef.current;
      if (!lease) return;
      void api.scheduledTasks.releaseLock(taskId, leaseRequest(lease)).catch(() => undefined);
    };
  }, [taskId]);

  useEffect(() => {
    const release = () => {
      const lease = lockHolderRef.current;
      if (!lease) return;
      void api.scheduledTasks.releaseLock(taskId, leaseRequest(lease), { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [taskId]);

  const hasAttributedRuns = Boolean(
    automationQuery.data?.recentRuns.some((run) => Boolean(run.triggeredByUserId)) ||
      automationQuery.data?.latestRun?.triggeredByUserId,
  );
  const attributionUsersQuery = useQuery({
    queryKey: ["automation-run-attribution-users"],
    queryFn: () => api.users.list(),
    enabled: hasAttributedRuns,
    staleTime: 60_000,
  });
  const memberNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const user of attributionUsersQuery.data?.users ?? []) {
      names.set(user.id, user.name);
    }
    return names;
  }, [attributionUsersQuery.data]);

  useEffect(() => {
    if (!automationQuery.data || pendingSaveCountRef.current > 0) return;
    if (hydratedRevisionRef.current === automationQuery.data.revision) return;
    const nextDraft = draftFromDefinition(automationQuery.data);
    hydratedRevisionRef.current = nextDraft.revision;
    latestDraftRef.current = nextDraft;
    setDraft(nextDraft);
  }, [automationQuery.data]);

  const displayDraft = useMemo(() => {
    if (!draft || !automationQuery.data || !isPlaceholderDraft(automationQuery.data)) return draft;
    return { ...draft, steps: [], edges: [], stepContent: {} };
  }, [automationQuery.data, draft]);

  useEffect(() => {
    if (selectedStepId && displayDraft && !displayDraft.steps.some((step) => step.id === selectedStepId)) {
      setSelectedStepId(null);
    }
  }, [displayDraft, selectedStepId]);

  const runMutation = useMutation({
    mutationFn: (mode: "manual" | "test") => {
      const lease = authoringLease;
      if (!lease) throw new Error("Acquire the automation editing session before running");
      runLeaseRef.current = leaseRequest(lease);
      return api.scheduledTasks.run(taskId, mode, runLeaseRef.current);
    },
    onMutate: () => {
      setRunRequestError(null);
    },
    onSuccess: async ({ runId }) => {
      if (!runLeaseRef.current || !leaseIsCurrent(runLeaseRef.current)) return;
      if (!runId || !SAFE_AUTOMATION_RUN_ID.test(runId)) {
        setRunRequestError(new Error("The run response did not include a valid run ID."));
        return;
      }
      setTriggeredRunId(runId);
      navigateRun(runId);
      await invalidateAutomationQueries(queryClient, [taskId]);
    },
    onError: (error) => {
      setRunRequestError(error);
      if (isLeaseStaleError(error)) setAuthoringLease(null);
      toast.error("Could not start the automation run");
    },
  });

  const selectedRunId = triggeredRunId ?? requestedRunId ?? null;
  const recentRunForSelection = automationQuery.data?.recentRuns.find((run) => run.id === selectedRunId) ?? null;
  const exactRunQuery = useQuery({
    queryKey: ["automation-run", taskId, selectedRunId],
    queryFn: () => api.scheduledTasks.getRun(taskId, selectedRunId as string),
    enabled: Boolean(selectedRunId && automationQuery.data),
    retry: false,
    refetchInterval: (query) => {
      const state = automationRunLifecycleState(query.state.data?.run);
      if (isTerminalRunLifecycleState(state)) return false;
      return triggeredRunId !== null || state === "pending" || state === "running" ? 1_000 : false;
    },
  });

  useEffect(() => {
    if (triggeredRunId && requestedRunId && requestedRunId !== triggeredRunId) setTriggeredRunId(null);
  }, [requestedRunId, triggeredRunId]);

  const testMutation = useMutation({
    mutationFn: (stepId: string) => {
      const lease = authoringLease;
      if (!lease) throw new Error("Acquire the automation editing session before testing a step");
      testLeaseRef.current = leaseRequest(lease);
      return api.scheduledTasks.testStep(taskId, stepId, { useLatestUpstreamOutput: true }, testLeaseRef.current);
    },
    onSuccess: async () => {
      if (!testLeaseRef.current || !leaseIsCurrent(testLeaseRef.current)) return;
      toast.success("Test complete");
      await invalidateAutomationQueries(queryClient, [taskId]);
    },
    onError: (error) => {
      if (isLeaseStaleError(error)) setAuthoringLease(null);
      toast.error(error instanceof Error ? error.message : "Test failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!authoringLease) throw new Error("Acquire the automation editing session before deleting");
      return api.scheduledTasks.remove(taskId, leaseRequest(authoringLease));
    },
    onSuccess: async () => {
      await invalidateAutomationQueries(queryClient, [taskId]);
      setDeleteDialogOpen(false);
      toast.success("Automation deleted");
      navigateToAutomations();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete automation"),
  });

  const statusMutation = useMutation({
    mutationFn: (action: "pause" | "resume") => {
      if (!authoringLease) throw new Error("Acquire the automation editing session before changing its status");
      const lease = leaseRequest(authoringLease);
      return action === "pause" ? api.scheduledTasks.pause(taskId, lease) : api.scheduledTasks.resume(taskId, lease);
    },
    onSuccess: async (_task, action) => {
      await invalidateAutomationQueries(queryClient, [taskId]);
      toast.success(action === "pause" ? "Automation paused" : "Automation resumed");
    },
    onError: (error) => {
      if (isLeaseStaleError(error)) setAuthoringLease(null);
      toast.error(error instanceof Error ? error.message : "Could not change the automation status");
    },
  });

  const responseDeliveryMutation = useMutation({
    mutationFn: (muted: boolean) => api.scheduledTasks.setResponseMuted(taskId, muted),
    onSuccess: async (task) => {
      const mode = task.outputMode;
      queryClient.setQueryData<AutomationDefinition>(queryKey, (current) =>
        current ? { ...current, delivery: { ...current.delivery, mode } } : current,
      );
      setDraft((current) => {
        if (!current) return current;
        const next = { ...current, delivery: { ...current.delivery, mode } };
        latestDraftRef.current = next;
        return next;
      });
      await invalidateAutomationQueries(queryClient, [taskId]);
      toast.success(mode === "silent" ? "Automation responses muted" : "Automation responses unmuted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not change automation response delivery");
    },
  });

  const saveDraftPatch = useCallback(
    (
      patch: (current: DraftAutomation) => DraftAutomation,
      options: { message?: string; promptStepId?: string; onSaved?: () => void } = {},
    ) => {
      if (builderReadOnly) return;
      if (options.promptStepId) setSavingPromptStepId(options.promptStepId);
      pendingSaveCountRef.current += 1;
      const save = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const currentDraft = latestDraftRef.current;
          if (!currentDraft) return;

          const nextDraft = patch(currentDraft);
          latestDraftRef.current = nextDraft;
          setDraft(nextDraft);
          if (options.promptStepId) setSavingPromptStepId(options.promptStepId);

          try {
            const lease = authoringLease;
            if (!lease) throw new Error("Acquire the automation editing session before saving");
            const requestLease = leaseRequest(lease);
            const updatedAutomation = await api.scheduledTasks.save(
              taskId,
              saveRequestFromDraft(nextDraft),
              requestLease,
            );
            if (!leaseIsCurrent(requestLease)) return;
            const updatedDraft = draftFromDefinition(updatedAutomation);
            hydratedRevisionRef.current = updatedDraft.revision;
            latestDraftRef.current = updatedDraft;
            queryClient.setQueryData(queryKey, updatedAutomation);
            setDraft(updatedDraft);
            await invalidateAutomationQueries(queryClient, [taskId]);
            if (options.message) toast.success(options.message);
            options.onSaved?.();
          } catch (error) {
            if (isLeaseStaleError(error)) setAuthoringLease(null);
            toast.error(error instanceof Error ? error.message : "Failed to save automation");
            try {
              const refreshed = await api.scheduledTasks.get(taskId);
              const refreshedDraft = draftFromDefinition(refreshed);
              hydratedRevisionRef.current = refreshedDraft.revision;
              latestDraftRef.current = refreshedDraft;
              queryClient.setQueryData(queryKey, refreshed);
              setDraft(refreshedDraft);
            } catch {
              await invalidateAutomationQueries(queryClient, [taskId]);
            }
            throw error;
          } finally {
            if (options.promptStepId) {
              setSavingPromptStepId((current) => (current === options.promptStepId ? null : current));
            }
          }
        })
        .finally(() => {
          pendingSaveCountRef.current -= 1;
        });
      saveQueueRef.current = save.catch(() => undefined);
    },
    [authoringLease, builderReadOnly, leaseIsCurrent, queryClient, queryKey, taskId],
  );

  const acquireLockMutation = useMutation({
    mutationFn: () =>
      api.scheduledTasks.acquireLock(
        taskId,
        clientSessionId,
        authoringLease?.generation ?? (lockView?.isHeldByMe ? lockView.generation : undefined),
      ),
    onSuccess: ({ lock }) => {
      queryClient.setQueryData(editLockQueryKey, lock);
      setAuthoringLease({ clientSessionId, generation: lock.generation, holder: lock });
    },
    onError: (error) => {
      if (!(error instanceof ApiRequestError)) return;
      if (error.code === "LEASE_STALE") setAuthoringLease(null);
      if (error.code !== "LOCKED" && error.code !== "LEASE_STALE") return;
      const lock = (error.details.lock ?? error.details.builderLock) as AutomationEditLockView | undefined;
      if (lock) queryClient.setQueryData(editLockQueryKey, lock);
    },
  });
  const acquireLock = acquireLockMutation.mutate;

  const autoAcquireEnabled = automationQuery.data != null && automationQuery.data.canEdit !== false;
  useEffect(() => {
    if (!autoAcquireEnabled || authoringLease) return;
    const expiresAt = lockView?.expiresAt ? new Date(lockView.expiresAt).getTime() : null;
    const heldByActiveOtherSession =
      Boolean(lockView?.heldByUserId && !lockView.isHeldByMe && !lockView.isHeldByMyOtherSession) &&
      expiresAt !== null &&
      expiresAt > Date.now();
    if (heldByActiveOtherSession) {
      const expiryTimer = window.setTimeout(() => void acquireLock(), expiresAt - Date.now() + 50);
      return () => window.clearTimeout(expiryTimer);
    }
    void acquireLock();
    return;
  }, [acquireLock, authoringLease, autoAcquireEnabled, lockView]);

  useEffect(() => {
    if (authoringLease || !lockView?.isHeldByMe || !lockView.generation) return;
    setAuthoringLease({ clientSessionId, generation: lockView.generation, holder: lockView });
  }, [authoringLease, clientSessionId, lockView]);

  useEffect(() => {
    if (!isLockHolder) return;
    const renew = () => void acquireLock();
    const interval = window.setInterval(() => {
      renew();
    }, AUTOMATION_EDIT_LOCK_HEARTBEAT_INTERVAL_MS);
    window.addEventListener("focus", renew);
    document.addEventListener("visibilitychange", renew);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", renew);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [acquireLock, isLockHolder]);

  const updateAgentPrompt = useCallback(
    (stepId: string, content: string) => {
      saveDraftPatch(
        (current) => {
          const existing = current.stepContent[stepId];
          return {
            ...current,
            stepContent: {
              ...current.stepContent,
              [stepId]: {
                taskId,
                stepId,
                contentType: "prompt",
                content,
                apps: existing?.apps ?? null,
                updatedAt: existing?.updatedAt ?? null,
              },
            },
          };
        },
        { message: "Prompt saved", promptStepId: stepId },
      );
    },
    [saveDraftPatch, taskId],
  );

  const updateStepPositions = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      saveDraftPatch((current) => ({
        ...current,
        steps: current.steps.map((step) => (positions[step.id] ? { ...step, position: positions[step.id] } : step)),
      }));
    },
    [saveDraftPatch],
  );

  const updateExecutionMode = useCallback(
    (executionMode: AutomationExecutionMode) => {
      if (builderReadOnly) return;
      executionModeRequestIdRef.current += 1;
      const requestId = executionModeRequestIdRef.current;
      const selected = () => {
        if (executionModeRequestIdRef.current !== requestId) return;
        executionModeSelectionIdRef.current += 1;
        setExecutionModeSelection({ id: executionModeSelectionIdRef.current, mode: executionMode });
      };
      if (automationQuery.data && isPlaceholderDraft(automationQuery.data)) {
        const lease = authoringLease;
        if (!lease) {
          toast.error("Acquire the automation editing session before saving setup");
          return;
        }
        void api.scheduledTasks
          .selectSetupExecutionMode(taskId, executionMode, leaseRequest(lease))
          .then(async (updatedAutomation) => {
            if (executionModeRequestIdRef.current !== requestId) return;
            setSetupExecutionMode(executionMode);
            const updatedDraft = draftFromDefinition(updatedAutomation);
            hydratedRevisionRef.current = updatedDraft.revision;
            latestDraftRef.current = updatedDraft;
            queryClient.setQueryData(queryKey, updatedAutomation);
            setDraft(updatedDraft);
            await invalidateAutomationQueries(queryClient, [taskId]);
            selected();
          })
          .catch((error) => {
            if (isLeaseStaleError(error)) setAuthoringLease(null);
            toast.error(error instanceof Error ? error.message : "Failed to save automation setup");
          });
        return;
      }
      saveDraftPatch((current) => ({ ...current, executionMode }), {
        onSaved: selected,
      });
    },
    [automationQuery.data, authoringLease, builderReadOnly, queryClient, queryKey, saveDraftPatch, taskId],
  );
  const handleExecutionModeSelectionHandled = useCallback((selectionId: number) => {
    setExecutionModeSelection((current) => (current?.id === selectionId ? null : current));
  }, []);
  const handleSelectStep = useCallback((stepId: string | null) => {
    setSelectedStepId(stepId);
  }, []);

  const setupConversationsQuery = useQuery({
    queryKey: builderConversationQueryKey(taskId, clientSessionId),
    queryFn: () => api.scheduledTasks.conversations(taskId, { includeArchived: true, clientSessionId }),
    staleTime: 30_000,
  });
  const setupBuilderConversationId = useMemo(() => {
    const builderConversations = (setupConversationsQuery.data?.conversations ?? []).filter(
      (conversation) => conversation.state === "active" && conversation.kinds.includes("builder"),
    );
    if (builderConversations.length === 0) return null;
    return builderConversations.reduce((oldest, conversation) =>
      new Date(conversation.createdAt).getTime() < new Date(oldest.createdAt).getTime() ? conversation : oldest,
    ).conversationId;
  }, [setupConversationsQuery.data?.conversations]);
  const rawAutomationTitle = automationQuery.data?.title ?? null;
  const setupNeedsDerivedName = rawAutomationTitle === null || rawAutomationTitle === "New automation";
  const setupNameMessagesQuery = useQuery({
    queryKey: ["automation-setup-name", taskId, setupBuilderConversationId],
    queryFn: () => api.scheduledTasks.conversationMessages(taskId, setupBuilderConversationId as string),
    enabled: setupNeedsDerivedName && Boolean(setupBuilderConversationId),
    staleTime: 60_000,
  });
  const derivedSetupName = useMemo(
    () => deriveSetupNameFromMessages((setupNameMessagesQuery.data?.messages ?? []) as BuilderWebChatMessage[]),
    [setupNameMessagesQuery.data],
  );

  if (automationQuery.isError) {
    return (
      <BuilderLoadError
        error={automationQuery.error}
        onRetry={() => void automationQuery.refetch()}
        onClose={() => navigate({ to: "/scheduled-tasks" })}
      />
    );
  }

  if (automationQuery.isLoading || !draft || !automationQuery.data) {
    return (
      <div className="automation-builder-loading flex min-h-[calc(100vh-3rem)] items-center justify-center bg-background px-6 md:min-h-screen">
        <output className="flex items-center gap-3 text-sm text-muted-foreground">
          <SpinnerGapIcon size={18} className="animate-spin text-brand-accent" />
          <span>Loading automation…</span>
        </output>
      </div>
    );
  }

  const automation = automationQuery.data;
  /**
   * Unified permission model: anyone who can edit the automation — owner,
   * granted editors, and admins alike — can also manage its sharing. The server
   * still limits grant/revoke to the owner today, so for a non-owner the Share
   * dialog opens and reads the roster, but the actual grant/revoke is rejected
   * and surfaced as an error toast until the backend widens canShare.
   *
   * FLAG FOR TANUSH (backend): canShare must include granted editors + admins.
   * The owner row is never removable in the dialog, so the agreed scope — an
   * editor can add and remove co-editors but never the owner — already holds.
   * See the project_automation_builder_redesign memory.
   */
  const canManageSharing = canEditAutomation;
  /**
   * Unified model (user 2026-09-22, "everyone can do everything"): anyone who can
   * edit the automation can also control its run status. The backend already
   * permits this — /pause, /resume and /response-delivery all authorize via
   * loadAccessibleTask (owner || admin || granted) — so un-gating it here is a
   * pure frontend change with NO backend dependency, unlike Share/Delete.
   */
  const canControlAutomationStatus = canEditAutomation;
  const placeholderSetup = isPlaceholderDraft(automation);
  const runInspectorVisible = runInspectorOpen && !placeholderSetup;
  const builderDraft = displayDraft ?? draft;
  const exactRunCandidate = exactRunQuery.data?.run;
  const exactRun = selectedRunId && exactRunCandidate?.id === selectedRunId ? exactRunCandidate : null;
  const selectedRun: AutomationRunRecord | null = selectedRunId
    ? (exactRun ?? (exactRunQuery.isPending ? recentRunForSelection : null))
    : (automation.latestRun as AutomationRunRecord | null);
  const testingStepId = testMutation.isPending ? (testMutation.variables ?? null) : null;
  const inferredRunStepId = inferredRunningStepId(
    builderDraft.steps,
    builderDraft.edges,
    selectedRun?.stepOutputs ?? {},
    selectedRun?.status,
  );
  const executingStepId = testingStepId ?? inferredRunStepId;
  const executionActivity: ExecutionActivity = testingStepId ? "test" : inferredRunStepId ? "run" : null;
  const automationTitle = placeholderSetup ? "Automation setup" : draft.title?.trim() || draft.prompt;
  /**
   * Identity-pill name. Priority: the automation's saved title, then a name
   * derived from the setup chat (owner/admin — chat-gated), then a name derived
   * from the definition's own prompt. The prompt path is what keeps an editor
   * (who cannot read a teammate's chat) from ever seeing a bare "Untitled" — the
   * prompt lives on the definition they *can* load, so it names the automation
   * by what it actually does. Final fallback is a neutral noun, never "Untitled".
   *
   * FLAG FOR TANUSH (backend): the canonical fix is a server-derived short title
   * on the task, readable by every viewer, so owner/editor/admin all show one
   * consistent name (and teammate chat titles stop reading "Automation chat").
   * See the project_automation_builder_redesign memory.
   */
  const setupIdentityName =
    automation.title && automation.title !== "New automation"
      ? automation.title
      : (derivedSetupName ?? (placeholderSetup ? null : deriveSetupName(draft.prompt ?? "")) ?? "New automation");
  const selectedRunLifecycle = runMutation.isPending
    ? "pending"
    : triggeredRunId && !selectedRun
      ? "pending"
      : automationRunLifecycleState(selectedRun);
  const exactRunUnavailable = Boolean(
    selectedRunId && (exactRunQuery.isError || (exactRunQuery.isSuccess && !exactRun)),
  );
  const exactRunLoading = Boolean(selectedRunId && !exactRunUnavailable && exactRunQuery.isPending);
  const showRunStatusNotice = Boolean(
    runRequestError ||
      exactRunUnavailable ||
      exactRunLoading ||
      selectedRunLifecycle === "pending" ||
      selectedRunLifecycle === "running",
  );
  const canRunAutomation = automation.status === "active";
  const hasActiveAutomationRun = [automation.latestRun, ...automation.recentRuns].some((run) => {
    const lifecycle = automationRunLifecycleState(run);
    return lifecycle === "pending" || lifecycle === "running";
  });
  const runIsBusy =
    runMutation.isPending ||
    hasActiveAutomationRun ||
    selectedRunLifecycle === "pending" ||
    selectedRunLifecycle === "running";
  const selectedStep = builderDraft.steps.find((step) => step.id === selectedStepId) ?? null;
  const selectedOutput = selectedStep ? selectedStepOutput(selectedStep, selectedRun) : undefined;
  const selectedStepStatus = selectedStep
    ? outputStatus(selectedOutput, selectedStep.id === executingStepId)
    : ("idle" as UiStatus);
  const closeBuilder = () => {
    if (!placeholderSetup) {
      navigateToAutomations();
      return;
    }
    setDiscardingSetup(true);
    void api.scheduledTasks
      .remove(taskId, authoringLease ? leaseRequest(authoringLease) : undefined)
      .then(async () => {
        if (requestedConversationId?.startsWith("builder-")) {
          await api.webChat.removeConversation(requestedConversationId).catch((error: unknown) => {
            if (error instanceof ApiRequestError && error.code === "CONVERSATION_NOT_FOUND") return;
            toast.error("The setup was removed, but its chat history could not be cleaned up");
          });
        }
        await invalidateAutomationQueries(queryClient, [taskId]);
        navigateToAutomations();
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not discard this setup"))
      .finally(() => setDiscardingSetup(false));
  };
  return (
    <div className="automation-builder-enter relative flex h-[calc(100vh-3rem)] min-h-0 overflow-hidden bg-background md:h-screen">
      <BuilderChatSidecar
        requestedConversationId={requestedConversationId ?? null}
        taskId={taskId}
        title={automationTitle}
        queryKey={queryKey}
        executionMode={isPlaceholderDraft(automation) ? setupExecutionMode : draft.executionMode}
        executionModeRecommendation={draft.executionModeRecommendation}
        isSetupPlaceholder={isPlaceholderDraft(automation)}
        executionModeSelection={executionModeSelection}
        originChat={automation.originChat}
        onExecutionModeSelect={updateExecutionMode}
        onExecutionModeSelectionHandled={handleExecutionModeSelectionHandled}
        onBusyChange={setBuilderChatBusy}
        clientSessionId={clientSessionId}
        authoringLease={authoringLeaseRequest}
        onLeaseStale={handleLeaseStale}
        open={chatSidecarOpen}
        onClose={() => setChatSidecarOpen(false)}
        className="automation-builder-sidecar-enter"
      />

      <div
        data-testid="automation-builder-canvas"
        data-chat-sidecar-open={chatSidecarOpen}
        data-run-inspector-open={runInspectorVisible}
        className="automation-builder-canvas-container relative min-h-0 min-w-0 flex-1 bg-background text-foreground"
        aria-busy={runMutation.isPending || selectedRun?.status === "running"}
      >
        {placeholderSetup ? (
          <div
            data-testid="automation-builder-header"
            className="pointer-events-none absolute top-1.5 right-4 left-4 z-10 flex items-start justify-between gap-2"
          >
            <div className="pointer-events-auto flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 items-center gap-1 rounded-[13px] border border-border/70 bg-card/95 py-1 pr-3 pl-1 shadow-md backdrop-blur">
                <IconTooltip label="Back to automations">
                  <Button
                    size="icon"
                    variant="ghost"
                    className={canvasCompactIconButtonClass}
                    aria-label="Back to automations"
                    onClick={navigateToAutomations}
                  >
                    <CaretLeftIcon size={16} />
                  </Button>
                </IconTooltip>
                <span
                  title={setupIdentityName}
                  className="min-w-0 max-w-[240px] truncate text-[13px] font-semibold text-foreground"
                >
                  {setupIdentityName}
                </span>
                {!chatSidecarOpen ? (
                  <>
                    <span className="mx-0.5 h-4 w-px shrink-0 bg-border/70" aria-hidden />
                    <IconTooltip label="Open chat">
                      <Button
                        size="icon"
                        variant="ghost"
                        className={canvasCompactIconButtonClass}
                        aria-label="Expand automation chat"
                        aria-expanded={false}
                        aria-controls="automation-builder-chat-sidecar"
                        onClick={() => setChatSidecarOpen(true)}
                      >
                        <ChatCircleIcon size={16} weight="fill" />
                      </Button>
                    </IconTooltip>
                  </>
                ) : null}
              </div>
              <AutomationLockBanner
                lock={lockView}
                canEdit={canEditAutomation}
                onRequestTakeover={() => setStealDialogOpen(true)}
                onReviewStealRequest={() => setHolderResponseDialogOpen(true)}
              />
            </div>

            <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-[13px] border border-border/70 bg-card/95 p-1 shadow-md backdrop-blur">
              {canManageSharing ? (
                <IconTooltip label="Share">
                  <Button
                    size="icon"
                    variant="ghost"
                    className={canvasCompactIconButtonClass}
                    aria-label="Share automation"
                    onClick={() => setShareDialogOpen(true)}
                  >
                    <ShareNetworkIcon size={16} />
                  </Button>
                </IconTooltip>
              ) : null}
              <IconTooltip label={builderReadOnly ? "Request control to discard" : "Discard setup"}>
                <span className={cn("inline-flex", builderReadOnly && "cursor-not-allowed")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn(
                      canvasCompactIconButtonClass,
                      "hover:bg-destructive/10 hover:text-destructive",
                      builderReadOnly && "pointer-events-none",
                    )}
                    aria-label="Discard setup"
                    onClick={closeBuilder}
                    disabled={discardingSetup || builderReadOnly}
                  >
                    {discardingSetup ? <SpinnerGapIcon size={16} className="animate-spin" /> : <TrashIcon size={16} />}
                  </Button>
                </span>
              </IconTooltip>
            </div>
          </div>
        ) : (
          <div
            data-testid="automation-builder-header"
            className="automation-builder-toolbar-enter pointer-events-none absolute top-2.5 right-4 left-4 z-10 flex flex-wrap items-start justify-between gap-2"
          >
            <div
              data-testid="automation-builder-toolbar"
              className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2"
            >
              {!chatSidecarOpen ? (
                <div className={cn(builderTrayClass, "px-1")}>
                  <IconTooltip label="Show chat">
                    <Button
                      size="icon"
                      variant="ghost"
                      className={canvasCompactIconButtonClass}
                      aria-label="Show automation chat"
                      aria-expanded={false}
                      aria-controls="automation-builder-chat-sidecar"
                      onClick={() => setChatSidecarOpen(true)}
                    >
                      <ChatCircleIcon size={16} />
                    </Button>
                  </IconTooltip>
                </div>
              ) : null}
              <div className={cn(builderTrayClass, "min-w-0 gap-1 pr-3 pl-1")}>
                <IconTooltip label="Back to automations">
                  <Button
                    size="icon"
                    variant="ghost"
                    className={canvasCompactIconButtonClass}
                    aria-label="Back to automations"
                    onClick={navigateToAutomations}
                  >
                    <CaretLeftIcon size={16} />
                  </Button>
                </IconTooltip>
                <span
                  title={setupIdentityName}
                  className="min-w-0 max-w-[240px] truncate text-[13px] font-semibold text-foreground"
                >
                  {setupIdentityName}
                </span>
              </div>
              <AutomationLockBanner
                lock={lockView}
                canEdit={canEditAutomation}
                onRequestTakeover={() => setStealDialogOpen(true)}
                onReviewStealRequest={() => setHolderResponseDialogOpen(true)}
              />
              {showRunStatusNotice ? (
                <AutomationRunStatusNotice
                  state={runRequestError ? "failure" : selectedRunLifecycle}
                  run={selectedRun}
                  loading={exactRunLoading}
                  unavailable={exactRunUnavailable}
                  requestFailed={Boolean(runRequestError)}
                />
              ) : null}
            </div>

            <div
              data-testid="automation-builder-header-actions"
              className="pointer-events-auto flex min-w-0 flex-wrap items-center justify-end gap-2"
            >
              <div className={cn(builderTrayClass, "gap-0.5 px-1")}>
                {canManageSharing ? (
                  <IconTooltip
                    label={`Share${automation.shares && automation.shares.length > 0 ? ` · ${automation.shares.length}` : ""}`}
                  >
                    <Button
                      size="icon"
                      variant="ghost"
                      className={canvasCompactIconButtonClass}
                      aria-label="Share automation"
                      onClick={() => setShareDialogOpen(true)}
                    >
                      <ShareNetworkIcon size={16} />
                    </Button>
                  </IconTooltip>
                ) : null}
                {canControlAutomationStatus ? (
                  <IconTooltip label={automation.delivery.mode === "silent" ? "Unmute responses" : "Mute responses"}>
                    <Button
                      size="icon"
                      variant="ghost"
                      className={cn(
                        canvasCompactIconButtonClass,
                        automation.delivery.mode === "silent" && "bg-muted text-foreground hover:bg-muted",
                      )}
                      aria-label={
                        automation.delivery.mode === "silent"
                          ? "Unmute automation responses"
                          : "Mute automation responses"
                      }
                      aria-pressed={automation.delivery.mode === "silent"}
                      onClick={() => responseDeliveryMutation.mutate(automation.delivery.mode === "deliver")}
                      disabled={responseDeliveryMutation.isPending || builderReadOnly}
                    >
                      {responseDeliveryMutation.isPending ? (
                        <SpinnerGapIcon size={16} className="animate-spin" />
                      ) : automation.delivery.mode === "silent" ? (
                        <BellSlashIcon size={16} />
                      ) : (
                        <BellIcon size={16} />
                      )}
                    </Button>
                  </IconTooltip>
                ) : null}
                {canControlAutomationStatus && automation.status !== "completed" ? (
                  <IconTooltip label={automation.status === "active" ? "Pause automation" : "Resume automation"}>
                    <Button
                      size="icon"
                      variant="ghost"
                      className={canvasCompactIconButtonClass}
                      aria-label={automation.status === "active" ? "Pause automation" : "Resume automation"}
                      onClick={() => statusMutation.mutate(automation.status === "active" ? "pause" : "resume")}
                      disabled={statusMutation.isPending || runIsBusy || builderReadOnly}
                    >
                      {statusMutation.isPending ? (
                        <SpinnerGapIcon size={16} className="animate-spin" />
                      ) : automation.status === "active" ? (
                        <PauseIcon size={16} />
                      ) : (
                        <PlayIcon size={16} />
                      )}
                    </Button>
                  </IconTooltip>
                ) : null}
                <span className="mx-0.5 h-4 w-px shrink-0 bg-border/70" aria-hidden />
                <IconTooltip label="Delete automation">
                  <span className={cn("inline-flex", builderReadOnly && "cursor-not-allowed")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      className={cn(
                        canvasCompactIconButtonClass,
                        "hover:bg-destructive/10 hover:text-destructive active:bg-destructive/[0.16]",
                        builderReadOnly && "pointer-events-none",
                      )}
                      aria-label="Delete automation"
                      onClick={() => setDeleteDialogOpen(true)}
                      disabled={deleteMutation.isPending || builderReadOnly}
                    >
                      {deleteMutation.isPending ? (
                        <SpinnerGapIcon size={16} className="animate-spin" />
                      ) : (
                        <TrashIcon size={16} />
                      )}
                    </Button>
                  </span>
                </IconTooltip>
              </div>

              <div className="inline-flex h-9 shrink-0 items-stretch overflow-hidden rounded-[12px] bg-brand-accent shadow-[0_2px_10px_-4px_rgba(15,23,42,0.16)]">
                <button
                  type="button"
                  onClick={() => runMutation.mutate("manual")}
                  disabled={runIsBusy || !canRunAutomation || builderReadOnly}
                  title={canRunAutomation ? "Run now" : "Only active automations can be triggered"}
                  className="inline-flex items-center gap-1.5 pr-2.5 pl-3 text-[13px] font-semibold text-[#161300] transition-colors hover:bg-[#161300]/[0.06] active:bg-[#161300]/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#161300]/40 disabled:pointer-events-none disabled:opacity-50"
                >
                  {runMutation.isPending && runMutation.variables === "manual" ? (
                    <SpinnerGapIcon size={16} className="animate-spin" />
                  ) : (
                    <PlayIcon size={16} />
                  )}
                  {runMutation.isPending && runMutation.variables === "manual"
                    ? "Starting…"
                    : runIsBusy
                      ? "Running"
                      : canRunAutomation
                        ? "Run"
                        : "Paused"}
                </button>
                <span className="w-px shrink-0 self-stretch bg-[#161300]/15" aria-hidden />
                <Popover open={runMenuOpen} onOpenChange={setRunMenuOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="More run options"
                      disabled={runIsBusy || !canRunAutomation || builderReadOnly}
                      className="inline-flex items-center px-1.5 text-[#161300] transition-colors hover:bg-[#161300]/[0.06] active:bg-[#161300]/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#161300]/40 disabled:pointer-events-none disabled:opacity-50"
                    >
                      <CaretDownIcon size={14} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    sideOffset={10}
                    className="w-[248px] rounded-[12px] border-border/65 p-1 shadow-[0_10px_30px_-10px_rgba(15,23,42,0.28)]"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setRunMenuOpen(false);
                        runMutation.mutate("test");
                      }}
                      disabled={runIsBusy || !canRunAutomation || builderReadOnly}
                      className="group flex w-full items-center gap-2.5 rounded-[9px] px-2 py-2 text-left transition-colors hover:bg-muted active:bg-muted/80 focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-muted/70 text-foreground/80 transition-colors group-hover:bg-background group-hover:text-foreground">
                        <PlayIcon size={15} weight="fill" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium leading-5 text-foreground">
                          {runMutation.isPending && runMutation.variables === "test" ? "Testing…" : "Test run"}
                        </span>
                        <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                          Skips delivery to your channels
                        </span>
                      </span>
                    </button>
                  </PopoverContent>
                </Popover>
              </div>

              {!runInspectorVisible ? (
                <div className={cn(builderTrayClass, "px-1")}>
                  <IconTooltip label="Show run history">
                    <Button
                      size="icon"
                      variant="ghost"
                      className={canvasCompactIconButtonClass}
                      data-testid="automation-see-past-runs"
                      aria-label="Show run history"
                      aria-expanded={false}
                      aria-controls="automation-builder-runs-panel"
                      onClick={() => {
                        setSelectedStepId(null);
                        setRunInspectorOpen(true);
                      }}
                    >
                      <SidebarSimpleIcon size={16} className="-scale-x-100" />
                    </Button>
                  </IconTooltip>
                </div>
              ) : null}
            </div>
          </div>
        )}

        <AutomationCanvas
          draft={builderDraft}
          selectedStepId={selectedStepId}
          isRunInspectorOpen={runInspectorVisible && selectedStepId === null}
          stepOutputs={selectedRun?.stepOutputs ?? {}}
          runStatus={selectedRun?.status}
          testingStepId={testingStepId}
          isSetupPlaceholder={placeholderSetup}
          isBuilderChatBusy={builderChatBusy}
          readOnly={builderReadOnly}
          onSelectStep={handleSelectStep}
          onUpdateStepPositions={updateStepPositions}
        />
      </div>

      {selectedStepId === null ? (
        <RunInspector
          draft={builderDraft}
          runs={automation.recentRuns}
          memberNameById={memberNameById}
          activeRunId={selectedRunId}
          activeRun={selectedRunId ? selectedRun : null}
          loading={exactRunLoading}
          unavailable={exactRunUnavailable}
          onSelectRun={(runId) => {
            setTriggeredRunId(null);
            setRunRequestError(null);
            setSelectedStepId(null);
            setRunInspectorOpen(true);
            navigateRun(runId === selectedRunId ? null : runId);
          }}
          open={runInspectorVisible}
          onClose={() => setRunInspectorOpen(false)}
          onRefresh={() => automationQuery.refetch()}
        />
      ) : null}

      <BuilderDeleteDialog
        automationTitle={automationTitle}
        open={deleteDialogOpen}
        isDeleting={deleteMutation.isPending}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={() => deleteMutation.mutate()}
      />

      <NodeDrawer
        key={selectedStep?.id ?? "closed"}
        taskId={taskId}
        draft={builderDraft}
        step={selectedStep}
        output={selectedOutput}
        run={selectedRun}
        status={selectedStepStatus}
        executionActivity={selectedStep?.id === executingStepId ? executionActivity : null}
        readOnly={builderReadOnly}
        onClose={() => setSelectedStepId(null)}
        onTest={(stepId) => testMutation.mutate(stepId)}
        onSelectAccount={(stepId, canvasAccountId) =>
          saveDraftPatch(
            (current) => ({
              ...current,
              steps: current.steps.map((candidate) =>
                candidate.id === stepId
                  ? {
                      ...candidate,
                      accountIdentityBindings: {
                        ...candidate.accountIdentityBindings,
                        [canvasAccountId]: { canvasAccountId, accountId: "", tenantId: "" },
                      },
                      rebindAccountIds: [canvasAccountId],
                    }
                  : candidate,
              ),
            }),
            { message: "Account saved" },
          )
        }
        onRebindAccounts={(stepId) =>
          saveDraftPatch(
            (current) => ({
              ...current,
              steps: current.steps.map((candidate) =>
                candidate.id === stepId
                  ? { ...candidate, rebindAccountIds: Object.keys(candidate.accountIdentityBindings ?? {}) }
                  : candidate,
              ),
            }),
            { message: "Accounts rebound" },
          )
        }
        testingStepId={testingStepId}
        onUpdateAgentPrompt={updateAgentPrompt}
        savingPromptStepId={savingPromptStepId}
      />

      <AutomationShareDialog
        taskId={taskId}
        taskName={automationTitle}
        ownerUserId={automation.createdBy}
        canShare={canManageSharing}
        lastEditedByName={automation.lastEditedByName ?? automation.lastEditedBy}
        lastEditedAt={automation.updatedAt}
        lease={authoringLease ? leaseRequest(authoringLease) : null}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
      />

      <AutomationLockStealDialog
        taskId={taskId}
        open={stealDialogOpen}
        onOpenChange={setStealDialogOpen}
        lock={lockView}
        clientSessionId={clientSessionId}
        generation={authoringLease?.generation}
        onRequested={(nextLock) => {
          queryClient.setQueryData(editLockQueryKey, nextLock);
        }}
      />

      <AutomationLockHolderResponseDialog
        taskId={taskId}
        open={holderResponseDialogOpen}
        onOpenChange={setHolderResponseDialogOpen}
        lock={lockView}
        lease={authoringLease ? leaseRequest(authoringLease) : null}
        onResponded={(nextLock) => {
          queryClient.setQueryData(editLockQueryKey, nextLock);
          if (nextLock.isHeldByMe) {
            setAuthoringLease({ clientSessionId, generation: nextLock.generation, holder: nextLock });
          } else {
            setAuthoringLease(null);
          }
          void queryClient.invalidateQueries({ queryKey: builderConversationQueryKey(taskId, clientSessionId) });
        }}
      />
    </div>
  );
}

function AutomationRunStatusNotice({
  state,
  run,
  loading,
  unavailable,
  requestFailed,
}: {
  state: AutomationRunLifecycleState | null;
  run: AutomationRunRecord | null;
  loading: boolean;
  unavailable: boolean;
  requestFailed: boolean;
}) {
  if (unavailable) {
    return (
      <output
        data-testid="automation-run-unavailable"
        role="alert"
        aria-live="assertive"
        className="inline-flex min-h-8 items-center rounded-[7px] border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive backdrop-blur"
      >
        Run unavailable
      </output>
    );
  }
  if (loading) {
    return (
      <output
        data-testid="automation-run-loading"
        aria-live="polite"
        className="inline-flex min-h-8 items-center rounded-[7px] border border-border/70 bg-card/90 px-2.5 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur"
      >
        <SpinnerGapIcon size={13} className="mr-1.5 animate-spin" />
        Loading run
      </output>
    );
  }
  if (!state) return null;

  const label = runStatusLabel(state);
  const copy = requestFailed
    ? "Run could not be started."
    : state === "pending"
      ? "Run is queued."
      : state === "running"
        ? "Run is in progress."
        : state === "success"
          ? "Run completed successfully."
          : state === "aborted"
            ? "Run was aborted."
            : "Run failed.";
  const details = state === "failure" ? run?.errorMessage?.trim() : null;
  return (
    <output
      data-testid="automation-run-state"
      aria-live="polite"
      className={cn(
        "inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-[7px] border bg-card/90 px-2.5 py-1 text-[11px] font-medium leading-4 backdrop-blur",
        state === "success" && "border-success/35 text-success",
        state === "failure" && "border-destructive/40 text-destructive",
        state === "aborted" && "border-amber-500/40 text-amber-700 dark:text-amber-300",
        (state === "pending" || state === "running") && "border-border/70 text-muted-foreground",
      )}
    >
      {state === "pending" || state === "running" ? (
        <SpinnerGapIcon size={13} className="shrink-0 animate-spin" />
      ) : state === "success" ? (
        <CheckCircleIcon size={13} weight="fill" className="shrink-0" />
      ) : (
        <XCircleIcon size={13} weight="fill" className="shrink-0" />
      )}
      <span className="min-w-0 break-words">
        {label}: {copy}
      </span>
      {details ? (
        <details className="ml-1 max-w-full">
          <summary className="cursor-pointer font-normal underline underline-offset-2">Inspect details</summary>
          <pre className="absolute right-2 top-full z-40 mt-1 max-w-[320px] whitespace-pre-wrap break-words rounded-[7px] border border-border bg-card p-2 font-mono text-[10px] font-normal text-foreground shadow-lg">
            {details}
          </pre>
        </details>
      ) : null}
    </output>
  );
}

function textFromBuilderMessage(message: BuilderWebChatMessage): string {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return (
    normalizeBuilderDisplayText(text) || (questionBatchAnswerFromBuilderMessage(message) ? "Submitted answers" : "")
  );
}

const SETUP_NAME_LEAD_IN =
  /^(?:hey|hi|hello)?[\s,]*(?:sketch)?[\s,]*(?:please|can you|could you|can we|could we|i'?d like to|i would like to|i want to|i wanna|i need to|i need|help me|let'?s|lets|set ?up|create|build|make|configure|schedule)\b[\s,:-]*/i;

const SETUP_NAME_TAIL =
  /[.!?]| — |,? and (?:then |post|send|share|deliver|notify|save)| every | each | then | so that | so it /i;

function deriveSetupName(raw: string): string | null {
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  for (let index = 0; index < 3; index += 1) {
    const next = text.replace(SETUP_NAME_LEAD_IN, "").trim();
    if (next === text) break;
    text = next;
  }
  if (!text) return null;
  const cut = text.search(SETUP_NAME_TAIL);
  if (cut >= 12) text = text.slice(0, cut);
  text = text.trim().replace(/[\s,.;:—-]+$/, "");
  if (text.length > 52) {
    const clipped = text.slice(0, 52);
    const lastSpace = clipped.lastIndexOf(" ");
    text = `${clipped.slice(0, lastSpace > 24 ? lastSpace : 52).trim()}…`;
  }
  if (text.length < 3) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function deriveSetupNameFromMessages(messages: BuilderWebChatMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = textFromBuilderMessage(message).trim();
    if (!text || text === "Submitted answers" || /\bselected\.?$/i.test(text)) continue;
    const name = deriveSetupName(text);
    if (name) return name;
  }
  return null;
}

function normalizeBuilderDisplayText(text: string): string {
  if (!text.startsWith(BUILDER_MODE_SELECTION_MARKER)) return text;
  const modeMatch = text.match(/I chose the "(deterministic|hybrid|agent-led)" execution mode/);
  const mode = modeMatch?.[1];
  if (mode === "deterministic" || mode === "hybrid" || mode === "agent-led") {
    return `${automationExecutionModeMetadata[mode].label} selected.`;
  }
  const metadata = Object.values(automationExecutionModeMetadata).find((candidate) =>
    text.includes(`(${candidate.label})`),
  );
  return metadata ? `${metadata.label} selected.` : "Execution mode selected.";
}

function isBuilderNavigationProgressText(value: string): boolean {
  return /opening (?:the )?automation builder/i.test(value);
}

function progressLinesFromBuilderMessage(message: BuilderWebChatMessage): string[] {
  return message.parts.flatMap((part) =>
    part.type === "data-progress"
      ? part.data.lines.filter((line) => line.trim().length > 0 && !isBuilderNavigationProgressText(line))
      : [],
  );
}

function progressItemsFromBuilderMessage(message: BuilderWebChatMessage): ChatThreadProgressItem[] {
  return message.parts.flatMap((part) =>
    part.type === "data-progress"
      ? (part.data.items?.filter((item) => !isBuilderNavigationProgressText(item.label)) ?? [])
      : [],
  );
}

function timelineFromBuilderMessage(message: BuilderWebChatMessage): ChatThreadTimelineEntry[] {
  return message.parts.flatMap<ChatThreadTimelineEntry>((part, index) => {
    if (part.type === "text") {
      return part.text.trim() && !isBuilderNavigationProgressText(part.text)
        ? [{ type: "text", id: `text-${index}`, text: part.text }]
        : [];
    }
    if (part.type !== "data-progress") return [];
    const progressItems = part.data.items?.filter((item) => !isBuilderNavigationProgressText(item.label));
    const progressLines = part.data.lines.filter((line) => line.trim() && !isBuilderNavigationProgressText(line));
    if (!progressItems?.length && !progressLines.length) return [];
    return [{ type: "progress", id: part.id, progressItems, progressLines }];
  });
}

function filesFromBuilderMessage(message: BuilderWebChatMessage) {
  return message.parts
    .filter((part) => part.type === "data-file")
    .map((part) => part.data)
    .filter((file) => file.name.trim().length > 0 && file.url.trim().length > 0);
}

function automationsFromBuilderMessage(message: BuilderWebChatMessage): AutomationArtifact[] {
  return message.parts.filter((part) => part.type === "data-automation").map((part) => part.data);
}

function interruptionFromBuilderMessage(message: BuilderWebChatMessage): ChatThreadInterruption | undefined {
  const part = message.parts.find((candidate) => candidate.type === "data-interruption");
  return part?.data;
}

function questionFromBuilderMessage(message: BuilderWebChatMessage): WebChatQuestion | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part.type === "data-question") return part.data;
  }
  return undefined;
}

function questionBatchFromBuilderMessage(message: BuilderWebChatMessage): WebChatQuestionBatch | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part.type === "data-question-batch") return part.data;
  }
  return undefined;
}

function questionBatchAnswerFromBuilderMessage(message: BuilderWebChatMessage): WebChatQuestionBatchAnswer | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part.type === "data-question-batch-answer") return part.data;
  }
  return undefined;
}

function createdAtFromBuilderMessage(message: BuilderWebChatMessage): string | undefined {
  const value = message.createdAt;
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Date) return value.toISOString();
  return message.metadata?.createdAt?.trim() || undefined;
}

export function builderChatThreadMessages(messages: BuilderWebChatMessage[]): ChatThreadMessage[] {
  return messages.flatMap<ChatThreadMessage>((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const rawText = textFromBuilderMessage(message);
    const text = message.role === "assistant" && isBuilderNavigationProgressText(rawText) ? "" : rawText;
    const files = filesFromBuilderMessage(message);
    const automations: AutomationArtifact[] = [];
    const interruption = interruptionFromBuilderMessage(message);
    const question = message.role === "assistant" ? questionFromBuilderMessage(message) : undefined;
    const questionBatch = message.role === "assistant" ? questionBatchFromBuilderMessage(message) : undefined;
    const createdAt = createdAtFromBuilderMessage(message);
    const timeline = message.role === "assistant" ? timelineFromBuilderMessage(message) : [];
    const hasProgress = timeline.some((entry) => entry.type === "progress");
    if (text || files.length > 0 || automations.length > 0 || interruption || question || questionBatch) {
      return [
        {
          id: message.id,
          role: message.role,
          text: text || undefined,
          ...(hasProgress ? { timeline } : {}),
          createdAt,
          files: files.length > 0 ? files : undefined,
          automations: automations.length > 0 ? automations : undefined,
          ...(question ? { question } : {}),
          ...(questionBatch ? { questionBatch } : {}),
          interruption,
        },
      ];
    }
    if (message.role === "assistant") {
      const progressLines = progressLinesFromBuilderMessage(message);
      const progressItems = progressItemsFromBuilderMessage(message);
      if (progressLines.length > 0 || progressItems.length > 0) {
        return [
          {
            id: message.id,
            role: message.role,
            createdAt,
            timeline,
          },
        ];
      }
    }
    return [];
  });
}

function hasPendingBuilderAssistantProgress(messages: BuilderWebChatMessage[]): boolean {
  const latestMessage = messages.at(-1);
  if (!latestMessage || latestMessage.role !== "assistant") return false;
  const text = textFromBuilderMessage(latestMessage);
  const visibleText = isBuilderNavigationProgressText(text) ? "" : text;
  return (
    (progressLinesFromBuilderMessage(latestMessage).length > 0 ||
      progressItemsFromBuilderMessage(latestMessage).length > 0) &&
    !visibleText &&
    !interruptionFromBuilderMessage(latestMessage) &&
    filesFromBuilderMessage(latestMessage).length === 0 &&
    automationsFromBuilderMessage(latestMessage).length === 0 &&
    !questionFromBuilderMessage(latestMessage) &&
    !questionBatchFromBuilderMessage(latestMessage)
  );
}

function outgoingBuilderTextMessage(text: string, attachments: WebChatUploadedAttachment[] = []) {
  const metadata = { createdAt: new Date().toISOString() };
  if (attachments.length === 0) {
    return { text, metadata };
  }

  return {
    metadata,
    parts: [
      { type: "text" as const, text },
      ...attachments.map((attachment, index) => ({
        type: "data-file" as const,
        id: `attachment-${index}`,
        data: {
          name: attachment.name,
          url: attachment.url,
          mediaType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
        },
      })),
    ],
  };
}

export function outgoingBuilderQuestionAnswerMessage(
  question: WebChatQuestion,
  answer: WebChatQuestionOption | WebChatQuestionAnswer,
) {
  const payload: WebChatQuestionAnswer = "id" in answer ? { questionId: question.id, optionId: answer.id } : answer;
  const text =
    "optionId" in payload
      ? (question.options.find((option) => option.id === payload.optionId)?.label ?? payload.optionId)
      : payload.customResponse;
  return {
    metadata: { createdAt: new Date().toISOString() },
    parts: [
      { type: "text" as const, text },
      {
        type: "data-question-answer" as const,
        id: `question-answer-${question.id}`,
        data: payload,
      },
    ],
  };
}

export function outgoingBuilderQuestionBatchAnswerMessage(
  batch: WebChatQuestionBatch,
  answer: WebChatQuestionBatchAnswer | WebChatQuestionBatchAnswer["answers"],
) {
  const payload: WebChatQuestionBatchAnswer = Array.isArray(answer)
    ? { batchId: batch.batchId, answers: answer }
    : answer;
  const orderedAnswers = batch.questions.flatMap((question) => {
    const item = payload.answers.find((candidate) => candidate.questionId === question.id);
    return item ? [item] : [];
  });
  const orderedPayload =
    orderedAnswers.length === batch.questions.length ? { ...payload, answers: orderedAnswers } : payload;
  const labels = orderedPayload.answers.map((item) => {
    const question = batch.questions.find((candidate) => candidate.id === item.questionId);
    return "optionId" in item
      ? (question?.options.find((option) => option.id === item.optionId)?.label ?? item.optionId)
      : item.customResponse;
  });
  return {
    metadata: { createdAt: new Date().toISOString() },
    parts: [
      { type: "text" as const, text: labels.join(" · ") },
      {
        type: "data-question-batch-answer" as const,
        id: `question-batch-answer-${orderedPayload.batchId}`,
        data: orderedPayload,
      },
    ],
  };
}

function outgoingBuilderRequestOptions(
  taskId: string,
  attachments: WebChatUploadedAttachment[],
  authoringLease?: AutomationLeaseRequest | null,
) {
  return {
    body: {
      automationTaskId: taskId,
      ...(authoringLease ?? {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

const builderConversationQueryKey = (taskId: string, clientSessionId: string) =>
  ["scheduled-tasks", taskId, "conversations", clientSessionId] as const;

function replaceBuilderConversationCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  conversation: ScheduledTaskConversationSummary,
) {
  queryClient.setQueryData<ScheduledTaskConversationsResponse>(queryKey, (current) => {
    if (!current) return current;
    return {
      ...current,
      conversations: [
        conversation,
        ...current.conversations.filter((item) => item.conversationId !== conversation.conversationId),
      ],
    };
  });
}

function conversationDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function conversationDisplayTitle(
  conversation: ScheduledTaskConversationSummary,
  summary?: WebChatConversationSummary,
  derivedTitle?: string | null,
): string {
  const title = summary?.title.trim();
  if (title) return normalizeBuilderDisplayText(title);
  const derived = derivedTitle?.trim();
  if (derived) return normalizeBuilderDisplayText(derived);
  return conversation.kinds.includes("web_chat") ? "Source chat" : "Automation chat";
}

const CHAT_LIST_TITLE_MAX_WORDS = 6;
const CHAT_LIST_TITLE_MAX_CHARS = 34;
const CHAT_LIST_TITLE_TRAILING_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "for",
  "in",
  "on",
  "by",
  "with",
  "and",
  "or",
  "at",
  "from",
  "into",
  "as",
]);

/**
 * Brevity rule for chat-list rail titles. Backend/derived titles are often a
 * whole first-message sentence; the rail is narrow, so a CSS-truncated
 * "Only include accounts above $5k ARR in th…" reads as noise. This clamps any
 * title to a short headline — at most {@link CHAT_LIST_TITLE_MAX_WORDS} words /
 * {@link CHAT_LIST_TITLE_MAX_CHARS} chars, cut on a word boundary, trailing
 * stop-words ("… accounts by") dropped, no ellipsis — while the full title
 * stays on the row's hover tooltip.
 */
function shortConversationTitle(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= CHAT_LIST_TITLE_MAX_CHARS) return clean;
  const words: string[] = [];
  for (const word of clean.split(" ").slice(0, CHAT_LIST_TITLE_MAX_WORDS)) {
    const length = [...words, word].join(" ").length;
    if (words.length && length > CHAT_LIST_TITLE_MAX_CHARS) break;
    words.push(word);
  }
  while (words.length > 1 && CHAT_LIST_TITLE_TRAILING_STOPWORDS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  const out = words.join(" ") || clean.slice(0, CHAT_LIST_TITLE_MAX_CHARS);
  return out.replace(/[\s,.;:—-]+$/, "");
}

function conversationDisplayUpdatedAt(
  conversation: ScheduledTaskConversationSummary,
  summary?: WebChatConversationSummary,
): string {
  return summary?.updatedAt ?? conversation.lastActiveAt;
}

function builderChatMutationError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.code === "BUILDER_CHAT_LOCKED") {
    const lock = (error.details.builderLock ?? error.details.lock) as ScheduledTaskConversationLock | undefined;
    return lock?.owner === "self"
      ? "This automation is open in another window. Return to that window to continue the chat."
      : "This automation is being edited by another user. You can view it, but chat is read-only until they release it.";
  }
  if (error instanceof ApiRequestError && (error.status >= 500 || error.code === "LEASE_STALE")) {
    return "Sketch could not verify the editing session. Try again.";
  }
  return error instanceof Error ? error.message : fallback;
}

function BuilderChatSidecar({
  requestedConversationId,
  taskId,
  title,
  queryKey,
  executionMode,
  executionModeRecommendation,
  isSetupPlaceholder,
  executionModeSelection,
  originChat,
  onExecutionModeSelect,
  onExecutionModeSelectionHandled,
  onBusyChange,
  clientSessionId,
  authoringLease,
  onLeaseStale,
  open,
  onClose,
  className,
}: {
  requestedConversationId: string | null;
  taskId: string;
  title: string;
  queryKey: readonly unknown[];
  executionMode: AutomationExecutionMode | null;
  executionModeRecommendation: AutomationDefinition["executionModeRecommendation"];
  isSetupPlaceholder: boolean;
  executionModeSelection: ExecutionModeSelection | null;
  originChat: AutomationDefinition["originChat"];
  onExecutionModeSelect: (mode: AutomationExecutionMode) => void;
  onExecutionModeSelectionHandled: (selectionId: number) => void;
  onBusyChange: (busy: boolean) => void;
  clientSessionId: string;
  authoringLease: AutomationLeaseRequest | null;
  onLeaseStale: () => void;
  open: boolean;
  onClose: () => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const conversationsQueryKey = useMemo(
    () => builderConversationQueryKey(taskId, clientSessionId),
    [clientSessionId, taskId],
  );
  const conversationsQuery = useQuery({
    queryKey: conversationsQueryKey,
    queryFn: () =>
      api.scheduledTasks.conversations(taskId, {
        includeArchived: true,
        clientSessionId,
      }),
    refetchInterval: AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
  const webChatConversationsQuery = useQuery({
    queryKey: [...WEB_CHAT_CONVERSATIONS_QUERY_KEY, "include-builder"],
    queryFn: () => api.webChat.conversations({ includeBuilder: true }),
    staleTime: 30_000,
  });
  const webChatSummaryById = useMemo(
    () => new Map((webChatConversationsQuery.data?.conversations ?? []).map((summary) => [summary.id, summary])),
    [webChatConversationsQuery.data],
  );
  const sessionQuery = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => api.auth.session(),
    staleTime: 5 * 60_000,
  });
  const currentUserName = sessionQuery.data?.name ?? null;
  /**
   * Teammate builder chats have no title we can read (the web-chat summary is
   * per-user), so they'd fall back to a generic "Automation chat". Derive a real
   * name from each teammate chat's first message — the same heuristic the setup
   * pill uses — via the task-scoped messages endpoint (readable by owner/admin/
   * editor). Own chats keep their backend summary title; this only fills the gap.
   */
  const conversationsNeedingDerivedTitle = useMemo(() => {
    const conversations = conversationsQuery.data?.conversations ?? [];
    return conversations.filter((conversation) => {
      if (!conversation.kinds.includes("builder")) return false;
      if (webChatSummaryById.get(conversation.conversationId)?.title?.trim()) return false;
      const creator = conversation.transcriptUserName?.trim();
      return Boolean(creator) && creator !== (currentUserName ?? "").trim();
    });
  }, [conversationsQuery.data?.conversations, webChatSummaryById, currentUserName]);
  const derivedTitleQueries = useQueries({
    queries: conversationsNeedingDerivedTitle.map((conversation) => ({
      queryKey: ["builder-derived-title", taskId, conversation.conversationId],
      queryFn: () => api.scheduledTasks.conversationMessages(taskId, conversation.conversationId),
      staleTime: 5 * 60_000,
      retry: false,
      select: (data: { messages: unknown[] }) =>
        deriveSetupNameFromMessages((data.messages ?? []) as BuilderWebChatMessage[]),
    })),
  });
  const derivedTitleById = useMemo(() => {
    const map = new Map<string, string>();
    conversationsNeedingDerivedTitle.forEach((conversation, index) => {
      const name = derivedTitleQueries[index]?.data;
      if (name) map.set(conversation.conversationId, name);
    });
    return map;
  }, [conversationsNeedingDerivedTitle, derivedTitleQueries]);
  const pendingSelectionLeaseRef = useRef<AutomationLeaseRequest | null>(null);
  const visibleConversations = useMemo(() => {
    const conversations = conversationsQuery.data?.conversations ?? [];
    const builderConversations = conversations.filter((conversation) => conversation.kinds.includes("builder"));
    if (builderConversations.length === 0 || !requestedConversationId) {
      return builderConversations.length > 0 ? builderConversations : conversations;
    }

    const requestedConversation = conversations.find(
      (conversation) => conversation.conversationId === requestedConversationId,
    );
    if (!requestedConversation || requestedConversation.kinds.includes("builder")) return builderConversations;
    return [...builderConversations, requestedConversation];
  }, [conversationsQuery.data?.conversations, requestedConversationId]);
  const selectedConversation = visibleConversations.find(
    (conversation) => conversation.conversationId === requestedConversationId,
  );
  const initialBuilderConversationId = useMemo(() => {
    const builderConversations = visibleConversations.filter((conversation) => conversation.kinds.includes("builder"));
    return builderConversations.reduce<ScheduledTaskConversationSummary | null>((oldest, conversation) => {
      if (!oldest) return conversation;
      return new Date(conversation.createdAt).getTime() < new Date(oldest.createdAt).getTime() ? conversation : oldest;
    }, null)?.conversationId;
  }, [visibleConversations]);
  const originContextQuery = useQuery({
    queryKey: ["automation-origin-context", taskId, originChat?.platform, originChat?.conversationId],
    queryFn: async (): Promise<BuilderSourceContextMessage[]> => {
      if (!originChat?.conversationId) return [];
      if (originChat.platform === "web") {
        const response = await api.webChat.messages(originChat.conversationId);
        return sourceContextMessagesFromWebChat(response.messages);
      }
      const response = await api.scheduledTasks.originChatMessages(taskId);
      return sourceContextMessagesFromProvider(response.messages);
    },
    enabled: Boolean(
      requestedConversationId &&
        selectedConversation?.state === "active" &&
        selectedConversation.kinds.includes("builder"),
    ),
    staleTime: 30_000,
  });

  const openConversation = useCallback(
    (conversationId: string) => {
      void navigate({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId },
        search: { conversationId },
        replace: true,
      });
    },
    [navigate, taskId],
  );
  const openChatList = useCallback(() => {
    void navigate({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId },
      search: {},
      replace: true,
    });
  }, [navigate, taskId]);
  const [chatListOpen, setChatListOpen] = useState(false);

  const createMutation = useMutation({
    mutationFn: () => {
      if (!authoringLease) throw new Error("Acquire the automation editing session before starting a chat");
      pendingSelectionLeaseRef.current = authoringLease;
      return api.scheduledTasks.createConversation(taskId, { createNew: true, ...authoringLease });
    },
    onSuccess: ({ conversation }) => {
      if (!sameLease(pendingSelectionLeaseRef.current, authoringLease)) return;
      replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
      setChatListOpen(false);
      openConversation(conversation.conversationId);
    },
    onError: (error) => toast.error(builderChatMutationError(error, "Could not start a chat")),
  });
  const selectMutation = useMutation({
    mutationFn: (conversation: ScheduledTaskConversationSummary) => {
      if (!authoringLease) {
        return Promise.reject(new Error("Acquire the automation editing session before opening a chat"));
      }
      pendingSelectionLeaseRef.current = authoringLease;
      return api.scheduledTasks.selectConversation(
        taskId,
        conversation.conversationId,
        conversation.kinds[0],
        authoringLease,
      );
    },
    onSuccess: ({ conversation }) => {
      if (!sameLease(pendingSelectionLeaseRef.current, authoringLease)) return;
      replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
      setChatListOpen(false);
      openConversation(conversation.conversationId);
    },
    onError: (error) => {
      if (isLeaseStaleError(error)) onLeaseStale();
      toast.error(builderChatMutationError(error, "This chat is unavailable"));
    },
  });
  const restoreMutation = useMutation({
    mutationFn: (conversationId: string) =>
      api.scheduledTasks.archiveConversation(taskId, conversationId, false, authoringLease ?? undefined),
    onSuccess: ({ conversation }) => {
      replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not restore this chat"),
  });
  const archiveMutation = useMutation({
    mutationFn: (conversationId: string) =>
      api.scheduledTasks.archiveConversation(taskId, conversationId, true, authoringLease ?? undefined),
    onSuccess: ({ conversation }) => {
      replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
      const archivedId = conversation.conversationId;
      toast("Chat archived", {
        action: { label: "Undo", onClick: () => restoreMutation.mutate(archivedId) },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not archive this chat"),
  });

  const selectConversationFromList = useCallback(
    (conversation: ScheduledTaskConversationSummary) => {
      if (conversation.conversationId === requestedConversationId) {
        setChatListOpen(false);
        return;
      }
      const isTeammateChat = Boolean(
        conversation.transcriptUserName && conversation.transcriptUserName.trim() !== (currentUserName ?? "").trim(),
      );
      if (conversation.state === "archived" || !authoringLease || isTeammateChat) {
        setChatListOpen(false);
        openConversation(conversation.conversationId);
        return;
      }
      selectMutation.mutate(conversation);
    },
    [authoringLease, currentUserName, openConversation, requestedConversationId, selectMutation],
  );
  const selectedIsArchived = selectedConversation?.state === "archived";
  const selectedIsViewOnly = Boolean(
    selectedConversation?.transcriptUserName &&
      selectedConversation.transcriptUserName.trim() !== (currentUserName ?? "").trim(),
  );
  const inList = !requestedConversationId || chatListOpen;
  const selectingConversationId = selectMutation.isPending ? (selectMutation.variables?.conversationId ?? null) : null;
  return (
    <aside
      id="automation-builder-chat-sidecar"
      data-testid="automation-builder-chat-sidecar"
      aria-label="Automation chats"
      aria-hidden={!open}
      inert={!open}
      data-state={open ? "open" : "closed"}
      className={cn(
        builderSidebarFrameClass,
        "left-0 border-r",
        open
          ? `translate-x-0 border-border/80 ${builderSidebarWidthClass}`
          : "pointer-events-none -translate-x-full border-transparent lg:w-0 lg:min-w-0 lg:max-w-0",
        className,
      )}
    >
      <div
        className={cn(
          builderSidebarContentClass,
          builderSidebarWidthClass,
          open ? "lg:translate-x-0" : "lg:-translate-x-full",
        )}
      >
        <BuilderChatHeader
          mode={inList ? "list" : "transcript"}
          switcher={
            selectedConversation ? (
              <BuilderChatSwitcher
                currentConversation={selectedConversation}
                currentTitle={conversationDisplayTitle(
                  selectedConversation,
                  webChatSummaryById.get(selectedConversation.conversationId),
                  derivedTitleById.get(selectedConversation.conversationId),
                )}
                conversations={visibleConversations}
                summaryById={webChatSummaryById}
                derivedTitleById={derivedTitleById}
                currentUserName={currentUserName}
                canEdit={Boolean(authoringLease)}
                newPending={createMutation.isPending}
                selectingId={selectingConversationId}
                onSelect={selectConversationFromList}
                onNew={() => createMutation.mutate()}
                onArchive={(conversation) => archiveMutation.mutate(conversation.conversationId)}
                onSeeAll={() => setChatListOpen(true)}
              />
            ) : null
          }
          onNewChat={() => createMutation.mutate()}
          newChatPending={createMutation.isPending}
          newChatDisabled={!authoringLease}
          onClose={onClose}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {conversationsQuery.isError ? (
            <BuilderChatNavigationError onRetry={() => void conversationsQuery.refetch()} />
          ) : conversationsQuery.isLoading || !conversationsQuery.data ? (
            <BuilderChatLoadingState />
          ) : inList ? (
            <BuilderChatListView
              conversations={visibleConversations}
              builderLock={conversationsQuery.data.builderLock}
              summaryById={webChatSummaryById}
              derivedTitleById={derivedTitleById}
              currentUserName={currentUserName}
              canEdit={Boolean(authoringLease)}
              onSelect={selectConversationFromList}
              onArchive={(conversation) => archiveMutation.mutate(conversation.conversationId)}
              onRestore={(conversation) => restoreMutation.mutate(conversation.conversationId)}
              selectingConversationId={selectingConversationId}
            />
          ) : !selectedConversation ? (
            <BuilderChatUnavailableState onBack={openChatList} />
          ) : selectedIsArchived ? (
            <BuilderChatArchivedState
              onBack={openChatList}
              onRestore={() => restoreMutation.mutate(selectedConversation.conversationId)}
              restoring={restoreMutation.isPending}
              canRestore={Boolean(authoringLease)}
            />
          ) : (
            <BuilderChatTranscript
              key={selectedConversation.conversationId}
              conversationId={selectedConversation.conversationId}
              conversationKind={selectedConversation.kinds[0]}
              taskId={taskId}
              title={title}
              queryKey={queryKey}
              conversationsQueryKey={conversationsQueryKey}
              executionMode={executionMode}
              executionModeRecommendation={executionModeRecommendation}
              isSetupPlaceholder={isSetupPlaceholder}
              isInitialBuilderConversation={selectedConversation.conversationId === initialBuilderConversationId}
              executionModeSelection={executionModeSelection}
              originContextMessages={originContextQuery.data ?? []}
              originContextLoading={originContextQuery.isPending && Boolean(originChat?.conversationId)}
              authoringLease={authoringLease}
              onLeaseStale={onLeaseStale}
              onExecutionModeSelect={onExecutionModeSelect}
              onExecutionModeSelectionHandled={onExecutionModeSelectionHandled}
              onBusyChange={onBusyChange}
              onBack={openChatList}
              viewOnly={selectedIsViewOnly}
              viewOnlyOwnerName={selectedConversation.transcriptUserName ?? null}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

function BuilderChatHeader({
  mode,
  switcher,
  onNewChat,
  newChatPending,
  newChatDisabled,
  onClose,
}: {
  mode: "transcript" | "list";
  switcher?: ReactNode;
  onNewChat?: () => void;
  newChatPending?: boolean;
  newChatDisabled?: boolean;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="automation-builder-chat-header"
      className="shrink-0 border-b border-border/80 bg-background/95 px-2 py-2.5 backdrop-blur"
    >
      <div className="flex h-9 min-w-0 items-center gap-1">
        {mode === "transcript" ? (
          switcher
        ) : (
          <>
            <span className="min-w-0 flex-1 px-1 text-[13px] font-semibold leading-5 text-foreground">Chats</span>
            {onNewChat ? (
              <IconTooltip label={newChatDisabled ? "Request control to start a new chat" : "New chat"}>
                <span className={cn("inline-flex", newChatDisabled && "cursor-not-allowed")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    data-testid="automation-builder-new-chat"
                    className={cn(
                      canvasCompactIconButtonClass,
                      "size-7 shrink-0",
                      newChatDisabled && "pointer-events-none",
                    )}
                    aria-label="New chat"
                    onClick={onNewChat}
                    disabled={newChatDisabled || newChatPending}
                  >
                    {newChatPending ? <SpinnerGapIcon size={16} className="animate-spin" /> : <PlusIcon size={16} />}
                  </Button>
                </span>
              </IconTooltip>
            ) : null}
          </>
        )}
        <IconTooltip label="Collapse chat">
          <Button
            size="icon"
            variant="ghost"
            className={cn(canvasCompactIconButtonClass, "ml-auto size-7 shrink-0")}
            aria-label="Collapse automation chat"
            aria-controls="automation-builder-chat-sidecar"
            onClick={onClose}
          >
            <SidebarSimpleIcon size={16} />
          </Button>
        </IconTooltip>
      </div>
    </div>
  );
}

function BuilderChatSwitchRow({
  conversation,
  summary,
  derivedTitle,
  isCurrent,
  currentUserName,
  onSelect,
  onArchive,
  onRestore,
  selecting,
  disabled,
}: {
  conversation: ScheduledTaskConversationSummary;
  summary?: WebChatConversationSummary;
  derivedTitle?: string | null;
  isCurrent: boolean;
  currentUserName?: string | null;
  onSelect: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
  selecting?: boolean;
  disabled?: boolean;
}) {
  const fullConversationTitle = conversationDisplayTitle(conversation, summary, derivedTitle);
  const conversationTitle = shortConversationTitle(fullConversationTitle);
  const isArchived = conversation.state === "archived";
  const rawCreator = conversation.transcriptUserName?.trim();
  const isOwn = !rawCreator || rawCreator === (currentUserName ?? "").trim();
  const creatorLabel = isOwn ? "You" : (rawCreator as string);
  const dateLabel = conversationDateLabel(conversationDisplayUpdatedAt(conversation, summary));
  const canArchive = !isArchived && !isCurrent && Boolean(onArchive);
  const canRestore = isArchived && Boolean(onRestore);
  const showAction = canArchive || canRestore;
  return (
    <div
      data-testid={`automation-builder-conversation-${conversation.conversationId}`}
      className={cn(
        "group/row relative flex w-full items-center rounded-[8px] transition-colors duration-100 ease-out",
        isCurrent ? "bg-accent" : "hover:bg-accent",
      )}
    >
      <button
        type="button"
        aria-label={`Open ${isArchived ? "archived " : ""}chat: ${fullConversationTitle}, by ${creatorLabel}`}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-[3px] rounded-[8px] px-[10px] py-2 text-left outline-none transition-[padding] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60",
          showAction ? "group-hover/row:pr-9 group-focus-within/row:pr-9" : null,
        )}
        onClick={onSelect}
        disabled={disabled}
      >
        <span
          title={fullConversationTitle}
          className={cn(
            "block truncate text-sm font-medium leading-5",
            isArchived ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {conversationTitle}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
          <span className="truncate">{creatorLabel}</span>
          <span aria-hidden className="shrink-0 text-muted-foreground/60">
            ·
          </span>
          <span className="shrink-0 tabular-nums">{dateLabel}</span>
          {selecting ? <SpinnerGapIcon size={12} className="ml-0.5 shrink-0 animate-spin" /> : null}
        </span>
      </button>
      {showAction ? (
        <IconTooltip label={canRestore ? "Restore chat" : "Archive chat"}>
          <button
            type="button"
            aria-label={`${canRestore ? "Restore" : "Archive"} chat: ${fullConversationTitle}`}
            className="pointer-events-none absolute right-[6px] top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-[6px] bg-background/80 text-muted-foreground opacity-0 shadow-sm outline-none backdrop-blur-sm transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:pointer-events-auto group-hover/row:opacity-100"
            onClick={canRestore ? onRestore : onArchive}
          >
            {canRestore ? <ArrowClockwiseIcon size={16} /> : <ArchiveIcon size={16} />}
          </button>
        </IconTooltip>
      ) : null}
    </div>
  );
}

function BuilderNewChatButton({
  onNew,
  pending,
  disabled,
}: {
  onNew: () => void;
  pending: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="automation-builder-new-chat-menu"
      onClick={onNew}
      disabled={disabled || pending}
      className="flex w-full items-center gap-2.5 rounded-[8px] px-[10px] py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center text-muted-foreground">
        {pending ? <SpinnerGapIcon size={16} className="animate-spin" /> : <PlusIcon size={16} />}
      </span>
      <span className="text-[13px] font-medium text-foreground">New chat</span>
    </button>
  );
}

function BuilderChatSwitcher({
  currentConversation,
  currentTitle,
  conversations,
  summaryById,
  derivedTitleById,
  currentUserName,
  canEdit,
  newPending,
  selectingId,
  onSelect,
  onNew,
  onArchive,
  onSeeAll,
}: {
  currentConversation?: ScheduledTaskConversationSummary;
  currentTitle: string | null;
  conversations: ScheduledTaskConversationSummary[];
  summaryById: ReadonlyMap<string, WebChatConversationSummary>;
  derivedTitleById: ReadonlyMap<string, string>;
  currentUserName?: string | null;
  canEdit: boolean;
  newPending: boolean;
  selectingId: string | null;
  onSelect: (conversation: ScheduledTaskConversationSummary) => void;
  onNew: () => void;
  onArchive: (conversation: ScheduledTaskConversationSummary) => void;
  onSeeAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const RECENT = 6;
  const active = conversations.filter((conversation) => conversation.state === "active");
  const currentId = currentConversation?.conversationId;
  const ordered = currentConversation
    ? [currentConversation, ...active.filter((conversation) => conversation.conversationId !== currentId)]
    : active;
  const recent = ordered.slice(0, RECENT);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="automation-builder-chat-switcher"
          className="flex min-w-0 items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-left transition-colors hover:bg-muted/70 data-[state=open]:bg-muted/70"
          aria-label="Switch or start a chat"
        >
          <span
            title={currentTitle ?? undefined}
            className="min-w-0 truncate text-[13px] font-semibold leading-5 text-foreground"
          >
            {currentTitle}
          </span>
          <CaretDownIcon size={13} className="shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[300px] rounded-[12px] p-1.5">
        <BuilderNewChatButton
          onNew={() => {
            setOpen(false);
            onNew();
          }}
          pending={newPending}
          disabled={!canEdit}
        />
        <p className="px-[10px] pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
          Recent chats
        </p>
        <div className="flex flex-col gap-0.5">
          {recent.map((conversation) => (
            <BuilderChatSwitchRow
              key={conversation.conversationId}
              conversation={conversation}
              summary={summaryById.get(conversation.conversationId)}
              derivedTitle={derivedTitleById.get(conversation.conversationId)}
              isCurrent={conversation.conversationId === currentId}
              currentUserName={currentUserName}
              selecting={selectingId === conversation.conversationId}
              onSelect={() => {
                setOpen(false);
                onSelect(conversation);
              }}
              onArchive={canEdit ? () => onArchive(conversation) : undefined}
            />
          ))}
        </div>
        <button
          type="button"
          className="mt-0.5 flex w-full items-center gap-1 rounded-[8px] px-[10px] py-2 text-left text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
          onClick={() => {
            setOpen(false);
            onSeeAll();
          }}
        >
          <span className="flex-1">See all chats ({conversations.length})</span>
          <CaretRightIcon size={14} className="shrink-0" />
        </button>
      </PopoverContent>
    </Popover>
  );
}

function BuilderChatListView({
  conversations,
  builderLock,
  summaryById,
  derivedTitleById,
  currentUserName,
  canEdit,
  onSelect,
  onArchive,
  onRestore,
  selectingConversationId,
}: {
  conversations: ScheduledTaskConversationSummary[];
  builderLock?: ScheduledTaskConversationLock;
  summaryById: ReadonlyMap<string, WebChatConversationSummary>;
  derivedTitleById: ReadonlyMap<string, string>;
  currentUserName?: string | null;
  canEdit: boolean;
  onSelect: (conversation: ScheduledTaskConversationSummary) => void;
  onArchive: (conversation: ScheduledTaskConversationSummary) => void;
  onRestore: (conversation: ScheduledTaskConversationSummary) => void;
  selectingConversationId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [ownerFilter, setOwnerFilter] = useState<"everyone" | "mine">("everyone");
  const [filterOpen, setFilterOpen] = useState(false);
  const needle = query.trim().toLowerCase();
  const matches = (conversation: ScheduledTaskConversationSummary) =>
    needle.length === 0 ||
    conversationDisplayTitle(
      conversation,
      summaryById.get(conversation.conversationId),
      derivedTitleById.get(conversation.conversationId),
    )
      .toLowerCase()
      .includes(needle);
  const isOwnConversation = (conversation: ScheduledTaskConversationSummary) => {
    const creator = conversation.transcriptUserName?.trim();
    return !creator || creator === (currentUserName ?? "").trim();
  };
  const scoped = ownerFilter === "mine" ? conversations.filter(isOwnConversation) : conversations;
  const activeAll = scoped.filter((conversation) => conversation.state === "active");
  const archivedAll = scoped.filter((conversation) => conversation.state === "archived");
  const list = (tab === "active" ? activeAll : archivedAll).filter(matches);
  const lockedByOther = builderLock?.state === "held" && builderLock.owner !== "self";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pt-2.5">
        <div className="flex items-center gap-2 rounded-[8px] bg-muted/50 px-2.5 py-1.5">
          <MagnifyingGlassIcon size={16} className="shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-2 py-2">
        <div
          role="tablist"
          aria-label="Chat status"
          className="inline-flex items-center rounded-[8px] bg-muted/50 p-0.5"
        >
          {(["active", "archived"] as const).map((value) => {
            const selected = tab === value;
            const count = value === "active" ? activeAll.length : archivedAll.length;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(value)}
                className={cn(
                  "rounded-[6px] px-2.5 py-1 text-[12px] font-medium capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value}{" "}
                <span className={cn("tabular-nums", selected ? "text-muted-foreground" : "text-muted-foreground/70")}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <FiltersMenu
          open={filterOpen}
          onOpenChange={setFilterOpen}
          activeCount={ownerFilter === "mine" ? 1 : 0}
          activeSummary={ownerFilter === "mine" ? "Only mine" : undefined}
          ariaLabel="Filter chats"
          testId="builder-chat-creator-filter"
          onReset={() => setOwnerFilter("everyone")}
          resetTestId="builder-chat-creator-filter-clear"
          contentClassName="w-[220px]"
        >
          <FilterSegments
            label="Creator"
            value={ownerFilter}
            onChange={setOwnerFilter}
            options={[
              { value: "everyone", label: "Everyone" },
              { value: "mine", label: "Only mine" },
            ]}
          />
        </FiltersMenu>
      </div>
      {builderLock?.state === "held" && builderLock.owner !== "self" ? (
        <div className="px-2 pb-2">
          <BuilderChatLockNotice lock={builderLock} />
        </div>
      ) : null}
      <div className="chat-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
        <div className="flex flex-col gap-0.5">
          {list.length > 0 ? (
            list.map((conversation) => (
              <BuilderChatSwitchRow
                key={conversation.conversationId}
                conversation={conversation}
                summary={summaryById.get(conversation.conversationId)}
                derivedTitle={derivedTitleById.get(conversation.conversationId)}
                isCurrent={false}
                currentUserName={currentUserName}
                selecting={selectingConversationId === conversation.conversationId}
                onSelect={() => onSelect(conversation)}
                onArchive={tab === "active" && canEdit ? () => onArchive(conversation) : undefined}
                onRestore={tab === "archived" && canEdit ? () => onRestore(conversation) : undefined}
              />
            ))
          ) : (
            <p className="px-3 pt-8 text-center text-[13px] leading-5 text-muted-foreground">
              {tab === "active"
                ? needle.length > 0
                  ? "No active chats match your search."
                  : ownerFilter === "mine"
                    ? "You haven't started any chats yet."
                    : lockedByOther
                      ? "No chats yet."
                      : "No chats yet — use ＋ above to start one."
                : needle.length > 0
                  ? "No archived chats match your search."
                  : "No archived chats."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function BuilderChatLockNotice({ lock }: { lock: ScheduledTaskConversationLock }) {
  return (
    <div
      data-testid="automation-builder-chat-lock-notice"
      className="mx-2.5 border-l-2 border-amber-500/70 pl-3 text-[12px] leading-5 text-muted-foreground"
    >
      <p className="font-medium text-foreground">Chat is read-only</p>
      <p>Someone else is editing. Request control above to make changes.</p>
    </div>
  );
}

function BuilderChatNavigationError({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-testid="automation-builder-chat-error" className="flex min-h-full items-center justify-center px-5 py-6">
      <div className="w-full border-l-2 border-destructive/70 pl-4">
        <p className="text-[13px] font-semibold text-foreground">Chats unavailable</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          Sketch could not load the task chat history. Your automation is still available.
        </p>
        <Button size="sm" variant="outline" className={cn(canvasToolbarButtonClass, "mt-3")} onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function BuilderChatUnavailableState({ onBack }: { onBack: () => void }) {
  return (
    <div
      data-testid="automation-builder-chat-unavailable"
      className="flex min-h-full items-center justify-center px-5 py-6"
    >
      <div className="w-full border-l border-border pl-4">
        <p className="text-[13px] font-semibold text-foreground">Chat unavailable</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          This chat is not associated with this automation for your account, so its transcript was not opened.
        </p>
        <Button size="sm" variant="outline" className={cn(canvasToolbarButtonClass, "mt-3")} onClick={onBack}>
          Back to chats
        </Button>
      </div>
    </div>
  );
}

function BuilderChatLockState({
  locked,
  onBack,
  onRetry,
}: {
  locked: boolean;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <div data-testid="automation-builder-chat-locked" className="flex min-h-full items-center justify-center px-5 py-6">
      <div className="w-full border-l-2 border-amber-500/70 pl-4">
        <p className="text-[13px] font-semibold text-foreground">
          {locked ? "Chat is read-only" : "Chat temporarily unavailable"}
        </p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          {locked
            ? "Someone else is editing. Request control above, then try again."
            : "Sketch could not confirm editing access. Refresh and try again before sending a message."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className={canvasToolbarButtonClass} onClick={onRetry}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" className={canvasGhostButtonClass} onClick={onBack}>
            Back to chats
          </Button>
        </div>
      </div>
    </div>
  );
}

function BuilderChatArchivedState({
  onBack,
  onRestore,
  restoring,
  canRestore,
}: {
  onBack: () => void;
  onRestore: () => void;
  restoring: boolean;
  canRestore: boolean;
}) {
  return (
    <div
      data-testid="automation-builder-chat-archived"
      className="flex min-h-full items-center justify-center px-5 py-6"
    >
      <div className="w-full border-l border-border pl-4">
        <p className="text-[13px] font-semibold text-foreground">Chat archived</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          This chat is kept for history but is not active. Restore it explicitly to continue the transcript.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            className={cn(canvasPrimaryButtonClass, "gap-1.5")}
            onClick={onRestore}
            disabled={restoring || !canRestore}
          >
            {restoring ? <SpinnerGapIcon size={14} className="animate-spin" /> : <ArrowClockwiseIcon size={14} />}
            Restore chat
          </Button>
          <Button size="sm" variant="outline" className={canvasToolbarButtonClass} onClick={onBack}>
            Back to chats
          </Button>
        </div>
      </div>
    </div>
  );
}

type BuilderChatLockStatus = "loading" | "ready" | "locked" | "error";

const BUILDER_CHAT_LOCK_RENEWAL_INTERVAL_MS = 60_000;

function BuilderChatTranscript({
  conversationId,
  conversationKind,
  taskId,
  title,
  queryKey,
  conversationsQueryKey,
  executionMode,
  executionModeRecommendation,
  isSetupPlaceholder,
  isInitialBuilderConversation,
  executionModeSelection,
  originContextMessages,
  originContextLoading,
  authoringLease,
  onLeaseStale,
  onExecutionModeSelect,
  onExecutionModeSelectionHandled,
  onBusyChange,
  onBack,
  viewOnly,
  viewOnlyOwnerName,
}: {
  conversationId: string;
  conversationKind: ScheduledTaskConversationKind;
  taskId: string;
  title: string;
  queryKey: readonly unknown[];
  conversationsQueryKey: readonly unknown[];
  executionMode: AutomationExecutionMode | null;
  executionModeRecommendation: AutomationDefinition["executionModeRecommendation"];
  isSetupPlaceholder: boolean;
  isInitialBuilderConversation: boolean;
  executionModeSelection: ExecutionModeSelection | null;
  originContextMessages: BuilderSourceContextMessage[];
  originContextLoading: boolean;
  authoringLease: AutomationLeaseRequest | null;
  onLeaseStale: () => void;
  onExecutionModeSelect: (mode: AutomationExecutionMode) => void;
  onExecutionModeSelectionHandled: (selectionId: number) => void;
  onBusyChange: (busy: boolean) => void;
  onBack: () => void;
  viewOnly: boolean;
  viewOnlyOwnerName: string | null;
}) {
  const queryClient = useQueryClient();
  const { toolProgress, pendingToolProgress, changeToolProgress } = useWebChatProgressSettings();
  const [lockStatus, setLockStatus] = useState<BuilderChatLockStatus>("loading");
  const [loadedHistoryKey, setLoadedHistoryKey] = useState<string | null>(null);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const [historyLoadAttempt, setHistoryLoadAttempt] = useState(0);
  const [stoppingRun, setStoppingRun] = useState(false);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const wasBusyRef = useRef(false);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<BuilderWebChatMessage>({
        api: `/api/web-chat?conversationId=${encodeURIComponent(conversationId)}`,
      }),
    [conversationId],
  );
  const chat = useChat<BuilderWebChatMessage>({
    id: conversationId,
    transport,
  });
  const selectBuilderConversation = useCallback(
    async (isCancelled?: () => boolean) => {
      setLockStatus("loading");
      if (!authoringLease || viewOnly) {
        setLockStatus("ready");
        return;
      }
      try {
        const { conversation } = await api.scheduledTasks.selectConversation(
          taskId,
          conversationId,
          conversationKind,
          authoringLease,
        );
        if (isCancelled?.()) return;
        replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
        setLockStatus("ready");
      } catch (error: unknown) {
        if (isCancelled?.()) return;
        if (isLeaseStaleError(error)) onLeaseStale();
        setLockStatus(error instanceof ApiRequestError && error.code === "BUILDER_CHAT_LOCKED" ? "locked" : "error");
      }
    },
    [
      authoringLease,
      conversationId,
      conversationKind,
      conversationsQueryKey,
      onLeaseStale,
      queryClient,
      taskId,
      viewOnly,
    ],
  );
  useEffect(() => {
    let cancelled = false;
    void selectBuilderConversation(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [selectBuilderConversation]);

  const lockReady = lockStatus === "ready";
  const historyKey = `${conversationId}:${historyLoadAttempt}`;
  const historyReady = lockReady && loadedHistoryKey === historyKey;
  const hasBackgroundRun = hasPendingBuilderAssistantProgress(chat.messages);
  const chatBusy = chat.status === "submitted" || chat.status === "streaming" || hasBackgroundRun || stoppingRun;
  const threadMessages = builderChatThreadMessages(chat.messages);
  const transcriptMessages = threadMessages;
  useEffect(() => {
    onBusyChange(chatBusy);
    return () => onBusyChange(false);
  }, [chatBusy, onBusyChange]);
  const latestMessage = chat.messages.at(-1);
  const threadScrollKey = latestMessage
    ? [
        latestMessage.id,
        latestMessage.role,
        textFromBuilderMessage(latestMessage).length,
        progressLinesFromBuilderMessage(latestMessage).join("\n").length,
        filesFromBuilderMessage(latestMessage).length,
        automationsFromBuilderMessage(latestMessage).length,
        questionFromBuilderMessage(latestMessage)?.id ?? "",
        questionBatchFromBuilderMessage(latestMessage)
          ? questionBatchSignature(questionBatchFromBuilderMessage(latestMessage) as WebChatQuestionBatch)
          : "",
        questionBatchAnswerFromBuilderMessage(latestMessage)?.batchId ?? "",
        chat.status,
      ].join(":")
    : "";
  useEffect(() => {
    if (!executionModeSelection || !historyReady || chatBusy) return;
    const { mode } = executionModeSelection;
    const modeMessage = `${BUILDER_MODE_SELECTION_MARKER} I chose the "${mode}" execution mode (${automationExecutionModeMetadata[mode].label}) for this automation. Please continue by asking the next relevant automation questions.`;
    void chat.sendMessage(
      outgoingBuilderTextMessage(modeMessage),
      outgoingBuilderRequestOptions(taskId, [], authoringLease),
    );
    onExecutionModeSelectionHandled(executionModeSelection.id);
  }, [
    authoringLease,
    chat.sendMessage,
    chatBusy,
    executionModeSelection,
    historyReady,
    onExecutionModeSelectionHandled,
    taskId,
  ]);
  const sendBuilderMessage = useCallback(
    (value: string, attachments: WebChatUploadedAttachment[] = []) => {
      void chat.sendMessage(
        outgoingBuilderTextMessage(value, attachments),
        outgoingBuilderRequestOptions(taskId, attachments, authoringLease),
      );
    },
    [authoringLease, chat.sendMessage, taskId],
  );
  const selectBuilderQuestion = useCallback(
    (question: WebChatQuestion, answer: WebChatQuestionOption | WebChatQuestionAnswer) => {
      void chat.sendMessage(
        outgoingBuilderQuestionAnswerMessage(question, answer),
        outgoingBuilderRequestOptions(taskId, [], authoringLease),
      );
    },
    [authoringLease, chat.sendMessage, taskId],
  );

  const submitBuilderQuestionBatch = useCallback(
    (batch: WebChatQuestionBatch, answer: WebChatQuestionBatchAnswer) => {
      void chat.sendMessage(
        outgoingBuilderQuestionBatchAnswerMessage(batch, answer),
        outgoingBuilderRequestOptions(taskId, [], authoringLease),
      );
    },
    [authoringLease, chat.sendMessage, taskId],
  );

  const loadMessagesForReconciliation = useCallback(
    async (targetConversationId: string, signal: AbortSignal) => {
      const response = await api.scheduledTasks.conversationMessages(taskId, targetConversationId, { signal });
      return { ...response, messages: response.messages as BuilderWebChatMessage[] };
    },
    [taskId],
  );
  useWebChatReconciliation({
    conversationId,
    historyReady,
    status: chat.status,
    error: chat.error,
    messages: chat.messages,
    hasPendingProgress: hasPendingBuilderAssistantProgress,
    loadMessages: loadMessagesForReconciliation,
    setMessages: chat.setMessages,
    clearError: chat.clearError,
    mergeMessages: mergeProgressMessageSnapshots,
  });

  useEffect(() => {
    let cancelled = false;
    if (!lockReady) {
      setLoadedHistoryKey(null);
      setHistoryLoadError(null);
      chat.setMessages([]);
      return () => {
        cancelled = true;
      };
    }
    setLoadedHistoryKey(null);
    setHistoryLoadError(null);
    chat.setMessages([]);
    void api.scheduledTasks
      .conversationMessages(taskId, conversationId)
      .then(({ messages }) => {
        if (!cancelled) chat.setMessages(messages as BuilderWebChatMessage[]);
      })
      .catch((error: unknown) => {
        if (!cancelled) setHistoryLoadError(error instanceof Error ? error.message : "Transcript unavailable");
      })
      .finally(() => {
        if (!cancelled) setLoadedHistoryKey(historyKey);
      });
    return () => {
      cancelled = true;
    };
  }, [chat.setMessages, conversationId, historyKey, lockReady, taskId]);

  useEffect(() => {
    if (!lockReady || !authoringLease || viewOnly) return;
    const timer = window.setInterval(() => {
      void api.scheduledTasks
        .selectConversation(taskId, conversationId, conversationKind, authoringLease)
        .then(({ conversation }) => {
          replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
        })
        .catch((error: unknown) => {
          if (isLeaseStaleError(error)) onLeaseStale();
          setLockStatus(error instanceof ApiRequestError && error.code === "BUILDER_CHAT_LOCKED" ? "locked" : "error");
        });
    }, BUILDER_CHAT_LOCK_RENEWAL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [
    authoringLease,
    conversationId,
    conversationKind,
    conversationsQueryKey,
    lockReady,
    onLeaseStale,
    queryClient,
    taskId,
    viewOnly,
  ]);

  useEffect(() => {
    if (!historyReady || !threadScrollKey) return;
    const frameId = window.requestAnimationFrame(() => {
      const el = threadScrollRef.current;
      if (!el) return;
      if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      else el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [historyReady, threadScrollKey]);

  useEffect(() => {
    const busy = chat.status === "submitted" || chat.status === "streaming";
    if (busy) {
      wasBusyRef.current = true;
      return;
    }
    if (!historyReady || !wasBusyRef.current) return;
    wasBusyRef.current = false;
    void invalidateAutomationQueries(queryClient, [taskId]);
    void queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
  }, [chat.status, conversationsQueryKey, historyReady, queryClient, taskId]);

  const handleStop = useCallback(() => {
    if (stoppingRun) return;
    setStoppingRun(true);
    void api.webChat
      .interrupt(conversationId, taskId, authoringLease)
      .catch(() => undefined)
      .finally(() => setStoppingRun(false));
  }, [authoringLease, conversationId, stoppingRun, taskId]);

  if (lockStatus === "locked" || lockStatus === "error") {
    return (
      <BuilderChatLockState
        locked={lockStatus === "locked"}
        onBack={onBack}
        onRetry={() => void selectBuilderConversation()}
      />
    );
  }

  return (
    <>
      <div ref={threadScrollRef} className="chat-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-4">
        {historyReady && !historyLoadError && chat.messages.length === 0 ? (
          <div className="mb-6 space-y-5">
            {originContextLoading ? <BuilderSourceContextLoading /> : null}
            {originContextMessages.length > 0 ? <BuilderSourceContext messages={originContextMessages} /> : null}
            {!isSetupPlaceholder || originContextMessages.length > 0 ? (
              <SketchMessage>
                <AutomationSetupCard
                  mode={executionMode}
                  recommendation={executionModeRecommendation}
                  onSelect={onExecutionModeSelect}
                />
              </SketchMessage>
            ) : (
              <AutomationDescriptionPrompt />
            )}
          </div>
        ) : null}
        {!historyReady ? (
          <BuilderChatLoadingState />
        ) : historyLoadError ? (
          <div
            data-testid="automation-builder-transcript-error"
            className="flex min-h-full items-center justify-center"
          >
            <div className="w-full border-l border-border pl-4">
              <p className="text-[13px] font-semibold text-foreground">Transcript unavailable</p>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                This chat is associated with the task, but its transcript could not be loaded.
              </p>
              <Button
                size="sm"
                variant="outline"
                className={cn(canvasToolbarButtonClass, "mt-3")}
                onClick={() => setHistoryLoadAttempt((attempt) => attempt + 1)}
              >
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <ChatThread
            className="mt-4 gap-4"
            messages={transcriptMessages}
            busy={chatBusy}
            error={chat.error?.message ?? null}
            conversationId={conversationId}
            onAnswerQuestion={selectBuilderQuestion}
            onSubmitQuestionBatch={submitBuilderQuestionBatch}
          />
        )}
      </div>
      <div className="relative shrink-0 bg-background px-3 py-3">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent"
        />
        {viewOnly ? (
          <div className="rounded-lg bg-muted/40 px-3 py-2.5 text-[12px] leading-5 text-muted-foreground">
            <span className="font-medium text-foreground">Read-only.</span> You're viewing{" "}
            {viewOnlyOwnerName ?? "a teammate"}'s chat — start a new chat to make changes.
          </div>
        ) : (
          <ChatInput
            key={conversationId}
            disabled={!historyReady || Boolean(historyLoadError) || chatBusy}
            disabledPlaceholder={chatBusy ? "" : historyReady ? "Transcript unavailable" : "Loading conversation..."}
            running={chatBusy}
            runningPlaceholder="Sketch is thinking..."
            rendererValue={pendingToolProgress ?? toolProgress}
            rendererSaving={pendingToolProgress !== null}
            rendererOptions={WEB_CHAT_PROGRESS_MODES}
            onRendererChange={changeToolProgress}
            stopping={stoppingRun}
            onStop={handleStop}
            placeholder="Reply to Sketch..."
            onSubmit={sendBuilderMessage}
          />
        )}
      </div>
    </>
  );
}

function BuilderChatLoadingState() {
  return (
    <div className="flex min-h-full items-center justify-center px-3 text-[13px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <SpinnerGapIcon size={15} className="animate-spin" />
        Loading chat…
      </div>
    </div>
  );
}

function BuilderSourceContext({ messages }: { messages: BuilderSourceContextMessage[] }) {
  return (
    <div data-testid="automation-builder-source-context" className="space-y-2">
      <div className="ml-[36px] flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
        <span className="h-px w-5 bg-border/80" aria-hidden />
        <span>From the originating chat</span>
      </div>
      {messages.map((message) => (
        <UserMessage key={message.id}>
          <p className="whitespace-pre-wrap">{message.text}</p>
        </UserMessage>
      ))}
    </div>
  );
}

function BuilderSourceContextLoading() {
  return (
    <output
      data-testid="automation-builder-source-context-loading"
      className="ml-[36px] flex items-center gap-2 text-[12px] text-muted-foreground"
    >
      <span className="automation-builder-source-context-dot" aria-hidden />
      <span>Bringing in your web-chat request…</span>
    </output>
  );
}

function AutomationDescriptionPrompt() {
  return (
    <SketchMessage>
      <div className="max-w-[640px] border-l border-brand-accent pl-4">
        <p className="text-[15px] font-semibold leading-6 text-foreground">What should this automation do?</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          Describe the workflow in your own words. You can include what starts it and what Sketch should do.
        </p>
      </div>
    </SketchMessage>
  );
}

function usesDefaultPosition(step: WorkflowStep): boolean {
  return Math.abs(step.position.x) <= 10 && Math.abs(step.position.y) <= 10;
}

function usesGeneratedColumnPosition(step: WorkflowStep, index: number): boolean {
  return Math.abs(step.position.x) <= 10 && Math.abs(step.position.y - index * 100) <= 10;
}

function shouldAutoLayoutWorkflow(steps: WorkflowStep[]): boolean {
  if (steps.length === 0) return false;
  return steps.every(usesDefaultPosition) || steps.every((step, index) => usesGeneratedColumnPosition(step, index));
}

function layoutWorkflowPositions(
  steps: WorkflowStep[],
  edges: WorkflowEdge[],
): Record<string, { x: number; y: number }> {
  const stepIds = new Set(steps.map((step) => step.id));
  const indexById = new Map(steps.map((step, index) => [step.id, index]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();

  for (const step of steps) incoming.set(step.id, 0);
  for (const edge of edges) {
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const roots = steps
    .filter((step) => (incoming.get(step.id) ?? 0) === 0)
    .sort((left, right) => {
      if (left.type === "trigger" && right.type !== "trigger") return -1;
      if (right.type === "trigger" && left.type !== "trigger") return 1;
      return (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0);
    });
  const queue = roots.map((step) => step.id);
  const levels = new Map<string, number>(queue.map((id) => [id, 0]));
  const remainingIncoming = new Map(incoming);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    const currentLevel = levels.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, currentLevel + 1));
      remainingIncoming.set(next, Math.max(0, (remainingIncoming.get(next) ?? 0) - 1));
      if (remainingIncoming.get(next) === 0) queue.push(next);
    }
  }

  for (const step of steps) {
    if (!levels.has(step.id)) levels.set(step.id, Math.max(0, indexById.get(step.id) ?? 0));
  }

  const groups = new Map<number, WorkflowStep[]>();
  for (const step of steps) {
    const level = levels.get(step.id) ?? 0;
    groups.set(level, [...(groups.get(level) ?? []), step]);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [level, group] of groups) {
    const sorted = [...group].sort((left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0));
    for (const [index, step] of sorted.entries()) {
      positions[step.id] = {
        x: level * 245,
        y: (index - (sorted.length - 1) / 2) * 110,
      };
    }
  }

  return positions;
}

function flowPosition(
  step: WorkflowStep,
  layoutPositions: Record<string, { x: number; y: number }>,
  shouldUseLayout: boolean,
) {
  return shouldUseLayout ? (layoutPositions[step.id] ?? step.position) : step.position;
}

type ExecutionActivity = "run" | "test" | null;

function selectedStepOutput(step: WorkflowStep, run: AutomationRunRecord | null): StepOutput | undefined {
  if (!run) return undefined;
  const output = run.stepOutputs[step.id];
  if (output || step.type !== "trigger" || run.triggerData == null) return output;
  return { output: run.triggerData, status: "completed", duration_ms: 0 };
}

function outputStatus(output: StepOutput | undefined, isExecuting: boolean): UiStatus {
  if (isExecuting) return "running";
  if (!output) return "idle";
  if (output.status === "completed") return "success";
  if (output.status === "failed") return "failed";
  return "skipped";
}

function executionOrder(steps: WorkflowStep[], edges: WorkflowEdge[]): WorkflowStep[] {
  const executionSteps = steps.filter((step) => step.type !== "trigger");
  if (edges.length === 0) return executionSteps;

  const byId = new Map(steps.map((step) => [step.id, step]));
  const indegree = new Map(steps.map((step) => [step.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0);
  const ordered: WorkflowStep[] = [];
  while (queue.length > 0) {
    const step = queue.shift();
    if (!step) continue;
    ordered.push(step);
    for (const nextId of outgoing.get(step.id) ?? []) {
      const nextCount = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextCount);
      if (nextCount === 0) {
        const nextStep = byId.get(nextId);
        if (nextStep) queue.push(nextStep);
      }
    }
  }

  return ordered.length === steps.length ? ordered.filter((step) => step.type !== "trigger") : executionSteps;
}

function inferredRunningStepId(
  steps: WorkflowStep[],
  edges: WorkflowEdge[],
  stepOutputs: Record<string, StepOutput>,
  runStatus: string | undefined,
): string | null {
  if (runStatus !== "running") return null;
  return executionOrder(steps, edges).find((step) => !stepOutputs[step.id])?.id ?? null;
}

type BuilderNodeData = {
  step: WorkflowStep;
  selected: boolean;
  status: UiStatus;
  executionActivity: ExecutionActivity;
  visual: StepVisual;
};
type BuilderNode = Node<BuilderNodeData>;

type StepVisualKind =
  | "schedule-trigger"
  | "webhook-trigger"
  | "canvas-trigger"
  | "slack-channel-message-trigger"
  | "agent"
  | "gmail-action"
  | "sheets-action"
  | "slack-action"
  | "whatsapp-action"
  | "google-action"
  | "web-action"
  | "code-action";

interface StepVisual {
  kind: StepVisualKind;
  icon: ComponentType<IconProps>;
  shape: "notched" | "rounded" | "circle";
  toneClass: string;
  glyphClass: string;
}

const stepVisuals: Record<StepVisualKind, StepVisual> = {
  "schedule-trigger": {
    kind: "schedule-trigger",
    icon: CalendarDotsIcon,
    shape: "notched",
    toneClass: "border-border/80 bg-muted/80",
    glyphClass: "text-muted-foreground",
  },
  "webhook-trigger": {
    kind: "webhook-trigger",
    icon: WebhooksLogoIcon,
    shape: "notched",
    toneClass: "border-cyan-300/70 bg-cyan-50 dark:border-cyan-300/30 dark:bg-cyan-950/50",
    glyphClass: "text-cyan-700 dark:text-cyan-200",
  },
  "canvas-trigger": {
    kind: "canvas-trigger",
    icon: GitBranchIcon,
    shape: "notched",
    toneClass: "border-violet-300/70 bg-violet-50 dark:border-violet-300/30 dark:bg-violet-950/50",
    glyphClass: "text-violet-700 dark:text-violet-200",
  },
  "slack-channel-message-trigger": {
    kind: "slack-channel-message-trigger",
    icon: SlackLogoIcon,
    shape: "notched",
    toneClass: "border-fuchsia-300/70 bg-fuchsia-50 dark:border-fuchsia-300/30 dark:bg-fuchsia-950/50",
    glyphClass: "text-fuchsia-700 dark:text-fuchsia-200",
  },
  agent: {
    kind: "agent",
    icon: RobotIcon,
    shape: "rounded",
    toneClass: "border-border/80 bg-card",
    glyphClass: "text-foreground/80",
  },
  "gmail-action": {
    kind: "gmail-action",
    icon: EnvelopeSimpleIcon,
    shape: "circle",
    toneClass: "border-red-300/70 bg-red-50 dark:border-red-300/30 dark:bg-red-950/50",
    glyphClass: "text-red-700 dark:text-red-200",
  },
  "sheets-action": {
    kind: "sheets-action",
    icon: TableIcon,
    shape: "circle",
    toneClass: "border-emerald-300/70 bg-emerald-50 dark:border-emerald-300/30 dark:bg-emerald-950/50",
    glyphClass: "text-emerald-700 dark:text-emerald-200",
  },
  "slack-action": {
    kind: "slack-action",
    icon: SlackLogoIcon,
    shape: "circle",
    toneClass: "border-fuchsia-300/70 bg-fuchsia-50 dark:border-fuchsia-300/30 dark:bg-fuchsia-950/50",
    glyphClass: "text-fuchsia-700 dark:text-fuchsia-200",
  },
  "whatsapp-action": {
    kind: "whatsapp-action",
    icon: WhatsappLogoIcon,
    shape: "circle",
    toneClass: "border-green-300/70 bg-green-50 dark:border-green-300/30 dark:bg-green-950/50",
    glyphClass: "text-green-700 dark:text-green-200",
  },
  "google-action": {
    kind: "google-action",
    icon: GoogleLogoIcon,
    shape: "circle",
    toneClass: "border-blue-300/70 bg-blue-50 dark:border-blue-300/30 dark:bg-blue-950/50",
    glyphClass: "text-blue-700 dark:text-blue-200",
  },
  "web-action": {
    kind: "web-action",
    icon: GlobeHemisphereWestIcon,
    shape: "circle",
    toneClass: "border-sky-300/70 bg-sky-50 dark:border-sky-300/30 dark:bg-sky-950/50",
    glyphClass: "text-sky-700 dark:text-sky-200",
  },
  "code-action": {
    kind: "code-action",
    icon: CodeIcon,
    shape: "circle",
    toneClass: "border-border/70 bg-muted/70",
    glyphClass: "text-foreground/80",
  },
};

function stepSignalText(step: WorkflowStep, content: AutomationStepContent | undefined): string {
  return [
    step.type,
    step.id,
    step.label,
    step.icon,
    step.triggerConfig?.type,
    step.triggerConfig?.componentKey,
    step.triggerConfig?.app,
    ...(content?.apps ?? []),
    content?.content.slice(0, 1400),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function resolveStepVisual(step: WorkflowStep, content: AutomationStepContent | undefined): StepVisual {
  if (step.type === "trigger") {
    if (step.triggerConfig?.type === "webhook") return stepVisuals["webhook-trigger"];
    if (step.triggerConfig?.type === "canvas") return stepVisuals["canvas-trigger"];
    if (step.triggerConfig?.type === "slack_channel_message") return stepVisuals["slack-channel-message-trigger"];
    return stepVisuals["schedule-trigger"];
  }

  if (step.type === "agent") return stepVisuals.agent;

  const signal = stepSignalText(step, content);
  if (/\b(google-sheets|sheets|spreadsheet|sheet)\b/.test(signal)) return stepVisuals["sheets-action"];
  if (/\b(gmail|email|mail)\b/.test(signal)) return stepVisuals["gmail-action"];
  if (/\b(slack)\b/.test(signal)) return stepVisuals["slack-action"];
  if (/\b(whatsapp|wa-)\b/.test(signal)) return stepVisuals["whatsapp-action"];
  if (/\b(google|drive|docs|calendar)\b/.test(signal)) return stepVisuals["google-action"];
  if (/\b(http|web|url|api)\b/.test(signal)) return stepVisuals["web-action"];
  return stepVisuals["code-action"];
}

function AutomationCanvas({
  draft,
  selectedStepId,
  isRunInspectorOpen,
  stepOutputs,
  runStatus,
  testingStepId,
  isSetupPlaceholder,
  isBuilderChatBusy,
  readOnly,
  onSelectStep,
  onUpdateStepPositions,
}: {
  draft: DraftAutomation;
  selectedStepId: string | null;
  isRunInspectorOpen: boolean;
  stepOutputs: Record<string, StepOutput>;
  runStatus?: string;
  testingStepId: string | null;
  isSetupPlaceholder: boolean;
  isBuilderChatBusy: boolean;
  readOnly: boolean;
  onSelectStep: (stepId: string | null) => void;
  onUpdateStepPositions: (positions: Record<string, { x: number; y: number }>) => void;
}) {
  return (
    <ReactFlowProvider>
      <AutomationCanvasFlow
        draft={draft}
        selectedStepId={selectedStepId}
        isRunInspectorOpen={isRunInspectorOpen}
        stepOutputs={stepOutputs}
        runStatus={runStatus}
        testingStepId={testingStepId}
        isSetupPlaceholder={isSetupPlaceholder}
        isBuilderChatBusy={isBuilderChatBusy}
        readOnly={readOnly}
        onSelectStep={onSelectStep}
        onUpdateStepPositions={onUpdateStepPositions}
      />
    </ReactFlowProvider>
  );
}

function AutomationBuilderPlaceholder({
  isSetupPlaceholder,
  running,
}: {
  isSetupPlaceholder: boolean;
  running: boolean;
}) {
  const authoringInProgress = isSetupPlaceholder && running;

  if (isSetupPlaceholder) {
    return (
      <div data-testid="automation-builder-graph-loading" className="automation-builder-forming" aria-hidden>
        <svg className="automation-builder-forming-edges" viewBox="0 0 520 280" fill="none" aria-hidden="true">
          <path
            className="automation-builder-forming-edge automation-builder-forming-edge-1"
            pathLength={1}
            d="M150 154C172 154 163 86 185 86"
          />
          <path
            className="automation-builder-forming-edge automation-builder-forming-edge-2"
            pathLength={1}
            d="M335 86C357 86 348 154 370 154"
          />
          <path
            className="automation-builder-forming-comet"
            pathLength={1}
            d="M150 154C172 154 163 86 185 86L335 86C357 86 348 154 370 154"
          />
          <circle className="automation-builder-forming-dot automation-builder-forming-dot-1" cx="150" cy="154" r="3" />
          <circle className="automation-builder-forming-dot automation-builder-forming-dot-1" cx="185" cy="86" r="3" />
          <circle className="automation-builder-forming-dot automation-builder-forming-dot-2" cx="335" cy="86" r="3" />
          <circle className="automation-builder-forming-dot automation-builder-forming-dot-2" cx="370" cy="154" r="3" />
        </svg>
        <div className="automation-builder-forming-node automation-builder-forming-node-1">
          <span className="automation-builder-forming-icon">
            <LightningIcon size={15} weight="fill" />
          </span>
          <span className="automation-builder-forming-bar" />
        </div>
        <div className="automation-builder-forming-node automation-builder-forming-node-2">
          <span className="automation-builder-forming-icon">
            <RobotIcon size={15} weight="fill" />
          </span>
          <span className="automation-builder-forming-bar" />
        </div>
        <div className="automation-builder-forming-node automation-builder-forming-node-3">
          <span className="automation-builder-forming-icon">
            <CheckCircleIcon size={15} weight="fill" />
          </span>
          <span className="automation-builder-forming-bar" />
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={isSetupPlaceholder ? "automation-builder-graph-loading" : undefined}
      className="w-full max-w-[520px] text-left"
    >
      <div
        className={cn(
          "automation-builder-empty-diagram mb-5",
          authoringInProgress && "automation-builder-empty-diagram-loading",
        )}
        aria-hidden
      >
        <div className="automation-builder-empty-diagram-meta">
          <span>Workflow preview</span>
          <span className="automation-builder-empty-diagram-meta-status">
            {authoringInProgress ? "Assembling steps" : "Awaiting setup"}
          </span>
        </div>
        <svg className="automation-builder-empty-edges" viewBox="0 0 520 280" fill="none" aria-hidden="true">
          <path
            className="automation-builder-empty-edge automation-builder-empty-edge-track"
            d="M150 140C174 140 165 92 185 92"
          />
          <path
            className="automation-builder-empty-edge automation-builder-empty-edge-track"
            d="M335 92C355 92 346 164 370 164"
          />
          <path
            className="automation-builder-empty-edge automation-builder-empty-edge-progress automation-builder-empty-edge-progress-one"
            d="M150 140C174 140 165 92 185 92"
          />
          <path
            className="automation-builder-empty-edge automation-builder-empty-edge-progress automation-builder-empty-edge-progress-two"
            d="M335 92C355 92 346 164 370 164"
          />
          <circle className="automation-builder-empty-edge-junction" cx="150" cy="140" r="3" />
          <circle className="automation-builder-empty-edge-junction" cx="185" cy="92" r="3" />
          <circle className="automation-builder-empty-edge-junction" cx="335" cy="92" r="3" />
          <circle className="automation-builder-empty-edge-junction" cx="370" cy="164" r="3" />
        </svg>
        <div className="automation-builder-empty-node automation-builder-empty-node-trigger">
          <span className="automation-builder-empty-node-icon">
            <LightningIcon size={15} weight="fill" />
          </span>
          <span>
            <strong>Trigger</strong>
            <small>Start event</small>
          </span>
        </div>
        <div className="automation-builder-empty-node automation-builder-empty-node-action">
          <span className="automation-builder-empty-node-icon">
            <RobotIcon size={15} weight="fill" />
          </span>
          <span>
            <strong>Action</strong>
            <small>Workflow logic</small>
          </span>
        </div>
        <div className="automation-builder-empty-node automation-builder-empty-node-delivery">
          <span className="automation-builder-empty-node-icon">
            <CheckCircleIcon size={15} weight="fill" />
          </span>
          <span>
            <strong>Delivery</strong>
            <small>Final output</small>
          </span>
        </div>
      </div>
      <div className="border-l border-brand-accent pl-5">
        {authoringInProgress ? (
          <div className="flex items-center gap-2 text-[12px] font-medium text-brand-accent">
            <span className="automation-builder-scribble-status-dot" />
            <span>Composing automation</span>
          </div>
        ) : null}
        <p
          className={cn(
            "mt-2 text-sm font-semibold text-foreground",
            authoringInProgress && "automation-builder-typewriter",
          )}
        >
          {authoringInProgress
            ? "Building your workflow"
            : isSetupPlaceholder
              ? "Workflow canvas"
              : "No workflow steps yet"}
        </p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {authoringInProgress
            ? "Sketch is applying your answers to the workflow canvas."
            : isSetupPlaceholder
              ? "Your workflow will appear here as you configure it in the chat."
              : "Ask Sketch to add the first workflow step in the chat."}
        </p>
      </div>
    </div>
  );
}

function AutomationCanvasFlow({
  draft,
  selectedStepId,
  isRunInspectorOpen,
  stepOutputs,
  runStatus,
  testingStepId,
  isSetupPlaceholder,
  isBuilderChatBusy,
  readOnly,
  onSelectStep,
  onUpdateStepPositions,
}: {
  draft: DraftAutomation;
  selectedStepId: string | null;
  isRunInspectorOpen: boolean;
  stepOutputs: Record<string, StepOutput>;
  runStatus?: string;
  testingStepId: string | null;
  isSetupPlaceholder: boolean;
  isBuilderChatBusy: boolean;
  readOnly: boolean;
  onSelectStep: (stepId: string | null) => void;
  onUpdateStepPositions: (positions: Record<string, { x: number; y: number }>) => void;
}) {
  const { fitView } = useReactFlow<BuilderNode>();
  const nodesInitialized = useNodesInitialized();
  const isDrawerOpen = selectedStepId !== null;
  const lastFitViewRequestKey = useRef<string | null>(null);
  const layoutPositions = useMemo(() => layoutWorkflowPositions(draft.steps, draft.edges), [draft.edges, draft.steps]);
  const shouldUseLayout = useMemo(() => shouldAutoLayoutWorkflow(draft.steps), [draft.steps]);
  const inferredRunStepId = useMemo(
    () => inferredRunningStepId(draft.steps, draft.edges, stepOutputs, runStatus),
    [draft.edges, draft.steps, runStatus, stepOutputs],
  );
  const executingStepId = testingStepId ?? inferredRunStepId;
  const executionActivity: ExecutionActivity = testingStepId ? "test" : inferredRunStepId ? "run" : null;
  const topologyKey = useMemo(
    () =>
      [
        draft.steps.map((step) => step.id).join(","),
        draft.edges.map((edge) => `${edge.from}:${edge.to}`).join(","),
      ].join("|"),
    [draft.edges, draft.steps],
  );
  const fitViewRequestKey = `${topologyKey}:${isDrawerOpen ? "drawer" : isRunInspectorOpen ? "runs" : "canvas"}`;
  const initialNodes = useMemo<BuilderNode[]>(
    () =>
      draft.steps.map((step) => ({
        id: step.id,
        type: step.type,
        position: flowPosition(step, layoutPositions, shouldUseLayout),
        data: {
          step,
          selected: step.id === selectedStepId,
          status: outputStatus(stepOutputs[step.id], step.id === executingStepId),
          executionActivity: step.id === executingStepId ? executionActivity : null,
          visual: resolveStepVisual(step, draft.stepContent[step.id]),
        },
      })),
    [
      draft.stepContent,
      draft.steps,
      executingStepId,
      executionActivity,
      layoutPositions,
      selectedStepId,
      shouldUseLayout,
      stepOutputs,
    ],
  );
  const initialEdges = useMemo<Edge[]>(
    () =>
      draft.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        animated: edge.to === executingStepId,
        className: cn("automation-builder-edge", edge.to === executingStepId && "automation-builder-edge-active"),
        interactionWidth: 22,
        style:
          edge.to === executingStepId
            ? { ...flowEdgeStyle, stroke: connectionLineStyle.stroke, strokeWidth: 1.8, opacity: 1 }
            : flowEdgeStyle,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edge.to === executingStepId ? connectionLineStyle.stroke : flowEdgeStyle.stroke,
          width: 16,
          height: 16,
        },
      })),
    [draft.edges, executingStepId],
  );
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<BuilderNode>(initialNodes);
  const onNodesChange = useCallback(
    (changes: NodeChange<BuilderNode>[]) => {
      onNodesChangeBase(changes.filter((change) => change.type !== "remove" && change.type !== "add"));
    },
    [onNodesChangeBase],
  );

  useEffect(() => setNodes(initialNodes), [initialNodes, setNodes]);
  useEffect(() => {
    if (!nodesInitialized || lastFitViewRequestKey.current === fitViewRequestKey) return;
    lastFitViewRequestKey.current = fitViewRequestKey;
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      void fitView({ padding: 0.12, maxZoom: 1.1, duration: reducedMotion ? 0 : 180 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, fitViewRequestKey, nodesInitialized]);

  if (draft.steps.length === 0) {
    return (
      <div className="relative size-full overflow-hidden">
        <div className="automation-builder-empty-grid pointer-events-none absolute inset-0" aria-hidden />
        <div
          data-testid="automation-builder-empty-canvas"
          className="automation-builder-empty-state relative z-[1] flex size-full items-center justify-center bg-transparent px-6 pb-36 text-center"
        >
          <AutomationBuilderPlaceholder isSetupPlaceholder={isSetupPlaceholder} running={isBuilderChatBusy} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative size-full">
      <ReactFlow
        nodes={nodes}
        edges={initialEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => onSelectStep(node.id)}
        onNodeDragStop={(_, node) => {
          onUpdateStepPositions(
            Object.fromEntries(
              nodes.map((currentNode) => [
                currentNode.id,
                currentNode.id === node.id ? node.position : currentNode.position,
              ]),
            ),
          );
        }}
        onPaneClick={() => onSelectStep(null)}
        nodesDraggable={!readOnly}
        nodesConnectable={false}
        edgesReconnectable={false}
        nodesFocusable
        edgesFocusable={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
        minZoom={0.3}
        maxZoom={1.8}
        snapToGrid
        snapGrid={[18, 18]}
        connectionLineStyle={connectionLineStyle}
        connectionRadius={28}
        proOptions={{ hideAttribution: true }}
        className="automation-builder-flow automation-builder-flow-ready"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="var(--automation-builder-grid)" />
        <Controls showInteractive={false} position="bottom-left" className="automation-builder-controls" />
      </ReactFlow>
    </div>
  );
}

const statusMarkerClasses: Record<UiStatus, string> = {
  idle: "border-muted-foreground/70",
  running: "text-amber-700 dark:text-amber-300",
  success: "text-emerald-700 dark:text-emerald-300",
  failed: "text-destructive",
  skipped: "border-muted-foreground/45",
};

const nodeAccentClasses: Record<UiStatus, string> = {
  idle: "from-muted-foreground/[0.1] to-transparent",
  running: "from-brand-accent/[0.18] to-transparent",
  success: "from-emerald-500/[0.16] to-transparent",
  failed: "from-destructive/[0.16] to-transparent",
  skipped: "from-muted-foreground/[0.06] to-transparent",
};

function nodeStatusLabel(status: UiStatus, activity: ExecutionActivity): string {
  if (status === "running") return activity === "test" ? "Testing" : "Running";
  if (status === "success") return "Succeeded";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "No result";
}

function StepStatusMarker({ status }: { status: UiStatus }) {
  if (status === "failed") {
    return (
      <span
        aria-hidden
        data-testid="automation-node-status-marker"
        className={cn(
          "absolute -top-2 -right-2 z-20 flex size-[18px] items-center justify-center bg-transparent drop-shadow-sm",
          statusMarkerClasses.failed,
        )}
      >
        <XCircleIcon size={18} weight="fill" />
      </span>
    );
  }
  if (status === "success") {
    return (
      <span
        aria-hidden
        data-testid="automation-node-status-marker"
        className={cn(
          "absolute -top-2 -right-2 z-20 flex size-[18px] items-center justify-center bg-transparent drop-shadow-sm",
          statusMarkerClasses.success,
        )}
      >
        <CheckCircleIcon size={18} weight="fill" />
      </span>
    );
  }
  if (status === "running") {
    return (
      <span
        aria-hidden
        data-testid="automation-node-status-marker"
        className={cn(
          "absolute -top-2 -right-2 z-20 flex size-[18px] items-center justify-center bg-transparent drop-shadow-sm",
          statusMarkerClasses.running,
        )}
      >
        <SpinnerGapIcon size={17} className="animate-spin" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-testid="automation-node-status-marker"
      className={cn(
        "absolute -top-[5px] left-1/2 z-20 size-[8px] -translate-x-1/2 rounded-full border-2 bg-transparent ring-[2px] ring-background",
        statusMarkerClasses[status],
      )}
    />
  );
}

function StepShape({ visual, selected, status }: { visual: StepVisual; selected: boolean; status: UiStatus }) {
  const Icon = visual.icon;
  const triggerShape =
    visual.shape === "notched"
      ? ({ clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)" } as CSSProperties)
      : undefined;
  return (
    <div className="relative size-[46px]">
      <div
        data-testid="automation-node-shell"
        className={cn(
          "automation-node-shell relative flex size-full items-center justify-center overflow-hidden border text-foreground/75 transition-[border-color,background-color,box-shadow,transform]",
          "before:absolute before:inset-0 before:bg-linear-to-br before:from-foreground/[0.045] before:to-transparent before:content-['']",
          visual.toneClass,
          nodeAccentClasses[status],
          status === "failed" ? "automation-node-failed shadow-none" : "shadow-lg",
          status === "running" && "automation-node-running",
          visual.shape === "notched" ? "rounded-[9px]" : visual.shape === "circle" ? "rounded-full" : "rounded-[11px]",
          selected
            ? status === "failed"
              ? "border-destructive/70 bg-destructive/[0.08] text-foreground shadow-none"
              : "border-brand-accent/70 bg-accent text-foreground shadow-md ring-2 ring-brand-accent/20"
            : "hover:border-foreground/30 hover:bg-muted/80 hover:text-foreground",
        )}
        style={triggerShape}
      >
        <Icon
          size={visual.kind === "agent" ? 18 : 17}
          weight={visual.shape === "notched" || visual.kind === "agent" ? "fill" : "regular"}
          className={cn("relative z-10", visual.glyphClass)}
        />
      </div>
      <StepStatusMarker status={status} />
    </div>
  );
}

function BuilderStepNode({ data, isConnectable }: NodeProps<BuilderNode>) {
  const statusLabel = nodeStatusLabel(data.status, data.executionActivity);
  return (
    <div
      data-testid={`automation-node-${data.step.id}`}
      data-state={data.status}
      data-execution-activity={data.executionActivity ?? undefined}
      aria-label={`${data.step.label}: ${statusLabel}`}
      className="group/node flex w-[164px] select-none flex-col items-center gap-2"
    >
      <div className="relative">
        {data.step.type !== "trigger" ? (
          <Handle
            type="target"
            position={Position.Left}
            isConnectable={isConnectable}
            className="automation-builder-handle !left-[-4px]"
          />
        ) : null}
        <StepShape visual={data.visual} selected={data.selected} status={data.status} />
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={isConnectable}
          className="automation-builder-handle !right-[-4px]"
        />
      </div>
      <span
        title={data.step.label}
        className="line-clamp-2 max-w-[164px] text-center text-[11px] font-semibold leading-4 text-foreground/80 transition-colors group-hover/node:text-foreground"
      >
        {data.step.label}
      </span>
      <span className="sr-only">{statusLabel}</span>
    </div>
  );
}

const nodeTypes = {
  trigger: BuilderStepNode,
  agent: BuilderStepNode,
  action: BuilderStepNode,
};

type RunStatusFilter = "all" | "completed" | "failed";
type AutomationRunOrigin = "automatic" | "manual" | "test";
type RunOriginFilter = "all" | AutomationRunOrigin;
type RunDateFilter = "all" | "today" | "7d" | "30d";
type RunSort = "newest" | "oldest";

const runStatusFilterLabels: Record<RunStatusFilter, string> = {
  all: "Any status",
  completed: "Completed",
  failed: "Failed",
};

const runOriginFilterLabels: Record<RunOriginFilter, string> = {
  all: "Any trigger",
  automatic: "Automatic",
  manual: "Manual",
  test: "Test",
};

const runDateFilterLabels: Record<RunDateFilter, string> = {
  all: "Any date",
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const runSortLabels: Record<RunSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
};

const runOriginChipLabels: Record<AutomationRunOrigin, string> = {
  automatic: "Auto",
  manual: "Manual",
  test: "Test",
};

const runDateChipLabels: Record<Exclude<RunDateFilter, "all">, string> = {
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
};

/**
 * Legible one-line summary of the runs "Filters" chip's active facets, shown on
 * the chip itself after a selection (instead of an opaque count badge). One
 * active facet reads as its value ("Manual"); several collapse to "N filters".
 */
function runFilterChipSummary(
  originFilter: RunOriginFilter,
  dateFilter: RunDateFilter,
  sort: RunSort,
): string | undefined {
  const parts: string[] = [];
  if (originFilter !== "all") parts.push(runOriginChipLabels[originFilter]);
  if (dateFilter !== "all") parts.push(runDateChipLabels[dateFilter]);
  if (sort !== "newest") parts.push("Oldest");
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return `${parts.length} filters`;
}

function runStartedAtTimestamp(run: AutomationRunRecord): number | null {
  const timestamp = Date.parse(run.startedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function runMatchesStatusFilter(run: AutomationRunRecord, filter: RunStatusFilter): boolean {
  if (filter === "all") return true;
  const lifecycle = automationRunLifecycleState(run);
  return filter === "completed" ? lifecycle === "success" : lifecycle === "failure" || lifecycle === "aborted";
}

function automationRunOrigin(run: AutomationRunRecord): AutomationRunOrigin {
  const triggerType =
    typeof run.triggerData === "object" &&
    run.triggerData !== null &&
    "type" in run.triggerData &&
    typeof run.triggerData.type === "string"
      ? run.triggerData.type
      : "";
  const persistedTypes = [triggerType, run.type ?? "", run.runType ?? ""].join(" ").trim().toLowerCase();
  if (/(?:^|[\s_-])test(?:$|[\s_-])/.test(persistedTypes)) return "test";
  if (/(?:^|[\s_-])manual(?:$|[\s_-])/.test(persistedTypes)) return "manual";
  return "automatic";
}

function runMatchesOriginFilter(run: AutomationRunRecord, filter: RunOriginFilter): boolean {
  return filter === "all" || automationRunOrigin(run) === filter;
}

function runMatchesDateFilter(run: AutomationRunRecord, filter: RunDateFilter, now = Date.now()): boolean {
  if (filter === "all") return true;
  const startedAt = runStartedAtTimestamp(run);
  if (startedAt === null) return false;
  if (filter === "today") {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return startedAt >= today.getTime();
  }
  const days = filter === "7d" ? 7 : 30;
  return startedAt >= now - days * 24 * 60 * 60 * 1_000;
}

function runDateSort(left: AutomationRunRecord, right: AutomationRunRecord, sort: RunSort): number {
  const leftTimestamp = runStartedAtTimestamp(left);
  const rightTimestamp = runStartedAtTimestamp(right);
  if (leftTimestamp !== null && rightTimestamp !== null) {
    return sort === "newest" ? rightTimestamp - leftTimestamp : leftTimestamp - rightTimestamp;
  }
  return sort === "newest"
    ? right.startedAt.localeCompare(left.startedAt)
    : left.startedAt.localeCompare(right.startedAt);
}

/**
 * A labeled segmented control used inside a filter popover. Generic over the
 * value type so both the runs drawer (Trigger/When/Sort) and the chat list
 * (Creator) share one control — the builder's single filter language.
 */
function FilterSegments<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <fieldset
        aria-label={label}
        className="flex w-full items-center gap-0.5 rounded-[8px] border-0 bg-muted/50 p-0.5"
      >
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={cn(
                "flex-1 whitespace-nowrap rounded-[6px] px-2 py-1 text-[12px] font-medium leading-4 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

/**
 * The shared "Filters" chip + popover used on BOTH builder drawers (chat list
 * and runs). One trigger idiom — a funnel + label + active-count badge + caret,
 * opening a popover of {@link FilterSegments} groups — so the two rows read as
 * one language and scale to any number of facets. Each drawer passes its own
 * groups (and Reset) as children.
 */
function FiltersMenu({
  open,
  onOpenChange,
  activeCount,
  activeSummary,
  ariaLabel,
  testId,
  title = "Filters",
  onReset,
  resetTestId,
  contentClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCount: number;
  activeSummary?: string;
  ariaLabel: string;
  testId?: string;
  title?: string;
  onReset?: () => void;
  resetTestId?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  const active = activeCount > 0;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={ariaLabel}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            active
              ? "bg-muted text-foreground ring-1 ring-inset ring-border/70 hover:bg-muted/80"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground data-[state=open]:bg-muted/60 data-[state=open]:text-foreground",
          )}
        >
          <FunnelSimpleIcon size={14} weight={active ? "fill" : "regular"} />
          <span className="max-w-[128px] truncate">{active ? (activeSummary ?? "Filters") : "Filters"}</span>
          <CaretDownIcon size={12} className={active ? "text-foreground/55" : "text-muted-foreground"} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className={cn(
          "rounded-[12px] border-border/65 p-3 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.3)]",
          contentClassName ?? "w-[264px]",
        )}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-[13px] font-semibold text-foreground">{title}</p>
          {active && onReset ? (
            <button
              type="button"
              data-testid={resetTestId}
              onClick={onReset}
              className="rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reset
            </button>
          ) : null}
        </div>
        <div className="flex flex-col gap-3">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

function RunInspector({
  draft,
  runs,
  memberNameById,
  activeRunId,
  activeRun,
  loading,
  unavailable,
  onSelectRun,
  open,
  onClose,
  onRefresh,
}: {
  draft: DraftAutomation;
  runs: AutomationRunRecord[];
  memberNameById: ReadonlyMap<string, string>;
  activeRunId: string | null;
  activeRun: AutomationRunRecord | null;
  loading: boolean;
  unavailable: boolean;
  onSelectRun: (runId: string) => void;
  open: boolean;
  onClose: () => void;
  onRefresh?: () => Promise<unknown>;
}) {
  const [originFilter, setOriginFilter] = useState<RunOriginFilter>("all");
  const [statusFilter, setStatusFilter] = useState<RunStatusFilter>("all");
  const [dateFilter, setDateFilter] = useState<RunDateFilter>("all");
  const [sort, setSort] = useState<RunSort>("newest");
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const history = useMemo(() => {
    const unique = new Map<string, AutomationRunRecord>();
    for (const run of [...runs, ...(activeRun ? [activeRun] : [])]) unique.set(run.id, run);
    return [...unique.values()];
  }, [activeRun, runs]);
  const filteredHistory = useMemo(
    () =>
      history
        .filter((run) => runMatchesOriginFilter(run, originFilter))
        .filter((run) => runMatchesStatusFilter(run, statusFilter))
        .filter((run) => runMatchesDateFilter(run, dateFilter))
        .sort((left, right) => runDateSort(left, right, sort)),
    [dateFilter, history, originFilter, sort, statusFilter],
  );
  const filtersActive = originFilter !== "all" || statusFilter !== "all" || dateFilter !== "all";
  const secondaryFilterCount =
    (originFilter !== "all" ? 1 : 0) + (dateFilter !== "all" ? 1 : 0) + (sort !== "newest" ? 1 : 0);
  const clearFilters = () => {
    setOriginFilter("all");
    setStatusFilter("all");
    setDateFilter("all");
  };
  const resetSecondaryFilters = () => {
    setOriginFilter("all");
    setDateFilter("all");
    setSort("newest");
  };

  return (
    <aside
      id="automation-builder-runs-panel"
      data-testid="automation-builder-runs-panel"
      aria-label="Automation runs"
      aria-hidden={!open}
      inert={!open}
      data-state={open ? "open" : "closed"}
      className={cn(
        builderSidebarFrameClass,
        "right-0 border-l",
        open
          ? `translate-x-0 border-border/80 ${builderSidebarWidthClass}`
          : "pointer-events-none translate-x-full border-transparent lg:w-0 lg:min-w-0 lg:max-w-0",
      )}
    >
      <div
        data-testid="automation-builder-runs-panel-content"
        className={cn(
          builderSidebarContentClass,
          builderSidebarWidthClass,
          open ? "lg:translate-x-0" : "lg:translate-x-full",
        )}
      >
        <div className="shrink-0 border-b border-border/80 px-4 py-2.5">
          <div className="flex h-9 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <h2 className="truncate text-[13px] font-semibold leading-5 text-foreground">All runs</h2>
              {filtersActive ? (
                <span
                  data-testid="automation-run-count"
                  className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium tabular-nums text-muted-foreground"
                >
                  {filteredHistory.length}/{history.length}
                </span>
              ) : null}
            </div>
            {onRefresh ? (
              <IconTooltip label="Refresh runs">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(canvasCompactIconButtonClass, "size-7 shrink-0")}
                  data-testid="automation-runs-refresh"
                  aria-label="Refresh runs"
                  onClick={handleRefresh}
                  disabled={refreshing}
                >
                  <ArrowClockwiseIcon size={16} className={cn(refreshing && "animate-spin")} />
                </Button>
              </IconTooltip>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(canvasCompactIconButtonClass, "size-7 shrink-0")}
              data-testid="automation-runs-collapse"
              aria-label="Collapse all runs"
              title="Collapse all runs"
              onClick={onClose}
            >
              <SidebarSimpleIcon size={16} className="-scale-x-100" />
            </Button>
          </div>
        </div>

        <div className="shrink-0 px-4 pt-3 pb-3">
          <div data-testid="automation-run-filters" className="flex items-center justify-between gap-2">
            <div
              data-testid="automation-run-status-filter"
              role="tablist"
              aria-label="Filter runs by status"
              className="inline-flex min-w-0 items-center rounded-[8px] bg-muted/50 p-0.5"
            >
              {(Object.keys(runStatusFilterLabels) as RunStatusFilter[]).map((value) => {
                const selected = statusFilter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setStatusFilter(value)}
                    className={cn(
                      "rounded-[6px] px-2.5 py-1 text-[12px] font-medium leading-4 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {value === "all" ? "All" : runStatusFilterLabels[value]}
                  </button>
                );
              })}
            </div>
            <FiltersMenu
              open={moreFiltersOpen}
              onOpenChange={setMoreFiltersOpen}
              activeCount={secondaryFilterCount}
              activeSummary={runFilterChipSummary(originFilter, dateFilter, sort)}
              ariaLabel="More run filters"
              testId="automation-run-more-filters"
              onReset={resetSecondaryFilters}
              resetTestId="automation-run-filters-clear"
            >
              <FilterSegments
                label="Trigger"
                value={originFilter}
                onChange={setOriginFilter}
                options={[
                  { value: "all", label: "Any" },
                  { value: "automatic", label: "Auto" },
                  { value: "manual", label: "Manual" },
                  { value: "test", label: "Test" },
                ]}
              />
              <FilterSegments
                label="When"
                value={dateFilter}
                onChange={setDateFilter}
                className="mt-2"
                options={[
                  { value: "all", label: "Any" },
                  { value: "today", label: "Today" },
                  { value: "7d", label: "7 days" },
                  { value: "30d", label: "30 days" },
                ]}
              />
              <FilterSegments
                label="Sort"
                value={sort}
                onChange={setSort}
                className="mt-2"
                options={[
                  { value: "newest", label: "Newest" },
                  { value: "oldest", label: "Oldest" },
                ]}
              />
            </FiltersMenu>
          </div>
        </div>

        <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-0 pb-4">
          <RunHistoryList
            draft={draft}
            runs={filteredHistory}
            memberNameById={memberNameById}
            activeRunId={activeRunId}
            activeRun={activeRun}
            loading={loading}
            unavailable={unavailable}
            onSelectRun={onSelectRun}
            includeMissingActiveRun={!filtersActive}
            filtersActive={filtersActive}
            onClearFilters={clearFilters}
          />
        </div>
      </div>
    </aside>
  );
}

function RunInspectorDetail({
  draft,
  run,
  loading,
  unavailable,
}: {
  draft: DraftAutomation;
  run: AutomationRunRecord | null;
  loading: boolean;
  unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <output
        role="alert"
        className="block rounded-[8px] border border-destructive/35 bg-destructive/10 p-3 text-[12px] text-destructive"
      >
        This run is no longer available.
      </output>
    );
  }
  if (loading && !run) {
    return (
      <output
        aria-live="polite"
        className="flex items-center gap-2 rounded-[8px] border border-border bg-card p-3 text-[12px] text-muted-foreground"
      >
        <SpinnerGapIcon size={14} className="animate-spin" />
        Loading run details…
      </output>
    );
  }
  if (!run) {
    return (
      <div className="rounded-[8px] border border-dashed border-border bg-muted/15 p-4 text-sm text-muted-foreground">
        No runs yet.
      </div>
    );
  }

  const executingStepId = inferredRunningStepId(draft.steps, draft.edges, run.stepOutputs, run.status);
  return (
    <div className="space-y-3">
      {automationRunLifecycleState(run) === "failure" && run.errorMessage ? (
        <output
          role="alert"
          className="block rounded-[8px] border border-destructive/35 bg-destructive/10 p-3 text-[12px] text-destructive"
        >
          {run.errorMessage}
        </output>
      ) : null}
      <div data-testid="automation-run-step-list" className="space-y-2">
        {draft.steps.map((step) => (
          <RunStepRow key={step.id} draft={draft} step={step} run={run} executingStepId={executingStepId} />
        ))}
      </div>
      {loading ? (
        <p className="flex items-center gap-2 px-1 pt-2 text-[11px] text-muted-foreground" aria-live="polite">
          <SpinnerGapIcon size={12} className="animate-spin" />
          Updating run…
        </p>
      ) : null}
    </div>
  );
}

function RunStepRow({
  draft,
  step,
  run,
  executingStepId,
}: {
  draft: DraftAutomation;
  step: WorkflowStep;
  run: AutomationRunRecord;
  executingStepId: string | null;
}) {
  const visual = resolveStepVisual(step, draft.stepContent[step.id]);
  const Icon = visual.icon;
  const status = runStepStatus(step, run, executingStepId);
  const output = selectedStepOutput(step, run);
  const [expanded, setExpanded] = useState(false);
  const [renderDetails, setRenderDetails] = useState(false);
  const expansionFrameRef = useRef<number | null>(null);
  const executionActivity: ExecutionActivity = status === "running" ? "run" : null;

  useEffect(
    () => () => {
      if (expansionFrameRef.current !== null) cancelAnimationFrame(expansionFrameRef.current);
    },
    [],
  );

  const toggleExpanded = () => {
    if (expansionFrameRef.current !== null) {
      cancelAnimationFrame(expansionFrameRef.current);
      expansionFrameRef.current = null;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (renderDetails) {
      setExpanded(true);
      return;
    }
    setRenderDetails(true);
    expansionFrameRef.current = requestAnimationFrame(() => {
      expansionFrameRef.current = null;
      setExpanded(true);
    });
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[8px] border border-border/55 transition-colors",
        expanded && "border-border",
        status === "failed" && "border-destructive/30",
      )}
    >
      <button
        type="button"
        data-testid={`automation-run-step-${step.id}`}
        data-status={status}
        aria-label={`Inspect ${step.label}`}
        aria-expanded={expanded}
        onClick={toggleExpanded}
        className="flex min-h-[52px] w-full items-center gap-2.5 px-3 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/55 focus-visible:ring-inset"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-muted text-muted-foreground">
          <Icon size={15} weight={visual.kind === "agent" ? "fill" : "regular"} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{step.label}</span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          <span className="text-[11px] tabular-nums">{output ? formatDuration(output.duration_ms) : "—"}</span>
          <RunStepStatusIcon status={status} />
          {expanded ? (
            <CaretDownIcon size={14} className="shrink-0" aria-hidden />
          ) : (
            <CaretRightIcon size={14} className="shrink-0" aria-hidden />
          )}
        </span>
      </button>
      {renderDetails ? (
        <div
          data-testid={`automation-run-step-details-${step.id}`}
          data-state={expanded ? "open" : "closed"}
          aria-hidden={!expanded}
          inert={!expanded}
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className={cn(
                "border-t border-border/80 px-3 pb-3 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
                expanded ? "translate-y-0" : "-translate-y-2",
              )}
            >
              <div className="pt-3">
                <OutputPanel
                  output={output}
                  status={status}
                  executionActivity={executionActivity}
                  showVariables={false}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RunHistoryList({
  draft,
  runs,
  memberNameById,
  activeRunId,
  activeRun,
  loading,
  unavailable,
  onSelectRun,
  includeMissingActiveRun,
  filtersActive,
  onClearFilters,
}: {
  draft: DraftAutomation;
  runs: AutomationRunRecord[];
  memberNameById: ReadonlyMap<string, string>;
  activeRunId: string | null;
  activeRun: AutomationRunRecord | null;
  loading: boolean;
  unavailable: boolean;
  onSelectRun: (runId: string) => void;
  includeMissingActiveRun: boolean;
  filtersActive: boolean;
  onClearFilters: () => void;
}) {
  if (runs.length === 0) {
    return (
      <div
        data-testid="automation-run-history"
        className="flex flex-col items-center justify-center px-6 py-14 text-center"
      >
        <span className="grid size-11 place-items-center rounded-full bg-muted/60 text-muted-foreground">
          <LightningIcon size={20} />
        </span>
        <p className="mt-3 text-[13px] font-medium text-foreground">
          {filtersActive ? "No matching runs" : "No runs yet"}
        </p>
        <p className="mt-1 max-w-[210px] text-[11px] leading-4 text-muted-foreground">
          {filtersActive
            ? "Try widening or clearing the filters to see more runs."
            : "Runs show up here each time this automation runs — start one with Run."}
        </p>
        {filtersActive ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="automation-run-filters-empty-clear"
            className={cn(canvasToolbarButtonClass, "mt-3 text-[11px]")}
            onClick={onClearFilters}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div data-testid="automation-run-history" className="space-y-2">
      {includeMissingActiveRun && activeRunId && !runs.some((run) => run.id === activeRunId) ? (
        <RunInspectorDetail draft={draft} run={activeRun} loading={loading} unavailable={unavailable} />
      ) : null}
      {runs.map((run) => (
        <RunHistoryItem
          key={run.id}
          draft={draft}
          run={run}
          memberNameById={memberNameById}
          active={run.id === activeRunId}
          activeRun={activeRun}
          loading={loading}
          unavailable={unavailable}
          onSelectRun={onSelectRun}
        />
      ))}
    </div>
  );
}

function RunHistoryItem({
  draft,
  run,
  memberNameById,
  active,
  activeRun,
  loading,
  unavailable,
  onSelectRun,
}: {
  draft: DraftAutomation;
  run: AutomationRunRecord;
  memberNameById: ReadonlyMap<string, string>;
  active: boolean;
  activeRun: AutomationRunRecord | null;
  loading: boolean;
  unavailable: boolean;
  onSelectRun: (runId: string) => void;
}) {
  const [renderDetails, setRenderDetails] = useState(active);
  const lifecycle = automationRunLifecycleState(run);
  const origin = automationRunOrigin(run);
  const completedSteps = completedRunStepCount(draft, run);

  useEffect(() => {
    if (active) setRenderDetails(true);
  }, [active]);

  return (
    <section
      className={cn(
        "overflow-hidden rounded-[10px] border border-border/70 bg-card transition-colors",
        active && "border-border bg-muted/40",
      )}
    >
      <button
        type="button"
        aria-label={`Open run from ${formatRunDate(run.startedAt)}, ${runOriginFilterLabels[origin].toLowerCase()} run`}
        aria-expanded={active}
        aria-pressed={active}
        onClick={() => {
          setRenderDetails(true);
          onSelectRun(run.id);
        }}
        className="flex min-h-[52px] w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/55 focus-visible:ring-inset"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <RunIcon lifecycle={lifecycle} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-foreground">{formatRunDate(run.startedAt)}</span>
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
            {runOriginFilterLabels[origin]} · {completedSteps}/{draft.steps.length} steps
            {run.triggeredByUserId ? ` · ${memberNameById.get(run.triggeredByUserId) ?? "a member"}` : null}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span className="text-[11px] tabular-nums">{runDuration(run) ?? "—"}</span>
          {active ? (
            <CaretDownIcon size={14} className="shrink-0" aria-hidden />
          ) : (
            <CaretRightIcon size={14} className="shrink-0" aria-hidden />
          )}
        </span>
        <span className="sr-only">{lifecycle ? runStatusLabel(lifecycle) : run.status}</span>
      </button>
      {renderDetails ? (
        <div
          data-testid={`automation-run-details-${run.id}`}
          data-state={active ? "open" : "closed"}
          aria-hidden={!active}
          inert={!active}
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            active ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className={cn(
                "border-t border-border/80 px-2.5 py-3 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
                active ? "translate-y-0" : "-translate-y-2",
              )}
            >
              <RunInspectorDetail
                draft={draft}
                run={active ? (activeRun ?? run) : run}
                loading={active && loading}
                unavailable={active && unavailable}
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function completedRunStepCount(draft: DraftAutomation, run: AutomationRunRecord): number {
  const executingStepId = inferredRunningStepId(draft.steps, draft.edges, run.stepOutputs, run.status);
  return draft.steps.filter((step) => {
    const status = runStepStatus(step, run, executingStepId);
    return status !== "idle" && status !== "running";
  }).length;
}

function RunStepStatusIcon({ status }: { status: UiStatus }) {
  if (status === "running") return <SpinnerGapIcon size={14} className="shrink-0 animate-spin text-brand-accent" />;
  if (status === "success") return <CheckCircleIcon size={14} weight="fill" className="shrink-0 text-success" />;
  if (status === "failed") return <XCircleIcon size={14} weight="fill" className="shrink-0 text-destructive" />;
  if (status === "skipped") return <CircleIcon size={13} className="shrink-0 text-muted-foreground" />;
  return <CircleIcon size={13} className="shrink-0 text-muted-foreground/60" />;
}

function runStepStatus(step: WorkflowStep, run: AutomationRunRecord, executingStepId: string | null): UiStatus {
  if (step.id === executingStepId) return "running";
  const output = run.stepOutputs[step.id];
  if (output) return outputStatus(output, false);
  if (step.type !== "trigger") return "idle";
  const lifecycle = automationRunLifecycleState(run);
  if (lifecycle === "success" || lifecycle === "failure" || lifecycle === "aborted") return "success";
  if (lifecycle === "pending" || lifecycle === "running") return "running";
  return "idle";
}

function runDuration(run: AutomationRunRecord | null): string | null {
  if (!run) return null;
  const startedAt = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  if (!Number.isFinite(completedAt)) return null;
  return formatDuration(Math.max(0, completedAt - startedAt));
}

function RunIcon({ lifecycle }: { lifecycle: AutomationRunLifecycleState | null }) {
  if (lifecycle === "pending" || lifecycle === "running") {
    return <SpinnerGapIcon size={15} className="animate-spin text-muted-foreground" />;
  }
  if (lifecycle === "failure") return <XCircleIcon size={15} weight="fill" className="text-destructive" />;
  if (lifecycle === "aborted")
    return <XCircleIcon size={15} weight="fill" className="text-amber-700 dark:text-amber-300" />;
  return <CheckCircleIcon size={15} weight="fill" className="text-emerald-700 dark:text-emerald-300" />;
}

function formatRunDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function NodeDrawer({
  taskId,
  draft,
  step,
  output,
  run,
  status,
  executionActivity,
  readOnly,
  onClose,
  onTest,
  onRebindAccounts,
  onSelectAccount,
  testingStepId,
  onUpdateAgentPrompt,
  savingPromptStepId,
}: {
  taskId: string;
  draft: DraftAutomation;
  step: WorkflowStep | null;
  output?: StepOutput;
  run: AutomationRunRecord | null;
  status: UiStatus;
  executionActivity: ExecutionActivity;
  readOnly: boolean;
  onClose: () => void;
  onTest: (stepId: string) => void;
  onRebindAccounts: (stepId: string) => void;
  onSelectAccount: (stepId: string, accountId: string) => void;
  testingStepId: string | null;
  onUpdateAgentPrompt: (stepId: string, content: string) => void;
  savingPromptStepId: string | null;
}) {
  const [tab, setTab] = useState<"input" | "reasoning" | "output">("input");

  const [choosingAccount, setChoosingAccount] = useState(false);
  const accountsQuery = useQuery({
    queryKey: ["automation-microsoft-accounts"],
    enabled: choosingAccount,
    queryFn: async () => {
      const servers = await api.mcpServers.list();
      const connections = await Promise.all(
        servers.filter((server) => server.type === "canvas").map((server) => api.mcpServers.listConnections(server.id)),
      );
      return connections
        .flat()
        .filter(
          (account) =>
            account.canUse !== false &&
            account.externalAccountId &&
            account.externalTenantId &&
            (account.app?.nameSlug ?? account.appId).startsWith("microsoft-"),
        );
    },
  });

  if (!step) return null;
  const content = draft.stepContent[step.id];
  const isTesting = testingStepId === step.id;

  return (
    <aside
      data-testid="automation-builder-drawer"
      aria-label={`${step.label} details`}
      className="automation-builder-drawer-enter absolute inset-0 z-30 flex h-full max-h-full w-full min-w-0 flex-col overflow-hidden border-l border-border/80 bg-background text-foreground shadow-xl 2xl:relative 2xl:inset-auto 2xl:z-auto 2xl:w-[392px] 2xl:min-w-[350px] 2xl:max-w-[540px] 2xl:resize-x 2xl:shadow-none"
    >
      <div className="shrink-0 border-b border-border/80 px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold leading-6 text-foreground">{step.label}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge className="rounded-[5px] border border-border bg-muted font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                {step.type}
              </Badge>
              <StatusBadge output={output} status={status} executionActivity={executionActivity} />
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={canvasCompactIconButtonClass}
            onClick={onClose}
            aria-label="Close drawer"
          >
            <XIcon size={14} />
          </Button>
        </div>
        <NodeRunSummary run={run} output={output} status={status} executionActivity={executionActivity} />
        {step.type !== "trigger" && !readOnly ? (
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={() => setChoosingAccount(true)}>
              Choose Microsoft account
            </Button>
            {choosingAccount ? (
              <select
                aria-label="Microsoft account"
                className="mt-2 w-full rounded border border-border bg-background p-2"
                value=""
                disabled={accountsQuery.isPending}
                onChange={(event) => {
                  if (event.target.value) onSelectAccount(step.id, event.target.value);
                  setChoosingAccount(false);
                }}
              >
                <option value="">{accountsQuery.isPending ? "Loading accounts…" : "Select an account"}</option>
                {accountsQuery.data?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.appName} — {account.accountName ?? account.id}
                    {account.isOwnedByViewer === false ? " (shared)" : ""}
                  </option>
                ))}
              </select>
            ) : null}
            {choosingAccount && accountsQuery.isError ? <p role="alert">Could not load accounts. Try again.</p> : null}
            {choosingAccount && accountsQuery.isSuccess && accountsQuery.data.length === 0 ? (
              <p>No Microsoft accounts available. Connect one in Integrations.</p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between border-t border-border/80 pt-3">
          <div role="tablist" aria-label="Node details" className="flex gap-5">
            <TabButton active={tab === "input"} onClick={() => setTab("input")}>
              Input
            </TabButton>
            {step.type === "agent" ? (
              <TabButton active={tab === "reasoning"} onClick={() => setTab("reasoning")}>
                Reasoning
              </TabButton>
            ) : null}
            <TabButton active={tab === "output"} onClick={() => setTab("output")}>
              Output
            </TabButton>
          </div>
          {Object.keys(step.accountIdentityBindings ?? {}).length > 0 ? (
            <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => onRebindAccounts(step.id)}>
              Rebind accounts
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            className={cn(canvasToolbarButtonClass, "h-7 gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em]")}
            disabled={readOnly || isTesting}
            aria-busy={isTesting}
            onClick={() => onTest(step.id)}
          >
            {isTesting ? <SpinnerGapIcon size={13} className="animate-spin" /> : <PlayIcon size={13} weight="fill" />}
            {isTesting ? "Testing…" : "Test"}
          </Button>
        </div>
      </div>

      <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {tab === "input" ? (
          <NodeInputPanel
            taskId={taskId}
            draft={draft}
            step={step}
            content={content}
            readOnly={readOnly}
            onUpdateAgentPrompt={onUpdateAgentPrompt}
            savingPrompt={savingPromptStepId === step.id}
          />
        ) : tab === "reasoning" && step.type === "agent" ? (
          <ReasoningPanel
            key={`${run?.id ?? "latest"}:${step.id}`}
            trace={output?.agentTrace}
            status={status}
            executionActivity={executionActivity}
          />
        ) : (
          <OutputPanel
            key={`${run?.id ?? "latest"}:${step.id}`}
            output={output}
            status={status}
            executionActivity={executionActivity}
          />
        )}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        "rounded-[6px] px-2.5 py-1.5 font-mono text-[12px] font-semibold uppercase tracking-[0.1em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/55",
        active ? "bg-muted/60 text-foreground" : "text-muted-foreground hover:bg-muted/35 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function StatusBadge({
  output,
  status,
  executionActivity,
}: {
  output?: StepOutput;
  status: UiStatus;
  executionActivity: ExecutionActivity;
}) {
  if (status === "running") {
    return (
      <Badge className="gap-1 rounded-[5px] border border-brand-accent/35 bg-brand-accent/10 text-foreground">
        <SpinnerGapIcon size={12} className="animate-spin" />
        {executionActivity === "test" ? "Testing" : "Running"}
      </Badge>
    );
  }
  if (!output) {
    return <Badge className="rounded-[5px] border border-border bg-muted/60 text-muted-foreground">No result</Badge>;
  }
  if (output.status === "completed")
    return (
      <Badge className="rounded-[5px] border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
        Succeeded · {formatDuration(output.duration_ms)}
      </Badge>
    );
  if (output.status === "failed")
    return (
      <Badge className="rounded-[5px] border border-destructive/30 bg-destructive/10 text-destructive">
        Failed · {formatDuration(output.duration_ms)}
      </Badge>
    );
  return <Badge className="rounded-[5px] border border-border bg-muted text-muted-foreground">Skipped</Badge>;
}

function NodeRunSummary({
  run,
  output,
  status,
  executionActivity,
}: {
  run: AutomationRunRecord | null;
  output?: StepOutput;
  status: UiStatus;
  executionActivity: ExecutionActivity;
}) {
  if (status === "running") {
    const copy =
      executionActivity === "test"
        ? "Testing this node. The result will update when the test finishes."
        : run
          ? `Run started ${formatRunDate(run.startedAt)}. Results will appear when this node finishes.`
          : "This node is running. Results will appear when it finishes.";
    return (
      <output
        data-testid="automation-node-execution-summary"
        aria-live="polite"
        className="mt-3 block text-[11px] leading-4 text-muted-foreground"
      >
        {copy}
      </output>
    );
  }
  if (!output || !run) return null;
  const timestamp = run.completedAt ?? run.startedAt;
  return (
    <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
      Latest output · {formatRunDate(timestamp)} · {formatDuration(output.duration_ms)}
    </p>
  );
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function traceRuntimeLabel(runtime: NonNullable<StepOutput["agentTrace"]>["runtime"]): string {
  if (runtime === "sketch") return "Full Sketch agent";
  if (runtime === "aisdk-light") return "AI SDK light agent";
  return "Claude SDK light agent";
}

function traceRelativeTime(at: number, startedAt: number): string {
  const elapsed = Math.max(0, at - startedAt);
  return elapsed < 1000 ? `+${elapsed}ms` : `+${(elapsed / 1000).toFixed(1)}s`;
}

function traceValueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function TracePayload({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] bg-muted/40 px-3 py-2.5 font-mono text-[11px] leading-5 text-foreground/85 [overflow-wrap:anywhere]">
        {traceValueText(value)}
      </pre>
    </div>
  );
}

function TraceToolStatusIcon({ status }: { status: "running" | "completed" | "failed" }) {
  if (status === "running") return <SpinnerGapIcon size={14} className="animate-spin text-muted-foreground" />;
  if (status === "failed") return <XCircleIcon size={14} weight="fill" className="text-destructive" />;
  return <CheckCircleIcon size={14} weight="fill" className="text-success" />;
}

function ReasoningPanel({
  trace,
  status,
  executionActivity,
}: {
  trace: StepOutput["agentTrace"];
  status: UiStatus;
  executionActivity: ExecutionActivity;
}) {
  if (!trace) {
    const message =
      status === "running"
        ? executionActivity === "test"
          ? "Testing this agent step. Its reasoning timeline will appear after the test finishes."
          : "This agent step is running. Its reasoning timeline will appear when the step finishes."
        : "No reasoning timeline was captured for this run. New agent runs will include reasoning summaries and tool activity here.";
    return (
      <output
        data-testid="automation-builder-reasoning-empty"
        aria-live={status === "running" ? "polite" : undefined}
        className="block rounded-[8px] border border-dashed border-border bg-muted/20 p-4 text-sm leading-6 text-muted-foreground"
      >
        {message}
      </output>
    );
  }

  const duration = trace.completedAt === null ? null : Math.max(0, trace.completedAt - trace.startedAt);
  const toolCount = trace.events.filter((event) => event.type === "tool_call").length;
  const usage = trace.usage;

  return (
    <div data-testid="automation-builder-reasoning" className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-border/80 py-3 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{traceRuntimeLabel(trace.runtime)}</span>
        {trace.model ? (
          <span className="max-w-full truncate font-mono" title={trace.model}>
            {trace.model}
          </span>
        ) : null}
        {trace.turns !== null ? (
          <span>
            {trace.turns} {trace.turns === 1 ? "turn" : "turns"}
          </span>
        ) : null}
        {trace.stopReason ? <span>Stop: {trace.stopReason.replaceAll("_", " ")}</span> : null}
        <span>
          {toolCount} {toolCount === 1 ? "tool call" : "tool calls"}
        </span>
        {duration !== null ? <span>{formatDuration(duration)}</span> : null}
      </div>

      {usage ? (
        <p className="text-[11px] leading-5 text-muted-foreground">
          {usage.inputTokens.toLocaleString()} input · {usage.outputTokens.toLocaleString()} output
          {usage.cacheReadTokens > 0 ? ` · ${usage.cacheReadTokens.toLocaleString()} cache read` : ""}
          {usage.costUsd !== null ? ` · $${usage.costUsd.toFixed(4)}` : ""}
        </p>
      ) : null}

      {trace.truncated ? (
        <p className="rounded-[8px] bg-warning/10 px-3 py-2 text-[11px] leading-5 text-warning">
          This trace reached the observability storage limit. The timeline below contains the activity captured before
          that limit.
        </p>
      ) : null}

      {trace.events.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-border bg-muted/20 p-4 text-sm leading-6 text-muted-foreground">
          This run returned a final answer without exposing a reasoning summary or calling a tool.
        </div>
      ) : (
        <ol className="relative space-y-0 before:absolute before:top-4 before:bottom-4 before:left-[15px] before:w-px before:bg-border">
          {trace.events.map((event) => {
            if (event.type === "reasoning") {
              return (
                <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                  <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <BrainIcon size={15} />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-[12px] font-medium text-foreground">
                        {event.source === "provider" ? "Reasoning summary" : "Agent update"}
                      </p>
                      <time className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {traceRelativeTime(event.at, trace.startedAt)}
                      </time>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-foreground/80">{event.text}</p>
                  </div>
                </li>
              );
            }

            const ToolIcon = /(?:bash|shell|terminal|command|exec)/i.test(event.toolName)
              ? TerminalWindowIcon
              : WrenchIcon;
            return (
              <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ToolIcon size={15} />
                </span>
                <details data-testid="automation-builder-trace-tool-call" className="group min-w-0 flex-1 pt-1">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/55 [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-foreground">
                      {event.toolName}
                    </span>
                    <TraceToolStatusIcon status={event.status} />
                    {event.durationMs !== null ? (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {formatDuration(event.durationMs)}
                      </span>
                    ) : null}
                    <CaretDownIcon
                      size={12}
                      className="shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                    />
                  </summary>
                  <div className="mt-3 space-y-3 pb-1">
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {event.skillName ? `Skill: ${event.skillName} · ` : ""}
                      {traceRelativeTime(event.startedAt, trace.startedAt)}
                    </p>
                    {event.input !== undefined ? <TracePayload label="Input" value={event.input} /> : null}
                    {event.outputCaptured ? (
                      <TracePayload label="Result" value={event.output} />
                    ) : (
                      <p className="text-[11px] leading-5 text-muted-foreground">
                        This runtime recorded the call and its status, but not the tool result payload.
                      </p>
                    )}
                    {event.errorMessage ? (
                      <p className="rounded-[8px] bg-destructive/10 px-3 py-2 text-[11px] leading-5 text-destructive">
                        {event.errorMessage}
                      </p>
                    ) : null}
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function NodeInputPanel({
  taskId,
  draft,
  step,
  content,
  readOnly,
  onUpdateAgentPrompt,
  savingPrompt,
}: {
  taskId: string;
  draft: DraftAutomation;
  step: WorkflowStep;
  content?: AutomationStepContent;
  readOnly: boolean;
  onUpdateAgentPrompt: (stepId: string, content: string) => void;
  savingPrompt: boolean;
}) {
  const [agentPrompt, setAgentPrompt] = useState(content?.content ?? "");
  useEffect(() => {
    setAgentPrompt(content?.content ?? "");
  }, [content?.content]);
  const agentPromptDirty = step.type === "agent" && agentPrompt !== (content?.content ?? "");

  return (
    <div className="flex min-h-full flex-col gap-5">
      <Field label="Label">
        <Input value={step.label} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
      </Field>

      {step.type === "trigger" ? <TriggerFields draft={draft} taskId={taskId} /> : null}

      {step.type === "agent" ? (
        <>
          <Field label="Uses">
            <Input
              value={(content?.apps ?? []).join(", ")}
              className={builderReadOnlyInputClass}
              readOnly
              aria-readonly="true"
            />
          </Field>
          <Field label="Prompt" grow>
            <Textarea
              value={agentPrompt}
              className={cn(builderTextareaClass, "min-h-[320px] flex-1 resize-none font-mono")}
              readOnly={readOnly}
              aria-readonly={readOnly}
              onChange={(event) => setAgentPrompt(event.target.value)}
            />
          </Field>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className={cn(
                canvasPrimaryButtonClass,
                "gap-1.5 px-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em]",
              )}
              disabled={!agentPromptDirty || !agentPrompt.trim() || savingPrompt}
              onClick={() => onUpdateAgentPrompt(step.id, agentPrompt)}
            >
              {savingPrompt ? (
                <SpinnerGapIcon size={13} className="animate-spin" />
              ) : (
                <CheckCircleIcon size={13} weight="fill" />
              )}
              Save prompt
            </Button>
          </div>
        </>
      ) : null}

      {step.type === "action" ? (
        <>
          <Field label="Uses">
            <Input
              value={[
                ...(content?.apps ?? []),
                ...(step.actionCapabilities?.sketchTools ?? []).map((tool) => `Sketch: ${tool}`),
              ].join(", ")}
              className={builderReadOnlyInputClass}
              readOnly
              aria-readonly="true"
            />
          </Field>
          <Field label="Script" grow>
            <Textarea
              value={content?.content ?? ""}
              className={cn(builderReadOnlyTextareaClass, "min-h-[340px] flex-1 resize-none font-mono")}
              readOnly
              aria-readonly="true"
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

function TriggerFields({ draft, taskId }: { draft: DraftAutomation; taskId: string }) {
  const triggerStep = draft.steps.find((step) => step.type === "trigger");
  const config = (triggerStep?.triggerConfig as WorkflowTriggerConfig | undefined) ?? { type: "schedule" as const };
  const canvasConfig = config.type === "canvas" ? config : undefined;
  const triggerLabel = canvasConfig
    ? canvasConfig.componentKey === "webhook-trigger"
      ? "Canvas webhook"
      : "Canvas trigger"
    : config.type === "slack_channel_message"
      ? "Slack channel message"
      : config.type;
  return (
    <>
      {config.type !== "webhook" ? (
        <Field label="Trigger type">
          <Input value={triggerLabel} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
        </Field>
      ) : null}
      {config.type === "slack_channel_message" ? (
        <Field label="Slack channel">
          <Input value={config.channelId ?? ""} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
        </Field>
      ) : null}
      {config.type === "webhook" ? <NativeWebhookFields config={config} paused={draft.status === "paused"} /> : null}
      {canvasConfig ? (
        <CanvasWebhookFields
          endpoint={canvasConfig.canvasEndpoint}
          status={canvasConfig.status}
          errorMessage={canvasConfig.errorMessage}
        />
      ) : null}
      {config.type === "schedule" ? (
        <>
          <Field label="Schedule type">
            <Input
              value={draft.scheduleType === "external" ? "cron" : draft.scheduleType}
              className={builderReadOnlyInputClass}
              readOnly
              aria-readonly="true"
            />
          </Field>
          <Field label="Schedule value">
            <Input value={draft.scheduleValue} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
          </Field>
          <Field label="Timezone">
            <Input value={draft.timezone} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
          </Field>
        </>
      ) : null}
    </>
  );
}

function NativeWebhookFields({ config, paused }: { config: WorkflowTriggerConfig; paused: boolean }) {
  const [showDetails, setShowDetails] = useState(false);
  const endpoints = config.webhookEndpoints ?? [];
  const intended = endpoints.filter(
    (endpoint) =>
      (endpoints.length === 1 && endpoint.slot === "default") || endpoint.status !== "revoked" || endpoint.binding,
  );
  const bindings = intended.map((endpoint) => endpoint.binding).filter((binding) => binding !== undefined);
  if (bindings.length === 0 && config.webhookBinding) bindings.push(config.webhookBinding);
  const clickup = bindings.length > 0 && bindings.every((binding) => binding.integration === "clickup");
  const signed =
    config.webhookAuthentication === "hmac_sha256" ||
    intended.some((endpoint) => endpoint.authentication === "hmac_sha256");
  const endpointReady = (endpoint: (typeof endpoints)[number]) =>
    endpoint.status === "active" && (intended.length === 1 || endpoint.authentication === "hmac_sha256");
  const readyCount = intended.filter(endpointReady).length;
  const ready = Boolean(config.webhookUrl) && config.webhookStatus === "active" && intended.every(endpointReady);
  const disconnected = config.webhookStatus === "revoked";
  const scopeNames: Record<string, [string, string]> = {
    list_id: ["list", "lists"],
    space_id: ["Space", "Spaces"],
    folder_id: ["folder", "folders"],
    task_id: ["task", "tasks"],
  };
  const scopes = new Map<string, Set<string>>();
  for (const binding of bindings) {
    if (!binding.subscription) continue;
    const scope = binding.subscription.scope;
    const field = scope?.field ?? "workspace";
    const ids = scopes.get(field) ?? new Set<string>();
    ids.add(scope?.id ?? binding.workspaceId ?? binding.collectionPath);
    scopes.set(field, ids);
  }
  const scopeSummary = [...scopes].map(([field, ids]) => {
    const names = field === "workspace" ? ["Workspace", "Workspaces"] : (scopeNames[field] ?? ["source", "sources"]);
    return `${ids.size} ${names[ids.size === 1 ? 0 : 1]}${field === "workspace" ? " (all locations)" : ""}`;
  });
  const eventNames = [...new Set(bindings.flatMap((binding) => binding.subscription?.events ?? []))].map((event) =>
    event === "*"
      ? "All events"
      : event
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .replace(/^./, (character) => character.toUpperCase()),
  );
  const eventSummary = eventNames.length > 2 ? [`${eventNames.length} types of activity`] : eventNames;
  const summary = [...scopeSummary, ...eventSummary].join(" · ");
  const guidance = disconnected
    ? "This trigger is disconnected. Ask Sketch in the automation chat to reconnect it."
    : !ready
      ? intended.length > 1
        ? `${readyCount} of ${intended.length} sources are connected. Ask Sketch in the automation chat to finish setup.`
        : "Setup is not complete. Ask Sketch in the automation chat to finish connecting this trigger."
      : paused
        ? "The trigger is ready. Resume the automation when you want it to run."
        : clickup
          ? "Matching ClickUp activity will start this automation automatically."
          : "Incoming events will start this automation automatically.";
  const handleCopy = async () => {
    if (!config.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(config.webhookUrl);
      toast.success("Webhook URL copied");
    } catch {
      toast.error("Unable to copy webhook URL");
    }
  };
  const callbackField = (
    <Field label="Webhook URL">
      <div className="flex gap-2">
        <Input
          value={config.webhookUrl ?? "Available after setup"}
          className={cn(builderReadOnlyInputClass, "min-w-0 flex-1")}
          readOnly
          aria-readonly="true"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn(canvasIconButtonClass, "border border-border/70 bg-card/90")}
          aria-label="Copy webhook URL"
          disabled={!config.webhookUrl}
          onClick={() => void handleCopy()}
        >
          <CopySimpleIcon size={15} />
        </Button>
      </div>
    </Field>
  );

  return (
    <div data-testid="native-webhook-details" className="space-y-4 rounded-lg border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">{clickup ? "ClickUp events" : "Incoming events"}</p>
          {summary ? <p className="text-xs leading-5 text-muted-foreground">{summary}</p> : null}
        </div>
        <Badge
          className={cn(
            "shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium",
            ready
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
        >
          {ready ? "Ready" : disconnected ? "Disconnected" : "Needs setup"}
        </Badge>
      </div>
      <output data-testid="native-webhook-guidance" className="block text-xs leading-5 text-muted-foreground">
        {guidance}
      </output>
      {!signed && bindings.length === 0 && config.webhookUrl ? callbackField : null}
      <div className="border-t border-border/60 pt-2">
        <button
          type="button"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((value) => !value)}
          className="flex w-full items-center gap-1.5 rounded py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CaretRightIcon
            size={13}
            aria-hidden="true"
            className={cn("transition-transform", showDetails && "rotate-90")}
          />
          Connection details
        </button>
        {showDetails ? (
          <div className="space-y-4 pt-3">
            {endpoints.length > 0 ? (
              <div aria-label="Webhook subscriptions" className="divide-y divide-border/60">
                {endpoints.map((endpoint) => (
                  <div key={endpoint.endpointId} className="space-y-1 py-3 text-xs first:pt-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {endpoint.binding?.subscription?.scope
                          ? `${scopeNames[endpoint.binding.subscription.scope.field]?.[0] ?? "Source"}: ${endpoint.binding.subscription.scope.id}`
                          : endpoint.binding?.subscription
                            ? "Entire Workspace"
                            : endpoint.status === "active"
                              ? "Incoming webhook"
                              : "Unconfigured source"}
                      </span>
                      <span className="text-muted-foreground">
                        {endpoint.status === "active"
                          ? "Connected"
                          : endpoint.status === "revoked"
                            ? "Retired"
                            : "Needs setup"}
                      </span>
                    </div>
                    <p className="text-muted-foreground">{endpoint.binding?.subscription?.events.join(", ")}</p>
                    <p className="text-muted-foreground">Slot: {endpoint.slot}</p>
                    {endpoint.authentication === "hmac_sha256" && endpoint.status === "active" ? (
                      <p className="text-muted-foreground">
                        {endpoint.lastDelivery ? "Signed event received" : "No events received yet"}
                      </p>
                    ) : null}
                    <p className="break-all font-mono text-[11px] text-muted-foreground">{endpoint.url}</p>
                  </div>
                ))}
              </div>
            ) : null}
            {signed || bindings.length > 0 || !config.webhookUrl ? callbackField : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <dt className="text-muted-foreground">Request</dt>
              <dd>
                {config.webhookMethod ?? "POST"} · {config.webhookContentType ?? "application/json"}
              </dd>
              <dt className="text-muted-foreground">Authentication</dt>
              <dd>{signed ? "HMAC-SHA256 provider signature" : "None required"}</dd>
              <dt className="text-muted-foreground">Payload</dt>
              <dd>Any JSON value</dd>
            </dl>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CanvasWebhookFields({
  endpoint,
  status,
  errorMessage,
}: {
  endpoint?: CanvasWebhookEndpoint;
  status?: WorkflowTriggerConfig["status"];
  errorMessage?: string;
}) {
  const statusDetails = getCanvasWebhookStatusDetails(status, endpoint);
  const handleCopy = async () => {
    if (!endpoint?.url) return;
    try {
      await navigator.clipboard.writeText(endpoint.url);
      toast.success("Canvas webhook URL copied");
    } catch {
      toast.error("Unable to copy Canvas webhook URL");
    }
  };

  return (
    <div
      data-testid="canvas-trigger-details"
      className="space-y-3 rounded-[8px] border border-brand-accent/25 bg-brand-accent/5 p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[12px] font-medium text-foreground">Canvas-managed trigger</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Canvas owns this trigger setup and sends JSON events to Sketch.
          </p>
        </div>
        <Badge
          className={cn(
            "shrink-0 rounded-[5px] border px-1.5 py-0.5 text-[10px] font-semibold",
            statusDetails.toneClass,
          )}
        >
          {statusDetails.label}
        </Badge>
      </div>
      <div
        data-testid="canvas-trigger-setup-guidance"
        role={statusDetails.isError ? "alert" : "status"}
        className={cn(
          "rounded-[6px] border px-2.5 py-2 text-[11px] leading-4",
          statusDetails.isError
            ? "border-destructive/25 bg-destructive/10 text-destructive"
            : "border-border/70 bg-background/55 text-muted-foreground",
        )}
      >
        <p>{statusDetails.guidance}</p>
        {errorMessage ? <p className="mt-1 text-destructive">Canvas error: {errorMessage}</p> : null}
      </div>
      <Field label="Canonical URL">
        <div className="flex gap-2">
          <Input
            value={endpoint?.url ?? "Canvas endpoint is not available yet"}
            className={cn(builderReadOnlyInputClass, "min-w-0 flex-1")}
            readOnly
            aria-readonly="true"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn(canvasIconButtonClass, "border border-border/70 bg-card/90")}
            aria-label="Copy canonical Canvas webhook URL"
            disabled={!endpoint?.url}
            onClick={() => void handleCopy()}
          >
            <CopySimpleIcon size={15} />
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Method">
          <Input
            value={endpoint?.method ?? "POST"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
        <Field label="Content type">
          <Input
            value={endpoint?.contentType ?? "application/json"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Authentication mode">
          <Input
            value={endpoint?.authentication === "none" ? "None required" : "Not configured"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
        <Field label="Payload shape">
          <Input
            value={endpoint?.payload ?? "Any JSON value"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
      </div>
    </div>
  );
}

function getCanvasWebhookStatusDetails(
  status: WorkflowTriggerConfig["status"],
  endpoint: CanvasWebhookEndpoint | undefined,
): { label: string; guidance: string; isError: boolean; toneClass: string } {
  if (status === "error") {
    return {
      label: "Setup error",
      guidance: "Canvas could not finish setting up this trigger. Fix the trigger in Canvas and retry setup.",
      isError: true,
      toneClass: "border-destructive/30 bg-destructive/10 text-destructive",
    };
  }
  if (status === "pending_canvas_setup" || (!status && !endpoint)) {
    return {
      label: "Setup pending",
      guidance: "Canvas is still setting up this trigger. Complete setup in Canvas before sending requests.",
      isError: false,
      toneClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  if (status === "active" && !endpoint) {
    return {
      label: "Active",
      guidance:
        "Canvas reports this trigger as active, but its canonical URL is not available yet. Refresh after setup completes.",
      isError: false,
      toneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  return {
    label: "Active",
    guidance:
      "Canvas setup is complete. Send POST requests with JSON to the canonical URL above; no authentication is required.",
    isError: false,
    toneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  };
}

function Field({ label, children, grow = false }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <div className={cn("space-y-2", grow && "flex min-h-0 flex-1 flex-col")}>
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function parseOutputValue(value: unknown): unknown {
  if (typeof value !== "string" || !(value.trim().startsWith("{") || value.trim().startsWith("["))) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isOutputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputVariableRows(value: unknown): Array<[string, unknown]> {
  const parsed = parseOutputValue(value);
  if (isOutputRecord(parsed)) return Object.entries(parsed);
  return [];
}

function outputVariablePreview(value: unknown): string {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (isOutputRecord(value)) {
    const count = Object.keys(value).length;
    return `${count} ${count === 1 ? "field" : "fields"}`;
  }
  if (value == null) return "null";
  return String(value);
}

function OutputPanel({
  output,
  status,
  executionActivity,
  showVariables = true,
}: {
  output?: StepOutput;
  status: UiStatus;
  executionActivity: ExecutionActivity;
  showVariables?: boolean;
}) {
  const [search, setSearch] = useState("");
  const activeNotice =
    status === "running"
      ? executionActivity === "test"
        ? "Testing this node. The latest saved result remains below until the test finishes."
        : "This node is running. Results will appear here when it finishes."
      : null;
  if (!output) {
    return (
      <output
        aria-live={activeNotice ? "polite" : undefined}
        className="block rounded-[8px] border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground"
      >
        {activeNotice ?? "No output yet. Run the automation or test this node."}
      </output>
    );
  }
  const variableRows = outputVariableRows(output.output);
  return (
    <div className="space-y-3">
      {activeNotice ? (
        <output className="block rounded-[8px] border border-brand-accent/25 bg-brand-accent/8 p-3 text-[12px] leading-5 text-muted-foreground">
          {activeNotice}
        </output>
      ) : null}
      {output.error ? (
        <details
          data-testid="automation-builder-step-failure-details"
          className="rounded-[8px] border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <summary className="cursor-pointer font-medium">Inspect persisted failure details</summary>
          <pre className="mt-2 max-w-full overflow-x-hidden whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">
            {output.error.message}
          </pre>
        </details>
      ) : output.output == null || output.output === "" ? (
        <div className="rounded-[8px] border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          No output returned.
        </div>
      ) : (
        <>
          {showVariables && variableRows.length > 0 ? (
            <div data-testid="automation-builder-output-table" className="space-y-3">
              <div className="relative">
                <MagnifyingGlassIcon
                  size={15}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search variables"
                  aria-label="Search output variables"
                  className={cn(builderInputClass, "h-9 pl-9")}
                />
              </div>
              <div className="flex items-center gap-2 border-b border-border pb-3 text-[12px] font-medium text-foreground">
                <TableIcon size={15} className="text-muted-foreground" />
                <span>Output Table</span>
                <span className="ml-auto text-[11px] font-normal text-muted-foreground">Latest</span>
              </div>
              <OutputVariableList rows={variableRows} search={search} />
            </div>
          ) : null}
          <JsonOutput value={output.output} />
        </>
      )}
    </div>
  );
}

function OutputVariableList({ rows: outputRows, search }: { rows: Array<[string, unknown]>; search: string }) {
  const normalizedSearch = search.trim().toLowerCase();
  const rows = outputRows.filter(([key]) => {
    if (!normalizedSearch) return true;
    return key.toLowerCase().includes(normalizedSearch);
  });
  if (rows.length === 0) {
    return <p className="px-1 text-[12px] text-muted-foreground">No variables match “{search}”.</p>;
  }
  return (
    <div className="divide-y divide-border/70 rounded-[8px] border border-border bg-card">
      {rows.map(([key, rowValue]) => (
        <div key={key} data-testid="automation-builder-output-variable" className="flex items-center gap-3 px-3 py-2.5">
          <BracketsCurlyIcon size={14} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/80">{key}</span>
          <span className="max-w-[45%] truncate text-[11px] text-muted-foreground">
            {outputVariablePreview(rowValue)}
          </span>
        </div>
      ))}
    </div>
  );
}

function JsonOutput({ value }: { value: unknown }) {
  const [raw, setRaw] = useState(false);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const parsed = parseOutputValue(value);
  const canTree = parsed !== null && typeof parsed === "object";
  return (
    <div
      data-testid="automation-builder-output"
      className="flex min-h-[320px] flex-col overflow-hidden rounded-[8px] border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Output
        </span>
        <div className="flex items-center gap-1">
          {canTree ? (
            <Button
              variant="ghost"
              size="icon"
              className={canvasCompactIconButtonClass}
              onClick={() => setRaw((current) => !current)}
              aria-label="Toggle output view"
            >
              {raw ? <BracketsCurlyIcon size={14} /> : <CodeIcon size={14} />}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className={canvasCompactIconButtonClass}
            onClick={() => void navigator.clipboard.writeText(text)}
            aria-label="Copy output"
          >
            <CopySimpleIcon size={14} />
          </Button>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground/80 [overflow-wrap:anywhere]">
        {canTree && !raw ? JSON.stringify(parsed, null, 2) : text}
      </pre>
    </div>
  );
}
