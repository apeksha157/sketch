import { AppIcon } from "@/components/connections/app-icon";
import type {
  AutomationArtifact,
  WebChatQuestion,
  WebChatQuestionAnswer,
  WebChatQuestionBatch,
  WebChatQuestionBatchAnswer,
  WebChatQuestionOption,
} from "@/lib/api";
import {
  BrainIcon,
  CaretDownIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CopySimpleIcon,
  DatabaseIcon,
  FileMagnifyingGlassIcon,
  FileTextIcon,
  GlobeIcon,
  GraduationCapIcon,
  type Icon,
  ImageIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  MicrophoneIcon,
  PaperclipIcon,
  PlugIcon,
  PuzzlePieceIcon,
  SparkleIcon,
  SpinnerGapIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WrenchIcon,
  XIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AutomationArtifactCard } from "./automation-artifact-card";
import { SketchMessage, UserMessage } from "./chat-message";
import { QuestionFlowCard, type QuestionFlowSubmission } from "./question-flow-card";

export interface ChatThreadFile {
  name: string;
  url: string;
  mediaType?: string;
  sizeBytes?: number;
}

export type ChatThreadIntegrationConnectionStatus =
  | "idle"
  | "loading"
  | "connecting"
  | "connected"
  | "error"
  | "unavailable";

export interface ChatThreadIntegrationConnection {
  requestId: string;
  appId: string;
  appName: string;
  providerId?: string;
  executionMode?: "canvas" | "cli" | "api";
  state?: "connect" | "connected";
  icon?: string;
  reason?: string;
  connectUrl?: string;
  accountName?: string;
  connectionId?: string | null;
}

export type ChatThreadProgressIconType = "tool" | "skill" | "canvas" | "generic";

export interface ChatThreadProgressIcon {
  type: ChatThreadProgressIconType;
  name?: string;
}

export interface ChatThreadProgressItem {
  id?: string;
  revision?: number;
  status?: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  startedAt?: number;
  endedAt?: number;
  mode?: "off" | "friendly" | "technical";
  integration?: { providerId?: string; appId: string; name: string; icon?: string };
  detailFormat?: "text" | "command" | "json";
  detailRedacted?: boolean;
  detailTruncated?: boolean;
  detailUnavailable?: boolean;
  kind: string;
  label: string;
  detail?: string;
  toolName?: string;
  icon?: ChatThreadProgressIcon;
}

export interface ChatThreadInterruption {
  label: string;
  detail?: string;
}

export type ChatThreadQuestion = WebChatQuestion;
export type ChatThreadQuestionBatch = WebChatQuestionBatch;
export type ChatThreadQuestionBatchAnswer = WebChatQuestionBatchAnswer;
export type ChatThreadQuestionAnswer = WebChatQuestionAnswer;

export function questionBatchSignature(batch: ChatThreadQuestionBatch): string {
  return `${batch.batchId}:${batch.questions
    .map((question) => `${question.id}[${question.options.map((option) => option.id).join(",")}]`)
    .join("|")}`;
}

function questionInteractionKey(message: ChatThreadMessage): string | null {
  if (message.questionBatch) return `batch:${message.id}:${questionBatchSignature(message.questionBatch)}`;
  if (message.question)
    return `single:${message.id}:${message.question.id}:${message.question.options.map((option) => option.id).join(",")}`;
  return null;
}

function pendingQuestionInteractionKey(messages: ChatThreadMessage[]): string | null {
  let pending: string | null = null;
  for (const message of messages) {
    const interactionKey = questionInteractionKey(message);
    if (interactionKey) pending = interactionKey;
    else if (message.role === "user") pending = null;
  }
  return pending;
}

export type ChatThreadTimelineEntry =
  | { id?: string; type: "text"; text: string }
  | {
      id?: string;
      type: "progress";
      progressItems?: ChatThreadProgressItem[];
      progressLines?: string[];
    };

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  createdAt?: string;
  files?: ChatThreadFile[];
  automations?: AutomationArtifact[];
  integrationConnections?: ChatThreadIntegrationConnection[];
  timeline?: ChatThreadTimelineEntry[];
  progressItems?: ChatThreadProgressItem[];
  progressLines?: string[];
  interruption?: ChatThreadInterruption;
  question?: ChatThreadQuestion;
  questionBatch?: ChatThreadQuestionBatch;
}

export interface ChatThreadProps {
  messages?: ChatThreadMessage[];
  busy?: boolean;
  error?: string | null;
  className?: string;
  integrationConnectionStatuses?: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnectIntegration?: (connection: ChatThreadIntegrationConnection) => void;
  onSelectQuestion?: (question: ChatThreadQuestion, option: WebChatQuestionOption) => void;
  onAnswerQuestion?: (question: ChatThreadQuestion, answer: ChatThreadQuestionAnswer) => void;
  onSubmitQuestionBatch?: (batch: ChatThreadQuestionBatch, answer: ChatThreadQuestionBatchAnswer) => void;
  autoOpenAutomation?: boolean;
  conversationId?: string;
}

const markdownPlugins = [remarkGfm];
const MAX_VISIBLE_TIMELINE_PROGRESS_ENTRIES = 3;
const TIMELINE_WINDOW_ANIMATION_MS = 320;

type ProgressIconComponent = Icon;

interface TimelineRenderEntry {
  key: string;
  entry: ChatThreadTimelineEntry;
}

type TimelineRenderBlock =
  | { type: "text"; key: string; entry: TimelineRenderEntry }
  | { type: "progress"; key: string; entries: TimelineRenderEntry[] };

interface AnimatedTimelineWindowState {
  entries: TimelineRenderEntry[];
  exitingKeys: string[];
  height: number | null;
  offsetY: number;
  animating: boolean;
}

function safeMarkdownHref(href: string | undefined): string | null {
  const value = href?.trim();
  if (!value) return null;
  if (value.startsWith("/") || value.startsWith("#")) return value;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? value : null;
  } catch {
    return null;
  }
}

function isExternalHref(href: string): boolean {
  return href.startsWith("http://") || href.startsWith("https://");
}

function textFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromReactNode(node.props.children);
  return "";
}

function compactUrlLabel(href: string): string {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    const label = `${host}${path}`;
    if (label.length <= 42) return label;
    return `${label.slice(0, 39)}...`;
  } catch {
    return href.length <= 42 ? href : `${href.slice(0, 39)}...`;
  }
}

function linkChildrenForHref(href: string, children: ReactNode): ReactNode {
  const text = textFromReactNode(children).trim();
  return text === href || text === `<${href}>` ? compactUrlLabel(href) : children;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownLinkHref(href: string): string {
  return href.replaceAll(")", "%29").replaceAll(" ", "%20");
}

function normalizeChatMarkdown(text: string): string {
  return text
    .replace(/<((?:https?:\/\/|mailto:)[^>|]+)\|([^>]+)>/g, (_match, href: string, label: string) => {
      return `[${escapeMarkdownLinkLabel(label)}](${escapeMarkdownLinkHref(href)})`;
    })
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, (_match, href: string) => href);
}

function copyableMarkdownText(text: string | undefined): string | null {
  const value = normalizeChatMarkdown(text ?? "").trim();
  return value ? value : null;
}

function assistantResponseCopyText(message: ChatThreadMessage): string | null {
  if (message.role !== "assistant") return null;

  const entries = timelineEntriesForMessage(message);
  if (entries.length > 0) {
    const finalEntry = entries.at(-1);
    return finalEntry?.type === "text" ? copyableMarkdownText(finalEntry.text) : null;
  }

  return copyableMarkdownText(message.text);
}

function stripLegacyProgressPrefix(text: string): string {
  let value = text.trim();
  for (let index = 0; index < 3; index += 1) {
    const next = value
      .replace(/^:[a-z0-9_+-]+:\s*/i, "")
      .replace(
        /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}][\u{FE0E}\u{FE0F}]?(?:\u{200D}[\p{Extended_Pictographic}\p{Emoji_Presentation}][\u{FE0E}\u{FE0F}]?)*\s*)+/u,
        "",
      )
      .trimStart();
    if (next === value) return value.trim();
    value = next;
  }
  return value.trim();
}

function normalizeProgressText(text: string | undefined): string {
  return stripLegacyProgressPrefix(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function legacyProgressKind(label: string): string {
  const normalized = label.toLowerCase();
  if (/\b(search|find|grep|rg|lookup|query)\b/.test(normalized)) return "search";
  if (/\b(read|write|edit|open|file|load|save|attach|upload|download)\b/.test(normalized)) return "file";
  if (/\b(run|bash|shell|command|tool)\b/.test(normalized)) return "tool";
  if (/\b(app|api|connect|fetch|web|http|url)\b/.test(normalized)) return "app";
  return "generic";
}

function normalizedProgressItem(item: ChatThreadProgressItem): ChatThreadProgressItem | null {
  const label = normalizeProgressText(item.label);
  const detail = typeof item.detail === "string" && item.detail.trim() ? item.detail : undefined;
  const toolName = normalizeProgressText(item.toolName);
  const kind = normalizeProgressText(item.kind) || "generic";
  const displayLabel = label || detail;
  if (!displayLabel) return null;

  return {
    ...item,
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined,
    kind,
    label: displayLabel,
    detail: label && detail ? detail : undefined,
    toolName: toolName || undefined,
    icon: item.icon,
  };
}

function legacyProgressItem(line: string, index: number): ChatThreadProgressItem | null {
  const label = normalizeProgressText(line);
  if (!label) return null;
  return { id: `legacy-${index}`, kind: legacyProgressKind(label), label };
}

function progressItemsForParts(
  progressItems?: ChatThreadProgressItem[],
  progressLines?: string[],
): ChatThreadProgressItem[] {
  const structured = (progressItems ?? [])
    .map((item) => normalizedProgressItem(item))
    .filter((item): item is ChatThreadProgressItem => Boolean(item));
  if (structured.length > 0) return structured;
  return (progressLines ?? [])
    .map((line, index) => legacyProgressItem(line, index))
    .filter((item): item is ChatThreadProgressItem => Boolean(item));
}

function progressItemsForMessage(message: ChatThreadMessage): ChatThreadProgressItem[] {
  return progressItemsForParts(message.progressItems, message.progressLines);
}

function normalizedTimelineEntry(entry: ChatThreadTimelineEntry): ChatThreadTimelineEntry | null {
  const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : undefined;
  if (entry.type === "text") {
    const text = entry.text.trim();
    return text ? { id, type: "text", text } : null;
  }

  const progressItems = progressItemsForParts(entry.progressItems, entry.progressLines);
  return progressItems.length > 0 ? { id, type: "progress", progressItems } : null;
}

function timelineEntriesForMessage(message: ChatThreadMessage): ChatThreadTimelineEntry[] {
  const timeline = (message.timeline ?? [])
    .map((entry) => normalizedTimelineEntry(entry))
    .filter((entry): entry is ChatThreadTimelineEntry => Boolean(entry));
  if (timeline.length > 0) return timeline;

  const progressItems = progressItemsForMessage(message);
  return progressItems.length > 0 ? [{ type: "progress", progressItems }] : [];
}

function hasTimeline(message: ChatThreadMessage): boolean {
  return timelineEntriesForMessage(message).length > 0;
}

function progressItemKey(item: ChatThreadProgressItem, index: number): string {
  return item.id ?? `${item.kind}:${item.label}:${item.detail ?? ""}:${item.toolName ?? ""}:${index}`;
}

function progressItemContentSignature(item: ChatThreadProgressItem, index: number): string {
  return [
    progressItemKey(item, index),
    item.revision ?? "",
    item.status ?? "",
    item.startedAt ?? "",
    item.endedAt ?? "",
    item.mode ?? "",
    item.label,
    item.detail ?? "",
    item.toolName ?? "",
    item.detailFormat ?? "",
    item.detailRedacted ? "redacted" : "",
    item.detailTruncated ? "truncated" : "",
    item.detailUnavailable ? "unavailable" : "",
    item.integration?.providerId ?? "",
    item.integration?.appId ?? "",
    item.integration?.name ?? "",
    item.integration?.icon ?? "",
  ].join("\u001e");
}

function progressItemsSignature(items: ChatThreadProgressItem[]): string {
  return items.map((item, index) => progressItemContentSignature(item, index)).join("|");
}

function timelineEntryKey(entry: ChatThreadTimelineEntry, index: number): string {
  if (entry.id) return entry.id;
  if (entry.type === "text") return `text:${index}`;
  return `progress:${progressItemsSignature(progressItemsForParts(entry.progressItems, entry.progressLines))}:${index}`;
}

function timelineEntryContentSignature(entry: ChatThreadTimelineEntry): string {
  if (entry.type === "text") return `text:${entry.text}`;
  return `progress:${progressItemsSignature(progressItemsForParts(entry.progressItems, entry.progressLines))}`;
}

function timelineRenderEntriesForMessage(message: ChatThreadMessage): TimelineRenderEntry[] {
  return timelineEntriesForMessage(message).map((entry, index) => ({ key: timelineEntryKey(entry, index), entry }));
}

function timelineRenderEntriesSignature(entries: TimelineRenderEntry[]): string {
  return entries.map((entry) => `${entry.key}:${timelineEntryContentSignature(entry.entry)}`).join("\u001f");
}

function timelineRenderBlocksForEntries(entries: TimelineRenderEntry[]): TimelineRenderBlock[] {
  const blocks: TimelineRenderBlock[] = [];
  let progressEntries: TimelineRenderEntry[] = [];
  let progressBlockIndex = 0;

  const flushProgressEntries = () => {
    if (progressEntries.length === 0) return;
    blocks.push({
      type: "progress",
      key: `progress-block-${progressBlockIndex}:${progressEntries[0].key}`,
      entries: progressEntries,
    });
    progressBlockIndex += 1;
    progressEntries = [];
  };

  for (const entry of entries) {
    if (entry.entry.type === "progress") {
      progressEntries.push(entry);
      continue;
    }

    flushProgressEntries();
    blocks.push({ type: "text", key: entry.key, entry });
  }

  flushProgressEntries();
  return blocks;
}

function latestActiveProgressEntryKey(blocks: TimelineRenderBlock[]): string | undefined {
  const latestBlock = blocks.at(-1);
  if (latestBlock?.type !== "progress") return undefined;
  return latestBlock.entries.at(-1)?.key;
}

function shouldCollapseProgressBlocks(blocks: TimelineRenderBlock[], active: boolean): boolean {
  if (!blocks.some((block) => block.type === "progress")) return false;
  if (!active) return true;
  return blocks.at(-1)?.type === "text";
}

function visibleProgressRenderEntries(entries: TimelineRenderEntry[]): TimelineRenderEntry[] {
  if (entries.length <= MAX_VISIBLE_TIMELINE_PROGRESS_ENTRIES) return entries;

  for (const entry of entries) {
    if (entry.entry.type !== "progress") return entries;
  }

  return entries.slice(-MAX_VISIBLE_TIMELINE_PROGRESS_ENTRIES);
}

function timelineWindowOverlap(previous: TimelineRenderEntry[], next: TimelineRenderEntry[]): number {
  const maxLength = Math.min(previous.length, next.length);
  for (let length = maxLength; length > 0; length -= 1) {
    const previousStart = previous.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (previous[previousStart + index].key !== next[index].key) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function prefersReducedTimelineMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function progressIconTokens(item: ChatThreadProgressItem): string[] {
  return [item.icon?.name, item.toolName, item.kind, item.label]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.toLowerCase());
}

function hasProgressToken(item: ChatThreadProgressItem, pattern: RegExp): boolean {
  return progressIconTokens(item).some((token) => pattern.test(token));
}

function isAutomationBuilderOpeningItem(item: ChatThreadProgressItem): boolean {
  return hasProgressToken(item, /automation builder|opening automation/);
}

function isAutomationBuilderOpeningBlock(block: TimelineRenderBlock | undefined): boolean {
  if (block?.type !== "progress") return false;
  const latestEntry = block.entries.at(-1)?.entry;
  if (!latestEntry || latestEntry.type !== "progress") return false;
  const latestItem = progressItemsForParts(latestEntry.progressItems, latestEntry.progressLines)[0];
  return latestItem ? isAutomationBuilderOpeningItem(latestItem) : false;
}

const PROGRESS_KIND_ICONS: Record<string, ProgressIconComponent> = {
  reasoning: BrainIcon,
  file: FileMagnifyingGlassIcon,
  search: MagnifyingGlassIcon,
  shell: TerminalWindowIcon,
  local: TerminalWindowIcon,
  web: GlobeIcon,
  canvas: PuzzlePieceIcon,
  integration: PuzzlePieceIcon,
  skill: GraduationCapIcon,
  attachment: PaperclipIcon,
  audio: MicrophoneIcon,
  image: ImageIcon,
  schedule: ClockIcon,
  entity: DatabaseIcon,
  delivery: MapPinIcon,
  chat: ChatCircleIcon,
  tool: WrenchIcon,
};

function progressIconForItem(item: ChatThreadProgressItem): ProgressIconComponent {
  if (hasProgressToken(item, /automation builder|opening automation/)) return SpinnerGapIcon;

  const byKind = PROGRESS_KIND_ICONS[item.kind.toLowerCase()];
  if (byKind) return byKind;

  if (hasProgressToken(item, /\b(bash|shell|terminal|command|exec)\b/)) return TerminalWindowIcon;
  if (hasProgressToken(item, /\b(search|find|grep|rg|lookup|query)\b/)) return MagnifyingGlassIcon;
  if (hasProgressToken(item, /\b(read|open|inspect|file|load|save|write|edit|attach|upload|download)\b/)) {
    return FileMagnifyingGlassIcon;
  }
  if (hasProgressToken(item, /\b(web|http|url|fetch|browser|request|app|api|connect)\b/)) return GlobeIcon;

  switch (item.icon?.type) {
    case "tool":
      return WrenchIcon;
    case "skill":
      return GraduationCapIcon;
    case "canvas":
      return PuzzlePieceIcon;
    default:
      return SparkleIcon;
  }
}

const markdownComponents: Components = {
  a({ href, children }) {
    const safeHref = safeMarkdownHref(href);
    if (!safeHref) return <span>{children}</span>;
    const external = isExternalHref(safeHref);

    return (
      <a href={safeHref} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined}>
        {linkChildrenForHref(safeHref, children)}
      </a>
    );
  },
};

const markdownComponentsWithCopy: Components = {
  ...markdownComponents,
  p({ children }) {
    return <MarkdownParagraph>{children}</MarkdownParagraph>;
  },
  pre({ children }) {
    return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
  },
  code({ className, children }) {
    return <code className={className}>{children}</code>;
  },
};

function emptyAnimatedTimelineState(entries: TimelineRenderEntry[]): AnimatedTimelineWindowState {
  return {
    entries,
    exitingKeys: [],
    height: null,
    offsetY: 0,
    animating: false,
  };
}

function useAnimatedTimelineWindow(targetEntries: TimelineRenderEntry[], paused = false) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const frameRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const latestTargetEntries = useRef(targetEntries);
  const [state, setState] = useState<AnimatedTimelineWindowState>(() => emptyAnimatedTimelineState(targetEntries));
  const stateRef = useRef(state);
  const renderedSignature = timelineRenderEntriesSignature(state.entries);
  const targetSignature = timelineRenderEntriesSignature(targetEntries);

  latestTargetEntries.current = targetEntries;

  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  useLayoutEffect(() => {
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const targetEntries = latestTargetEntries.current;
    const current = stateRef.current;
    if (paused) {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      frameRef.current = null;
      timeoutRef.current = null;
      if (
        timelineRenderEntriesSignature(current.entries) !== targetSignature ||
        current.animating ||
        current.offsetY !== 0
      ) {
        setState(emptyAnimatedTimelineState(targetEntries));
      }
      return;
    }
    if (renderedSignature === targetSignature && !current.animating) return;

    if (timeoutRef.current !== null && !prefersReducedTimelineMotion()) {
      const latestByKey = new Map(targetEntries.map((entry) => [entry.key, entry]));
      setState((previous) => ({
        ...previous,
        entries: previous.entries.map((entry) => latestByKey.get(entry.key) ?? entry),
      }));
      return;
    }

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (current.animating || prefersReducedTimelineMotion()) {
      setState(emptyAnimatedTimelineState(targetEntries));
      return;
    }

    const overlap = timelineWindowOverlap(current.entries, targetEntries);
    const removedCount = current.entries.length - overlap;
    const appendedEntries = targetEntries.slice(overlap);
    if (removedCount <= 0 || appendedEntries.length === 0) {
      setState(emptyAnimatedTimelineState(targetEntries));
      return;
    }

    const viewport = viewportRef.current;
    const track = trackRef.current;
    const firstRemoved = rowRefs.current.get(current.entries[0]?.key ?? "");
    const firstKept = rowRefs.current.get(current.entries[removedCount]?.key ?? "");
    const currentHeight = viewport?.getBoundingClientRect().height ?? 0;
    const removedHeight =
      firstRemoved && firstKept
        ? firstKept.getBoundingClientRect().top - firstRemoved.getBoundingClientRect().top
        : overlap === 0
          ? currentHeight
          : 0;

    if (!viewport || !track || currentHeight <= 0 || removedHeight <= 0) {
      setState(emptyAnimatedTimelineState(targetEntries));
      return;
    }

    const combinedEntries = [...current.entries, ...appendedEntries];
    setState({
      entries: combinedEntries,
      exitingKeys: current.entries.slice(0, removedCount).map((entry) => entry.key),
      height: currentHeight,
      offsetY: 0,
      animating: false,
    });

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const nextTrack = trackRef.current;
      const targetHeight = nextTrack ? Math.max(0, nextTrack.scrollHeight - removedHeight) : currentHeight;
      setState((previous) => ({
        ...previous,
        height: targetHeight,
        offsetY: -removedHeight,
        animating: true,
      }));
    });

    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      const latestByKey = new Map(latestTargetEntries.current.map((entry) => [entry.key, entry]));
      setState(emptyAnimatedTimelineState(targetEntries.map((entry) => latestByKey.get(entry.key) ?? entry)));
    }, TIMELINE_WINDOW_ANIMATION_MS + 32);
  }, [paused, targetSignature, renderedSignature]);

  const setRowRef = (key: string) => (node: HTMLDivElement | null) => {
    if (node) {
      rowRefs.current.set(key, node);
    } else {
      rowRefs.current.delete(key);
    }
  };

  return {
    entries: state.entries,
    exitingKeys: state.exitingKeys,
    viewportRef,
    trackRef,
    setRowRef,
    viewportStyle: {
      height: state.height === null ? undefined : `${state.height}px`,
    } satisfies CSSProperties,
    trackStyle: {
      transform: state.offsetY === 0 ? undefined : `translateY(${state.offsetY}px)`,
    } satisfies CSSProperties,
    animating: state.animating,
  };
}

export function ChatThread({
  messages = [],
  busy = false,
  error,
  className,
  integrationConnectionStatuses = {},
  onConnectIntegration,
  onSelectQuestion,
  onAnswerQuestion,
  onSubmitQuestionBatch,
  autoOpenAutomation,
  conversationId,
}: ChatThreadProps) {
  const latestMessage = messages.at(-1);
  const latestTimeline = latestMessage?.role === "assistant" ? timelineEntriesForMessage(latestMessage) : [];
  const latestTools = latestTimeline.flatMap((entry) =>
    entry.type === "progress" ? progressItemsForParts(entry.progressItems, entry.progressLines) : [],
  );
  const waitingAfterTools =
    latestTimeline.at(-1)?.type === "progress" &&
    latestTools.length > 0 &&
    latestTools.every((item) => item.mode !== "off" && item.status && item.status !== "running");
  const showBusy = busy && !error && (latestMessage?.role !== "assistant" || waitingAfterTools);
  const activeQuestionInteractionKey = pendingQuestionInteractionKey(messages);
  const [answeredInteractionKey, setAnsweredInteractionKey] = useState<string | null>(null);

  useEffect(() => {
    setAnsweredInteractionKey((current) => (current && current === activeQuestionInteractionKey ? current : null));
  }, [activeQuestionInteractionKey]);

  if (messages.length === 0 && !busy && !error) return null;

  return (
    <section aria-label="Chat thread" className={cn("flex flex-col gap-[24px]", className)}>
      {messages.map((message, index) => {
        const interactionKey = questionInteractionKey(message);
        const questionAnswerable =
          interactionKey !== null &&
          interactionKey === activeQuestionInteractionKey &&
          answeredInteractionKey !== interactionKey &&
          !busy;
        return (
          <MessageRow
            key={message.id}
            message={message}
            active={busy && !error && index === messages.length - 1}
            activityLive={busy && !error}
            integrationConnectionStatuses={integrationConnectionStatuses}
            onConnectIntegration={onConnectIntegration}
            onSelectQuestion={onSelectQuestion}
            onAnswerQuestion={onAnswerQuestion}
            onSubmitQuestionBatch={onSubmitQuestionBatch}
            onInteractionAnswered={() => setAnsweredInteractionKey(interactionKey)}
            questionAnswerable={questionAnswerable}
            autoOpenAutomation={index === messages.length - 1 ? autoOpenAutomation : false}
            conversationId={conversationId}
          />
        );
      })}
      {showBusy ? (
        <SketchMessage streaming>
          <span className="sketch-shimmer-text text-[13px] font-medium">Thinking…</span>
        </SketchMessage>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-[14px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}

function MessageRow({
  message,
  active,
  activityLive,
  integrationConnectionStatuses,
  onConnectIntegration,
  onSelectQuestion,
  onAnswerQuestion,
  onSubmitQuestionBatch,
  onInteractionAnswered,
  questionAnswerable,
  autoOpenAutomation,
  conversationId,
}: {
  message: ChatThreadMessage;
  active: boolean;
  activityLive: boolean;
  integrationConnectionStatuses: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnectIntegration?: (connection: ChatThreadIntegrationConnection) => void;
  onSelectQuestion?: (question: ChatThreadQuestion, option: WebChatQuestionOption) => void;
  onAnswerQuestion?: (question: ChatThreadQuestion, answer: ChatThreadQuestionAnswer) => void;
  onSubmitQuestionBatch?: (batch: ChatThreadQuestionBatch, answer: ChatThreadQuestionBatchAnswer) => void;
  onInteractionAnswered: () => void;
  questionAnswerable: boolean;
  autoOpenAutomation?: boolean;
  conversationId?: string;
}) {
  const submitQuestion = (
    interaction: ChatThreadQuestion | ChatThreadQuestionBatch,
    answer: QuestionFlowSubmission,
  ) => {
    onInteractionAnswered();
    if ("batchId" in interaction) onSubmitQuestionBatch?.(interaction, answer as ChatThreadQuestionBatchAnswer);
    else {
      if (onAnswerQuestion) onAnswerQuestion(interaction, answer as ChatThreadQuestionAnswer);
      else if ("optionId" in answer) {
        const option = interaction.options.find((candidate) => candidate.id === answer.optionId);
        if (option) onSelectQuestion?.(interaction, option);
      }
    }
  };
  if (message.role === "user") {
    return (
      <UserMessage footer={<MessageTimestamp createdAt={message.createdAt} align="right" />}>
        <MessageContent message={message} conversationId={conversationId} />
      </UserMessage>
    );
  }

  const assistantMessage = hasTimeline(message) ? (
    <SketchMessage streaming={active} footer={<AssistantMessageFooter message={message} active={active} />}>
      <div className="space-y-[8px]">
        <TimelineMessage
          message={message}
          active={active}
          activityLive={activityLive}
          integrationConnectionStatuses={integrationConnectionStatuses}
          onConnectIntegration={onConnectIntegration}
          autoOpenAutomation={autoOpenAutomation}
          conversationId={conversationId}
        />
        {message.question || message.questionBatch ? (
          <QuestionFlowCard
            key={message.questionBatch?.batchId ?? message.question?.id}
            question={message.question}
            batch={message.questionBatch}
            disabled={!questionAnswerable}
            onSubmit={submitQuestion}
          />
        ) : null}
      </div>
    </SketchMessage>
  ) : message.text ||
    message.files?.length ||
    message.automations?.length ||
    message.integrationConnections?.length ||
    message.question ||
    message.questionBatch ? (
    <SketchMessage streaming={active} footer={<AssistantMessageFooter message={message} active={active} />}>
      <MessageContent
        message={message}
        inProgress={active}
        integrationConnectionStatuses={integrationConnectionStatuses}
        onConnectIntegration={onConnectIntegration}
        onQuestionSubmit={submitQuestion}
        questionAnswerable={questionAnswerable}
        autoOpenAutomation={autoOpenAutomation}
        conversationId={conversationId}
      />
    </SketchMessage>
  ) : null;

  if (message.interruption) {
    return (
      <>
        {assistantMessage}
        <InterruptionNotice interruption={message.interruption} />
      </>
    );
  }

  if (hasTimeline(message)) {
    return assistantMessage;
  }

  return assistantMessage;
}

function InterruptionNotice({ interruption }: { interruption: ChatThreadInterruption }) {
  return (
    <output data-interruption-notice className="ml-[36px] max-w-[720px] border-l-2 border-border/80 py-[2px] pl-[12px]">
      {interruption.detail ? (
        <div className="text-[12px] font-medium leading-[1.45] text-muted-foreground/70">{interruption.detail}</div>
      ) : null}
      <div className="text-[13px] font-medium leading-[1.5] text-foreground/80">{interruption.label}</div>
    </output>
  );
}

function formatMessageTime(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function AssistantMessageFooter({ message, active }: { message: ChatThreadMessage; active: boolean }) {
  const copyText = active ? null : assistantResponseCopyText(message);
  if (!message.createdAt && !copyText) return null;

  return (
    <div className="mt-[5px] flex min-h-[24px] items-center gap-[6px]">
      <MessageTimestamp createdAt={message.createdAt} align="left" className="mt-0" />
      {copyText ? <CopyIconButton text={copyText} label="Copy response" copiedLabel="Response copied" /> : null}
    </div>
  );
}

function MessageTimestamp({
  createdAt,
  align,
  className,
}: {
  createdAt?: string;
  align: "left" | "right";
  className?: string;
}) {
  if (!createdAt) return null;
  const label = formatMessageTime(createdAt);
  if (!label) return null;

  return (
    <time
      dateTime={createdAt}
      className={cn(
        "mt-[5px] block text-[11px] leading-none text-muted-foreground/65",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {label}
    </time>
  );
}

function MessageContent({
  message,
  inProgress = false,
  integrationConnectionStatuses = {},
  onConnectIntegration,
  onQuestionSubmit,
  questionAnswerable = false,
  autoOpenAutomation,
  conversationId,
}: {
  message: ChatThreadMessage;
  inProgress?: boolean;
  integrationConnectionStatuses?: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnectIntegration?: (connection: ChatThreadIntegrationConnection) => void;
  onQuestionSubmit?: (
    interaction: ChatThreadQuestion | ChatThreadQuestionBatch,
    answer: QuestionFlowSubmission,
  ) => void;
  questionAnswerable?: boolean;
  autoOpenAutomation?: boolean;
  conversationId?: string;
}) {
  const copyBlocks = message.role === "assistant";
  const hasConnections = Boolean(message.integrationConnections?.length);
  const hasAutomations = Boolean(message.automations?.length);
  const hasQuestion = Boolean(message.question || message.questionBatch);
  if (!message.files?.length && !hasAutomations && !hasConnections && !hasQuestion) {
    return message.text ? (
      <MarkdownMessage text={message.text} inProgress={inProgress} copyBlocks={copyBlocks} />
    ) : null;
  }

  return (
    <div className="min-w-0 space-y-[10px]">
      {message.text ? <MarkdownMessage text={message.text} inProgress={inProgress} copyBlocks={copyBlocks} /> : null}
      {message.files?.length ? <FileAttachments files={message.files} /> : null}
      {message.automations?.length ? (
        <AutomationArtifactCards
          automations={message.automations}
          autoOpenAutomation={autoOpenAutomation}
          autoOpenKey={message.id}
          conversationId={conversationId}
        />
      ) : null}
      {message.integrationConnections?.length ? (
        <IntegrationConnectionCards
          connections={message.integrationConnections}
          statuses={integrationConnectionStatuses}
          onConnect={onConnectIntegration}
        />
      ) : null}
      {message.question || message.questionBatch ? (
        <QuestionFlowCard
          key={message.questionBatch?.batchId ?? message.question?.id}
          question={message.question}
          batch={message.questionBatch}
          disabled={!questionAnswerable}
          onSubmit={onQuestionSubmit}
        />
      ) : null}
    </div>
  );
}

function AutomationArtifactCards({
  automations,
  autoOpenAutomation,
  autoOpenKey,
  conversationId,
}: {
  automations: AutomationArtifact[];
  autoOpenAutomation?: boolean;
  autoOpenKey?: string;
  conversationId?: string;
}) {
  return (
    <div className="flex max-w-[640px] flex-col gap-[8px]">
      {automations.map((artifact, index) => (
        <AutomationArtifactCard
          key={artifact.taskId}
          artifact={artifact}
          conversationId={conversationId}
          autoOpen={autoOpenAutomation === true && index === automations.length - 1}
          autoOpenKey={autoOpenKey}
          className="mt-0 max-w-none"
        />
      ))}
    </div>
  );
}

function FileAttachments({ files }: { files: ChatThreadFile[] }) {
  return (
    <div className="flex flex-wrap gap-[8px]">
      {files.map((file) => (
        <a
          key={`${file.url}:${file.name}`}
          href={file.url}
          download={file.name}
          className={cn(
            "inline-flex max-w-full items-center gap-[8px] rounded-[8px] border border-border",
            "bg-background/70 px-[10px] py-[8px] text-[13px] text-foreground/90 transition-colors",
            "hover:border-foreground/25 hover:bg-muted/70",
          )}
        >
          <FileTextIcon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{file.name}</span>
        </a>
      ))}
    </div>
  );
}

function IntegrationConnectionCards({
  connections,
  statuses,
  onConnect,
}: {
  connections: ChatThreadIntegrationConnection[];
  statuses: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnect?: (connection: ChatThreadIntegrationConnection) => void;
}) {
  return (
    <div className="flex max-w-[640px] flex-col gap-[8px]">
      {connections.map((connection) => (
        <IntegrationConnectionCard
          key={connection.requestId}
          connection={connection}
          status={statuses[connection.requestId] ?? "idle"}
          onConnect={onConnect}
        />
      ))}
    </div>
  );
}

function IntegrationConnectionAppIcon({ connection }: { connection: ChatThreadIntegrationConnection }) {
  return (
    <AppIcon
      name={connection.appName}
      icon={connection.icon}
      className="size-10 rounded-[8px] bg-transparent text-[12px]"
      imageClassName="size-8"
    />
  );
}

function IntegrationConnectionCard({
  connection,
  status,
  onConnect,
}: {
  connection: ChatThreadIntegrationConnection;
  status: ChatThreadIntegrationConnectionStatus;
  onConnect?: (connection: ChatThreadIntegrationConnection) => void;
}) {
  const effectiveStatus = connection.state === "connected" && status === "idle" ? "connected" : status;
  const state = integrationConnectionState(effectiveStatus);
  const connectedState = effectiveStatus === "connected";
  const disabled =
    effectiveStatus === "loading" ||
    effectiveStatus === "connecting" ||
    connectedState ||
    effectiveStatus === "unavailable" ||
    !onConnect;
  const StatusIcon = state.icon;
  const title = connectedState ? `${connection.appName} connected` : `Connect ${connection.appName}`;
  const description = connectedState
    ? connection.accountName
      ? `${connection.accountName} is connected and available to Sketch.`
      : "This account is connected and available to Sketch."
    : connection.reason || "Connect this app to let Sketch work with it.";

  return (
    <div
      data-integration-connection-card
      className={cn(
        "rounded-[10px] border bg-card px-[14px] py-[12px]",
        connectedState ? "border-success/30 bg-success/5" : "border-border",
      )}
    >
      <div className="flex min-w-0 items-start gap-[12px]">
        <IntegrationConnectionAppIcon connection={connection} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-[7px]">
            <p className="truncate text-[14px] font-semibold leading-[1.4] text-foreground">{title}</p>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-[4px] rounded-[5px] px-[6px] py-[2px] text-[11px] font-medium",
                state.badgeClassName,
              )}
            >
              <StatusIcon
                size={12}
                className={cn((effectiveStatus === "loading" || effectiveStatus === "connecting") && "animate-spin")}
                aria-hidden
              />
              {state.label}
            </span>
          </div>
          <p className="mt-[3px] text-[12px] leading-[1.5] text-muted-foreground">{description}</p>
          {connection.connectUrl && !connectedState ? (
            <a
              className="mt-[5px] inline-flex text-[12px] font-medium text-primary underline-offset-2 hover:underline"
              href={connection.connectUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open integration settings
            </a>
          ) : null}
        </div>
        <button
          type="button"
          className={cn(
            "inline-flex h-[32px] shrink-0 cursor-pointer items-center gap-[6px] rounded-[7px] px-[10px]",
            "text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
            disabled
              ? "cursor-default bg-muted text-muted-foreground"
              : "bg-foreground text-background hover:bg-foreground/90",
          )}
          disabled={disabled}
          onClick={() => onConnect?.(connection)}
        >
          {effectiveStatus === "loading" || effectiveStatus === "connecting" ? (
            <SpinnerGapIcon size={14} className="animate-spin" />
          ) : connectedState ? (
            <CheckCircleIcon size={14} />
          ) : (
            <PlugIcon size={14} />
          )}
          {state.buttonLabel}
        </button>
      </div>
    </div>
  );
}

function integrationConnectionState(status: ChatThreadIntegrationConnectionStatus): {
  label: string;
  buttonLabel: string;
  icon: ProgressIconComponent;
  badgeClassName: string;
} {
  switch (status) {
    case "loading":
      return {
        label: "Checking",
        buttonLabel: "Connect",
        icon: SpinnerGapIcon,
        badgeClassName: "bg-muted text-muted-foreground",
      };
    case "connecting":
      return {
        label: "In progress",
        buttonLabel: "Connecting",
        icon: SpinnerGapIcon,
        badgeClassName: "bg-brand-accent/15 text-[#5A4F00]",
      };
    case "connected":
      return {
        label: "Connected",
        buttonLabel: "Connected",
        icon: CheckCircleIcon,
        badgeClassName: "bg-success/10 text-success",
      };
    case "error":
      return {
        label: "Needs retry",
        buttonLabel: "Retry",
        icon: WarningCircleIcon,
        badgeClassName: "bg-destructive/10 text-destructive",
      };
    case "unavailable":
      return {
        label: "Unavailable",
        buttonLabel: "Unavailable",
        icon: WarningCircleIcon,
        badgeClassName: "bg-muted text-muted-foreground",
      };
    default:
      return {
        label: "Ready",
        buttonLabel: "Connect",
        icon: PlugIcon,
        badgeClassName: "bg-muted text-muted-foreground",
      };
  }
}

function AutomationBuilderLoadingState() {
  return (
    <div
      data-automation-builder-loading
      className="flex max-w-[560px] items-center gap-3 rounded-[12px] border border-brand-accent/35 bg-brand-accent/10 px-4 py-4 shadow-sm"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-brand-accent/20 text-brand-accent">
        <SpinnerGapIcon size={20} className="animate-spin" aria-hidden />
      </span>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold leading-[1.4] text-foreground">Opening automation builder</div>
        <div className="mt-1 text-[12px] leading-[1.5] text-muted-foreground">Taking you there now…</div>
      </div>
    </div>
  );
}

function TimelineMessage({
  message,
  active,
  activityLive,
  integrationConnectionStatuses = {},
  onConnectIntegration,
  autoOpenAutomation,
  conversationId,
}: {
  message: ChatThreadMessage;
  active: boolean;
  activityLive: boolean;
  integrationConnectionStatuses?: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnectIntegration?: (connection: ChatThreadIntegrationConnection) => void;
  autoOpenAutomation?: boolean;
  conversationId?: string;
}) {
  const entries = useMemo(() => timelineRenderEntriesForMessage(message), [message]);
  const blocks = useMemo(() => timelineRenderBlocksForEntries(entries), [entries]);
  const collapseProgress = shouldCollapseProgressBlocks(blocks, active);
  const activeProgressEntryKey = active ? latestActiveProgressEntryKey(blocks) : undefined;
  const completedSegments = useMemo(() => completedTimelineSegments(entries), [entries]);
  const openingAutomationBuilder = active && isAutomationBuilderOpeningBlock(blocks.at(-1));
  const runningToolCount = runningProgressItemCount(blocks, activityLive);

  if (!active) {
    return (
      <div className="max-w-[720px]">
        {completedSegments.activityEntries.length > 0 ? (
          <CollapsibleTimelineHistory entries={completedSegments.activityEntries} />
        ) : null}
        {completedSegments.finalEntry?.entry.type === "text" ? (
          <div className={cn(completedSegments.activityEntries.length > 0 && "pt-[2px]")}>
            <MarkdownMessage text={completedSegments.finalEntry.entry.text} copyBlocks />
          </div>
        ) : null}
        {message.files?.length ? (
          <div className="mt-[10px]">
            <FileAttachments files={message.files} />
          </div>
        ) : null}
        {message.automations?.length ? (
          <div className="mt-[10px]">
            <AutomationArtifactCards
              automations={message.automations}
              autoOpenAutomation={autoOpenAutomation}
              autoOpenKey={message.id}
              conversationId={conversationId}
            />
          </div>
        ) : null}
        {message.integrationConnections?.length ? (
          <div className="mt-[10px]">
            <IntegrationConnectionCards
              connections={message.integrationConnections}
              statuses={integrationConnectionStatuses}
              onConnect={onConnectIntegration}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="max-w-[720px]">
      {runningToolCount > 1 ? (
        <span data-progress-running-count className="mb-[4px] block pl-[30px] text-[11px] text-muted-foreground/60">
          {runningToolCount} tools running
        </span>
      ) : null}
      {blocks.map((block) =>
        block.type === "text" ? (
          <TimelineEntryRow key={block.key} entry={block.entry.entry} active={false} exiting={false} last />
        ) : openingAutomationBuilder && block === blocks.at(-1) ? (
          <AutomationBuilderLoadingState key={block.key} />
        ) : collapseProgress ? (
          <CollapsibleTimelineHistory key={block.key} entries={block.entries} />
        ) : (
          <ProgressTimelineWindow
            key={block.key}
            entries={block.entries}
            activeEntryKey={activeProgressEntryKey}
            activityLive={activityLive}
          />
        ),
      )}
      {message.files?.length ? (
        <div className="mt-[10px] pl-[30px]">
          <FileAttachments files={message.files} />
        </div>
      ) : null}
      {message.automations?.length ? (
        <div className="mt-[10px] pl-[30px]">
          <AutomationArtifactCards
            automations={message.automations}
            autoOpenAutomation={autoOpenAutomation}
            autoOpenKey={message.id}
            conversationId={conversationId}
          />
        </div>
      ) : null}
      {message.integrationConnections?.length ? (
        <div className="mt-[10px] pl-[30px]">
          <IntegrationConnectionCards
            connections={message.integrationConnections}
            statuses={integrationConnectionStatuses}
            onConnect={onConnectIntegration}
          />
        </div>
      ) : null}
    </div>
  );
}

function progressEntryItemCount(entries: TimelineRenderEntry[]): number {
  return entries.reduce((count, entry) => {
    if (entry.entry.type !== "progress") return count;
    return count + progressItemsForParts(entry.entry.progressItems, entry.entry.progressLines).length;
  }, 0);
}

function textTimelineEntryCount(entries: TimelineRenderEntry[]): number {
  return entries.filter((entry) => entry.entry.type === "text").length;
}

function timelineHistoryCountLabel(entries: TimelineRenderEntry[]): string {
  const toolCallCount = progressEntryItemCount(entries);
  const updateCount = textTimelineEntryCount(entries);
  const parts: string[] = [];

  if (toolCallCount > 0) parts.push(toolCallCount === 1 ? "1 tool call" : `${toolCallCount} tool calls`);
  if (updateCount > 0) parts.push(updateCount === 1 ? "1 update" : `${updateCount} updates`);
  return parts.length > 0 ? parts.join(", ") : "Timeline history";
}

function runningProgressItemCount(blocks: TimelineRenderBlock[], activityLive: boolean): number {
  if (!activityLive) return 0;
  return blocks.reduce((count, block) => {
    if (block.type !== "progress") return count;
    return count + progressItemsForTimelineEntries(block.entries).filter((item) => item.status === "running").length;
  }, 0);
}

function completedTimelineSegments(entries: TimelineRenderEntry[]): {
  activityEntries: TimelineRenderEntry[];
  finalEntry?: TimelineRenderEntry;
} {
  const finalEntry = entries.at(-1);
  if (finalEntry?.entry.type === "text" && entries.slice(0, -1).some((entry) => entry.entry.type === "progress")) {
    return { activityEntries: entries.slice(0, -1), finalEntry };
  }
  return { activityEntries: entries };
}

function CollapsibleTimelineHistory({
  entries,
  title = "Activity timeline",
}: { entries: TimelineRenderEntry[]; title?: string }) {
  const [expanded, setExpanded] = useState(false);
  const countLabel = timelineHistoryCountLabel(entries);

  return (
    <CollapsiblePrimitive.Root open={expanded} onOpenChange={setExpanded}>
      <CollapsiblePrimitive.Trigger asChild>
        <button
          type="button"
          aria-expanded={expanded}
          data-timeline-summary
          className={cn(
            "group grid w-full cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-[10px]",
            "rounded-[8px] py-[3px] text-left transition-colors duration-150 ease-out hover:bg-muted/35",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
          )}
        >
          <span className="relative z-[1] flex size-[20px] shrink-0 items-center justify-center rounded-[6px] bg-muted/60 text-muted-foreground/90">
            <ClockIcon size={13} weight="duotone" className="shrink-0" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium leading-[1.5] text-foreground/80">{title}</span>
            <span className="block text-[12px] leading-[1.4] text-muted-foreground/65">{countLabel}</span>
          </span>
          <CaretDownIcon
            size={14}
            className={cn(
              "mr-[4px] shrink-0 text-muted-foreground/70 transition-transform duration-150 ease-out",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="sketch-collapsible-timeline-content">
        <div data-timeline-history className="chat-scrollbar max-h-[260px] overflow-y-auto pt-[8px] pr-[4px] pl-[30px]">
          {entries.map((renderEntry, index) => (
            <TimelineEntryRow
              key={renderEntry.key}
              entry={renderEntry.entry}
              active={false}
              exiting={false}
              last={index === entries.length - 1}
            />
          ))}
        </div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

function progressItemsForTimelineEntries(entries: TimelineRenderEntry[]): ChatThreadProgressItem[] {
  return entries.flatMap((entry) =>
    entry.entry.type === "progress" ? progressItemsForParts(entry.entry.progressItems, entry.entry.progressLines) : [],
  );
}

function ProgressTimelineWindow({
  entries,
  activeEntryKey,
  activityLive,
}: {
  entries: TimelineRenderEntry[];
  activeEntryKey?: string;
  activityLive: boolean;
}) {
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(null);
  const [inspectionOpen, setInspectionOpen] = useState(false);
  useEffect(() => {
    if (expandedItemKey || !inspectionOpen) return;
    const timer = window.setTimeout(() => setInspectionOpen(false), 220);
    return () => window.clearTimeout(timer);
  }, [expandedItemKey, inspectionOpen]);
  const targetEntries = useMemo(
    () => (inspectionOpen ? entries : visibleProgressRenderEntries(entries)),
    [entries, inspectionOpen],
  );
  const timelineWindow = useAnimatedTimelineWindow(targetEntries, inspectionOpen);
  const exitingKeySet = useMemo(() => new Set(timelineWindow.exitingKeys), [timelineWindow.exitingKeys]);
  const earlierEntries = inspectionOpen ? [] : entries.slice(0, -MAX_VISIBLE_TIMELINE_PROGRESS_ENTRIES);

  return (
    <div className="pb-[10px] last:pb-0">
      {earlierEntries.length > 0 ? (
        <CollapsibleTimelineHistory entries={earlierEntries} title="Earlier activity" />
      ) : null}
      <div
        ref={timelineWindow.viewportRef}
        data-tool-call-window
        aria-live="polite"
        className="sketch-timeline-window chat-scrollbar max-h-[260px] overflow-x-hidden overflow-y-auto overscroll-contain"
        style={timelineWindow.viewportStyle}
      >
        <div
          ref={timelineWindow.trackRef}
          className={cn("flex flex-col", timelineWindow.animating && "sketch-timeline-window-track")}
          style={timelineWindow.trackStyle}
        >
          {timelineWindow.entries.map((renderEntry, index) => (
            <TimelineEntryRow
              key={renderEntry.key}
              rowRef={timelineWindow.setRowRef(renderEntry.key)}
              entry={renderEntry.entry}
              dataTimelineKey={renderEntry.key}
              active={renderEntry.key === activeEntryKey}
              exiting={exitingKeySet.has(renderEntry.key)}
              last={index === timelineWindow.entries.length - 1}
              expandedItemKey={expandedItemKey}
              onItemExpandedChange={(itemKey, expanded) => {
                if (expanded) setInspectionOpen(true);
                setExpandedItemKey(expanded ? itemKey : null);
              }}
              activityLive={activityLive}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TimelineEntryRow({
  entry,
  active,
  exiting,
  last,
  rowRef,
  expanded = false,
  onExpandedChange,
  expandedItemKey,
  onItemExpandedChange,
  dataTimelineKey,
  activityLive = false,
}: {
  entry: ChatThreadTimelineEntry;
  active: boolean;
  exiting: boolean;
  last: boolean;
  rowRef?: (node: HTMLDivElement | null) => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  expandedItemKey?: string | null;
  onItemExpandedChange?: (itemKey: string, expanded: boolean) => void;
  dataTimelineKey?: string;
  activityLive?: boolean;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const resolvedExpanded = onExpandedChange ? expanded : localExpanded;
  const handleExpandedChange = (next: boolean) => {
    if (onExpandedChange) onExpandedChange(next);
    else setLocalExpanded(next);
  };

  return (
    <div
      ref={rowRef}
      data-timeline-entry
      data-timeline-key={dataTimelineKey}
      className={cn(
        "sketch-progress-change sketch-timeline-entry relative grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-x-[10px] pb-[10px] last:pb-0",
        exiting && "sketch-timeline-entry-exiting",
      )}
    >
      {last ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute top-[23px] bottom-[-1px] left-[10px] w-px bg-border/80"
        />
      )}
      {entry.type === "text" ? (
        <TextTimelineEntry entry={entry} />
      ) : (
        <ProgressTimelineEntry
          items={progressItemsForParts(entry.progressItems, entry.progressLines)}
          active={active}
          expanded={resolvedExpanded}
          onExpandedChange={handleExpandedChange}
          expandedItemKey={expandedItemKey}
          onItemExpandedChange={onItemExpandedChange}
          activityLive={activityLive}
        />
      )}
    </div>
  );
}

function TextTimelineEntry({ entry }: { entry: Extract<ChatThreadTimelineEntry, { type: "text" }> }) {
  return (
    <>
      <span className="relative z-[1] mt-[4px] flex size-[20px] shrink-0 items-center justify-center">
        <span className="block size-[6px] rounded-full bg-muted-foreground/45" />
      </span>
      <div className="min-w-0 pt-[1px]">
        <MarkdownMessage text={entry.text} copyBlocks />
      </div>
    </>
  );
}

function ProgressTimelineEntry({
  items,
  active,
  expanded,
  onExpandedChange,
  expandedItemKey,
  onItemExpandedChange,
  activityLive = true,
}: {
  items: ChatThreadProgressItem[];
  active: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  expandedItemKey?: string | null;
  onItemExpandedChange?: (itemKey: string, expanded: boolean) => void;
  activityLive?: boolean;
}) {
  const iconItem = items[0];
  if (!iconItem) return null;

  return (
    <>
      <span className="relative z-[1] flex size-[20px] shrink-0 items-center justify-center rounded-[6px] bg-muted/60 text-muted-foreground/90">
        <ProgressItemIcon item={iconItem} active={active} activityLive={activityLive} />
      </span>
      <div className="min-w-0">
        {items.map((item, index) => (
          <ProgressItemSummary
            key={progressItemKey(item, index)}
            item={item}
            itemKey={progressItemKey(item, index)}
            active={active}
            activityLive={activityLive}
            expanded={expandedItemKey ? expandedItemKey === progressItemKey(item, index) : expanded}
            onExpandedChange={(next) => {
              if (onItemExpandedChange) onItemExpandedChange(progressItemKey(item, index), next);
              else onExpandedChange?.(next);
            }}
          />
        ))}
      </div>
    </>
  );
}

function progressItemIsActive(item: ChatThreadProgressItem, rowActive: boolean, activityLive: boolean): boolean {
  if (item.mode === "off") return false;
  if (item.status) return item.status === "running" && activityLive;
  return rowActive;
}

function progressStatusLabel(status: ChatThreadProgressItem["status"], activityLive: boolean): string | null {
  switch (status) {
    case "running":
      return activityLive ? null : "Running";
    case "succeeded":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default:
      return null;
  }
}

function useProgressElapsed(item: ChatThreadProgressItem, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || typeof item.startedAt !== "number") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [item.startedAt, running]);

  if (!running || typeof item.startedAt !== "number") return null;
  const seconds = Math.floor(Math.max(0, now - item.startedAt) / 1000);
  return seconds >= 10 ? seconds : null;
}

function formatElapsed(seconds: number): string {
  return seconds < 1 ? "<1s" : `${Math.floor(seconds)}s`;
}

function readableToolName(toolName: string): string {
  const name = toolName.match(/^mcp__.+?__(.+)$/)?.[1] ?? toolName;
  const words: Record<string, string> = {
    api: "API",
    clickup: "ClickUp",
    github: "GitHub",
    http: "HTTP",
    json: "JSON",
    sql: "SQL",
    url: "URL",
  };
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => words[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function progressDetailForDisplay(item: ChatThreadProgressItem): string | null {
  if (!item.detail) return null;
  return item.detail;
}

function ProgressItemSummary({
  item,
  itemKey,
  active,
  activityLive,
  expanded = false,
  onExpandedChange,
}: {
  item: ChatThreadProgressItem;
  itemKey: string;
  active: boolean;
  activityLive: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const summaryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const timer = window.setTimeout(() => {
      const summary = summaryRef.current;
      if (!summary) return;
      summary.focus({ preventScroll: true });
      const viewport = summary.closest<HTMLElement>("[data-tool-call-window], [data-timeline-history]");
      if (viewport) {
        viewport.scrollIntoView({ block: "nearest", behavior: "instant" });
        viewport.scrollTo({
          top: viewport.scrollTop + summary.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
          behavior: prefersReducedTimelineMotion() ? "instant" : "smooth",
        });
      } else {
        summary.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    }, 240);
    return () => window.clearTimeout(timer);
  }, [expanded]);
  const secondary = item.mode === "friendly" ? undefined : item.detail;
  const itemActive = progressItemIsActive(item, active, activityLive);
  const elapsed = useProgressElapsed(item, itemActive && item.status === "running");
  const statusLabel = item.mode === "off" ? null : progressStatusLabel(item.status, activityLive);
  const detail = progressDetailForDisplay(item);
  const inspectable =
    item.mode !== "off" &&
    Boolean(
      detail ||
        item.toolName ||
        item.status ||
        item.startedAt ||
        item.endedAt ||
        item.detailRedacted ||
        item.detailTruncated ||
        item.detailUnavailable,
    );
  const technical = item.mode === "technical";
  const displayLabel = technical && item.toolName === item.label ? readableToolName(item.label) : item.label;
  const detailNotice = `${item.detailRedacted ? "\n\nSome sensitive values were redacted." : ""}${
    item.detailTruncated ? "\n\nDetail was truncated at the retention limit." : ""
  }`;
  const copyText = detail || null;

  return (
    <div
      data-progress-item
      data-progress-item-key={itemKey}
      data-progress-status={item.status ?? undefined}
      className="min-w-0 py-[1px]"
    >
      <button
        ref={summaryRef}
        type="button"
        disabled={!inspectable}
        aria-expanded={inspectable ? expanded : undefined}
        aria-label={inspectable ? `${expanded ? "Hide" : "Show"} details for ${displayLabel}` : undefined}
        data-progress-line
        data-progress-details-toggle={inspectable ? "" : undefined}
        onClick={() => onExpandedChange?.(!expanded)}
        className={cn(
          "flex w-full min-w-0 items-baseline gap-x-[8px] rounded-[5px] py-[3px] text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
          inspectable && "cursor-pointer hover:bg-muted/45",
          itemActive && "sketch-shimmer-progress",
        )}
      >
        <span
          className={cn(
            "min-w-0 max-w-[55%] shrink-0 truncate text-[13px] font-medium leading-[1.5]",
            !itemActive && "text-foreground/80",
          )}
        >
          {displayLabel}
        </span>
        {secondary ? (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[12px] leading-[1.5]",
              !itemActive && "text-muted-foreground/65",
            )}
          >
            {secondary}
          </span>
        ) : null}
        {statusLabel ? (
          item.status === "succeeded" || item.status === "failed" ? (
            <span
              role="img"
              aria-label={item.status === "succeeded" ? "Succeeded" : "Failed"}
              title={item.status === "succeeded" ? "Succeeded" : "Failed"}
              className={cn(
                "inline-flex shrink-0 self-center",
                item.status === "succeeded" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
              )}
            >
              {item.status === "succeeded" ? (
                <CheckIcon size={14} weight="bold" aria-hidden />
              ) : (
                <XIcon size={14} weight="bold" aria-hidden />
              )}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] leading-[1.5] text-muted-foreground/55">{statusLabel}</span>
          )
        ) : null}
        {elapsed !== null ? (
          <span className="shrink-0 text-[11px] leading-[1.5] text-muted-foreground/55">{formatElapsed(elapsed)}</span>
        ) : null}
        {inspectable ? (
          <span className="inline-flex size-[20px] shrink-0 items-center justify-center text-muted-foreground/65">
            <CaretDownIcon
              size={12}
              className={cn("transition-transform duration-150", expanded && "rotate-180")}
              aria-hidden
            />
          </span>
        ) : null}
      </button>
      <CollapsiblePrimitive.Root open={expanded && inspectable}>
        <CollapsiblePrimitive.Content className="sketch-collapsible-timeline-content">
          <div className="mt-[4px] max-w-full rounded-[6px] border border-border/60 bg-muted/20 p-[7px]">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {technical && item.toolName ? (
                  <div
                    data-progress-qualified-tool
                    className="mb-[4px] break-words font-medium text-[11px] leading-[1.5] text-muted-foreground/75"
                  >
                    {readableToolName(item.toolName)}
                  </div>
                ) : null}
                <pre
                  data-progress-details
                  className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-[1.5] text-foreground/80"
                >
                  {detail ?? "Input request details unavailable for this tool call."}
                </pre>
                {detailNotice ? (
                  <div className="mt-[4px] whitespace-pre-wrap text-[11px] leading-[1.5] text-muted-foreground/70">
                    {detailNotice.trim()}
                  </div>
                ) : null}
              </div>
              {copyText ? (
                <CopyIconButton text={copyText} label="Copy input request" copiedLabel="Input request copied" />
              ) : null}
            </div>
          </div>
        </CollapsiblePrimitive.Content>
      </CollapsiblePrimitive.Root>
    </div>
  );
}

function ProgressItemIcon({
  item,
  active,
  activityLive = true,
}: { item: ChatThreadProgressItem; active: boolean; activityLive?: boolean }) {
  if (item.integration) {
    return (
      <span className="relative flex size-[20px] items-center justify-center">
        <AppIcon
          name={item.integration.name}
          icon={item.integration.icon}
          className="size-[20px] rounded-[6px]"
          imageClassName="size-[14px]"
        />
        {item.mode !== "off" && ((item.status === "running" && activityLive) || (!item.status && active)) ? (
          <span
            aria-hidden
            className="absolute -right-[2px] -top-[2px] size-[6px] animate-pulse rounded-full bg-brand-accent ring-2 ring-background motion-reduce:animate-none"
          />
        ) : null}
      </span>
    );
  }
  const Icon = progressIconForItem(item);
  const loading = Icon === SpinnerGapIcon && progressItemIsActive(item, active, activityLive);
  return <Icon size={13} weight="duotone" className={cn("shrink-0", loading && "animate-spin")} aria-hidden />;
}

function copyableCodeText(children: ReactNode): string | null {
  const value = textFromReactNode(children).replace(/\n$/, "");
  return value ? value : null;
}

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {}

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("Copy command failed");
  } finally {
    document.body.removeChild(textarea);
  }
}

function CopyIconButton({
  text,
  label,
  copiedLabel,
  className,
}: {
  text: string;
  label: string;
  copiedLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      await copyTextToClipboard(text);
      setCopied(true);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? copiedLabel : label}
      title={copied ? "Copied" : label}
      className={cn(
        "inline-flex size-[24px] shrink-0 items-center justify-center rounded-[6px]",
        "text-muted-foreground/70 transition-colors duration-150 hover:bg-muted/65 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
        className,
      )}
    >
      {copied ? <CheckIcon size={14} weight="bold" aria-hidden /> : <CopySimpleIcon size={14} aria-hidden />}
    </button>
  );
}

function MarkdownParagraph({ children }: { children?: ReactNode }) {
  const copyText = textFromReactNode(children).trim();

  return (
    <p className={cn(copyText && "group relative pr-[32px]")}>
      {children}
      {copyText ? (
        <CopyIconButton
          text={copyText}
          label="Copy text block"
          copiedLabel="Text block copied"
          className="absolute top-[1px] right-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        />
      ) : null}
    </p>
  );
}

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const copyText = copyableCodeText(children);

  return (
    <div className="group relative my-3 max-w-full">
      <pre className="!my-0 pr-[44px]">{children}</pre>
      {copyText ? (
        <CopyIconButton
          text={copyText}
          label="Copy code block"
          copiedLabel="Code block copied"
          className="absolute top-[8px] right-[8px] bg-background/75 opacity-0 shadow-sm backdrop-blur group-hover:opacity-100 group-focus-within:opacity-100"
        />
      ) : null}
    </div>
  );
}

function MarkdownMessage({
  text,
  inProgress = false,
  copyBlocks = false,
}: {
  text: string;
  inProgress?: boolean;
  copyBlocks?: boolean;
}) {
  return (
    <div className={cn("markdown-body", inProgress && "sketch-response-fading")}>
      <ReactMarkdown
        components={copyBlocks ? markdownComponentsWithCopy : markdownComponents}
        remarkPlugins={markdownPlugins}
        skipHtml
      >
        {normalizeChatMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}
