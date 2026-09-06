/**
 * Vertical timeline for the entity drawer, day-grouped with a rail.
 *
 * Row anatomy: the file's title (for email that IS the subject line) and a
 * clock time on line one — day headers carry the date, so a time only shows
 * when the source recorded one. Line two names how the file links the entity
 * (Attended, Sent, Mentioned, …), its source, and how many passages an
 * extractor found. Matcher working data — the stored snippet and the ×N
 * mention count — is deliberately not rendered; it read as noise.
 *
 * The whole row is one button and expands in place. Two link kinds share one
 * expansion model with a pluggable passages source: structural rows (attendee,
 * sender, CRM record) go straight to the file's text, LLM-identified rows show
 * their passages first with "Show whole file" underneath. Review hosts have no
 * entity behind the row, so they pass `loadQuotes` and get the same shape.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { FileContentPreview } from "@/components/file-content-preview";
import { ApiRequestError, type EntityTimelineGroup, type EntityTimelineItem, api } from "@/lib/api";
import {
  ArrowSquareOutIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CheckCircleIcon,
  FileTextIcon,
  NoteIcon,
  PhoneIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

interface TimelineStripProps {
  groups: EntityTimelineGroup[];
  /** Enables the passages endpoint for rows whose mentions carry chunk indexes. */
  entityId?: string;
  /**
   * Custom passages source for rows without an entity behind them (review
   * evidence): expansion calls this instead of the passages endpoint.
   * `quotesScope` keys the cache — pass something stable like the review id.
   */
  loadQuotes?: (item: EntityTimelineItem) => Promise<(string | null)[]>;
  quotesScope?: string;
  /** Name to mark inside passages; hosts without an entity in hand omit it. */
  highlight?: string;
}

const CONNECTOR_GLYPHS = new Set([
  "google_drive",
  "gmail",
  "google_calendar",
  "outlook",
  "outlook_calendar",
  "teams",
  "clickup",
  "notion",
  "linear",
  "otter",
  "linkedin_aimfox",
  "zoho_crm",
  "whatsapp",
]);

function connectorGlyphType(sourceType: string): string | null {
  if (CONNECTOR_GLYPHS.has(sourceType)) return sourceType;
  const prefix = ["clickup", "notion", "linear", "google_drive"].find((p) => sourceType.startsWith(`${p}_`));
  return prefix ?? null;
}

function sourceLabel(sourceType: string): string {
  return sourceType.replace(/_/g, " ");
}

/**
 * Filter matcher-noise snippets: synthetic fact strings ("Corresponded
 * {hexid}") and snippets that just repeat the title add nothing under it.
 * The strip no longer renders snippets, but the review band still folds
 * evidence rows with it.
 */
export function usefulSnippet(snippet: string | null, fileName: string): string | null {
  if (!snippet) return null;
  const trimmed = snippet.trim();
  if (trimmed.length === 0) return null;
  if (/^corresponded [0-9a-f]{6,}$/i.test(trimmed)) return null;
  if (trimmed.toLowerCase() === fileName.trim().toLowerCase()) return null;
  return trimmed;
}

const RELATION_LABELS: Record<string, string> = {
  attended: "Attended",
  authored: "Sent",
  corresponded: "Corresponded",
  assigned: "Assigned",
  mentioned: "Mentioned",
  seeded: "Record",
  contactable: "Contact",
};

function relationLabel(relation: string): string {
  const known = RELATION_LABELS[relation];
  if (known) return known;
  const spaced = relation.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A file can carry both kinds; the structural link is the stronger claim. */
function primaryRelation(relations: string[]): string {
  return relations.find((r) => r !== "mentioned") ?? "mentioned";
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  const now = new Date();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function clockTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const ACTIVITY_META = {
  call: { Icon: PhoneIcon, label: "Call" },
  task: { Icon: CheckCircleIcon, label: "Task" },
  event: { Icon: CalendarBlankIcon, label: "Event" },
  meeting: { Icon: CalendarBlankIcon, label: "Meeting" },
  note: { Icon: NoteIcon, label: "Note" },
};

interface DayGroup {
  key: string;
  label: string;
  items: EntityTimelineItem[];
}

function groupByDay(items: EntityTimelineItem[]): DayGroup[] {
  const out: DayGroup[] = [];
  for (const item of items) {
    const d = new Date(item.occurredAt);
    const key = Number.isNaN(d.getTime()) ? "unknown" : d.toDateString();
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label: dayLabel(item.occurredAt), items: [item] });
  }
  return out;
}

function Glyph({ item }: { item: EntityTimelineItem }) {
  if (item.crmActivity) {
    const meta = ACTIVITY_META[item.crmActivity.activityType] ?? { Icon: FileTextIcon, label: "Activity" };
    const ActIcon = meta.Icon;
    return <ActIcon size={12} aria-hidden />;
  }
  const glyphType = connectorGlyphType(item.sourceType);
  if (glyphType) return <ConnectorLogo type={glyphType} size={12} />;
  return <FileTextIcon size={12} aria-hidden />;
}

interface HighlightSegment {
  start: number;
  text: string;
  match: boolean;
}

/**
 * Split on the needle by index rather than a built regex: the needle is an
 * entity display name and would otherwise need escaping to stay literal.
 */
function highlightSegments(text: string, needle: string): HighlightSegment[] {
  const out: HighlightSegment[] = [];
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const hit = haystack.indexOf(target, cursor);
    if (hit === -1) break;
    if (hit > cursor) out.push({ start: cursor, text: text.slice(cursor, hit), match: false });
    out.push({ start: hit, text: text.slice(hit, hit + needle.length), match: true });
    cursor = hit + needle.length;
  }
  if (cursor < text.length) out.push({ start: cursor, text: text.slice(cursor), match: false });
  return out;
}

function Highlighted({ text, needle }: { text: string; needle?: string }) {
  const target = needle?.trim();
  if (!target) return <>{text}</>;
  const segments = highlightSegments(text, target);
  if (!segments.some((s) => s.match)) return <>{text}</>;
  return (
    <>
      {segments.map((segment) =>
        segment.match ? (
          <mark key={segment.start} className="rounded-sm bg-primary/20 px-0.5 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The file's stored text, shared with the Files page under the same query key
 * so an expansion and the sheet never fetch twice.
 */
function WholeFile({ fileId }: { fileId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["file-content", fileId],
    queryFn: () => api.integrations.fileContent(fileId),
    retry: (failureCount, err) =>
      err instanceof ApiRequestError && (err.status === 403 || err.status === 404) ? false : failureCount < 3,
  });

  if (isLoading) return <p className="text-[11px] text-muted-foreground">Loading…</p>;
  if (error instanceof ApiRequestError && error.status === 403)
    return <p className="text-[11px] text-muted-foreground">You don't have access to this file's contents.</p>;
  const file = data?.file;
  if (!file) return <p className="text-[11px] text-muted-foreground">File not found.</p>;

  return (
    <div className="space-y-1">
      {file.content ? (
        <FileContentPreview content={file.content} heading={null} />
      ) : (
        <p className="text-[11px] text-muted-foreground">No text stored for this file.</p>
      )}
      {file.providerUrl ? (
        <a
          href={file.providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[11px] text-primary hover:underline"
        >
          Open in source
          <ArrowSquareOutIcon size={12} />
        </a>
      ) : null}
    </div>
  );
}

interface RowExpansionProps {
  item: EntityTimelineItem;
  entityId?: string;
  loadQuotes?: (item: EntityTimelineItem) => Promise<(string | null)[]>;
  quotesScope?: string;
  highlight?: string;
}

/**
 * One expansion model, two entry points: with a passages source the row leads
 * with the passages and hides the file body behind "Show whole file";
 * without one it is the file body straight away.
 */
function RowExpansion({ item, entityId, loadQuotes, quotesScope, highlight }: RowExpansionProps) {
  const fromEndpoint = !loadQuotes && !!entityId && (item.passageCount ?? 0) > 0;
  const hasPassages = !!loadQuotes || fromEndpoint;
  const [showWholeFile, setShowWholeFile] = useState(!hasPassages);

  const scope = loadQuotes ? (quotesScope ?? "custom") : (entityId ?? "none");
  const passagesQuery = useQuery({
    queryKey: ["timeline-passages", scope, item.fileId],
    queryFn: async () => {
      if (loadQuotes) {
        const quotes = await loadQuotes(item);
        return quotes.filter((q): q is string => !!q && q.trim().length > 0).map((q) => q.trim());
      }
      const { passages } = await api.entities.passages(entityId as string, item.fileId);
      return passages.map((p) => p.text);
    },
    enabled: hasPassages,
  });

  const passages = [...new Set(passagesQuery.data ?? [])];

  return (
    <div className="mt-1.5 space-y-2 border-l-2 border-border pl-2.5">
      {hasPassages ? (
        passagesQuery.isLoading ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : passages.length > 0 ? (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Where they come up</p>
            <div className="mt-1 divide-y divide-border">
              {passages.map((text) => (
                <p key={text} className="py-1.5 text-[11px] leading-snug text-muted-foreground first:pt-0 last:pb-0">
                  <Highlighted text={text} needle={highlight} />
                </p>
              ))}
            </div>
          </div>
        ) : null
      ) : null}
      {showWholeFile ? (
        <WholeFile fileId={item.fileId} />
      ) : (
        <button
          type="button"
          onClick={() => setShowWholeFile(true)}
          className="cursor-pointer text-[11px] text-primary hover:underline"
        >
          Show whole file
        </button>
      )}
    </div>
  );
}

function TimelineRow({
  item,
  entityId,
  loadQuotes,
  quotesScope,
  highlight,
}: {
  item: EntityTimelineItem;
  entityId?: string;
  loadQuotes?: (item: EntityTimelineItem) => Promise<(string | null)[]>;
  quotesScope?: string;
  highlight?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  const activity = item.crmActivity
    ? (ACTIVITY_META[item.crmActivity.activityType] ?? { Icon: FileTextIcon, label: "Activity" })
    : null;
  const time = clockTime(item.occurredAt);

  const attribution: string[] = [];
  if (activity) {
    attribution.push(activity.label);
  } else {
    const relations = item.relations ?? [];
    if (relations.length > 0) attribution.push(relationLabel(primaryRelation(relations)));
    attribution.push(sourceLabel(item.sourceType));
    const passageCount = item.passageCount ?? 0;
    if (passageCount > 0) attribution.push(`${passageCount} ${passageCount === 1 ? "passage" : "passages"}`);
  }

  return (
    <div className="relative flex gap-2.5 pb-3.5 last:pb-0">
      <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
        <Glyph item={item} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={regionId}
          className="-mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-start gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-muted/40"
        >
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-snug text-foreground">
            {item.fileName}
          </span>
          {time ? <span className="shrink-0 pt-px text-[10px] text-muted-foreground">{time}</span> : null}
          <CaretDownIcon
            size={12}
            className={cn("mt-0.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
          />
        </button>
        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/70">
          <span className="truncate">{attribution.join(" · ")}</span>
          {item.crmActivity?.hasBody ? <SparkleIcon size={10} weight="fill" className="shrink-0 text-primary" /> : null}
        </p>
        <div id={regionId}>
          {expanded ? (
            <RowExpansion
              item={item}
              entityId={entityId}
              loadQuotes={loadQuotes}
              quotesScope={quotesScope}
              highlight={highlight}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function TimelineStrip({ groups, entityId, loadQuotes, quotesScope, highlight }: TimelineStripProps) {
  const items = groups.flatMap((g) => g.items);
  const dayGroups = groupByDay(items);

  return (
    <div data-testid="timeline-strip">
      <div className="mb-2 text-[10px] text-muted-foreground">
        {items.length === 0 ? "No entries" : items.length === 1 ? "1 entry" : `${items.length} entries`}
      </div>
      <div className="flex flex-col gap-4">
        {dayGroups.map((group) => (
          <div key={group.key}>
            <p className="mb-2 text-xs font-semibold text-muted-foreground">{group.label}</p>
            <div className="relative">
              <div aria-hidden className="absolute bottom-1 left-[11px] top-1 w-px bg-border" />
              {group.items.map((item) => (
                <TimelineRow
                  key={item.fileId}
                  item={item}
                  entityId={entityId}
                  loadQuotes={loadQuotes}
                  quotesScope={quotesScope}
                  highlight={highlight}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
