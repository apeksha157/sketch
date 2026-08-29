/**
 * Vertical timeline for the entity drawer, day-grouped with a rail.
 *
 * Row anatomy: the file's title (for email that IS the subject line) leads,
 * the mention snippet sits under it clamped to two lines, and the source ·
 * count attribution closes the row. Day headers carry the date, so rows only
 * show a clock time — and only when the source recorded one (date-only files
 * would all read "12:00 AM").
 *
 * Snippets are working data from the matcher and can be junk for structured
 * sources (gmail facts store "Corresponded {id}"); junk is suppressed rather
 * than shown. Expanding a row unclamps the snippet and fetches every mention
 * of the entity in that file, so ×N actually opens into N quotes.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { type EntityTimelineGroup, type EntityTimelineItem, api } from "@/lib/api";
import {
  CalendarBlankIcon,
  CheckCircleIcon,
  FileTextIcon,
  NoteIcon,
  PhoneIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

interface TimelineStripProps {
  groups: EntityTimelineGroup[];
  /** Enables per-file mention expansion; without it rows only unclamp. */
  entityId?: string;
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
 */
export function usefulSnippet(snippet: string | null, fileName: string): string | null {
  if (!snippet) return null;
  const trimmed = snippet.trim();
  if (trimmed.length === 0) return null;
  if (/^corresponded [0-9a-f]{6,}$/i.test(trimmed)) return null;
  if (trimmed.toLowerCase() === fileName.trim().toLowerCase()) return null;
  return trimmed;
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

/**
 * The ×N drill-down: every mention of the entity in this one file, shown as
 * deduped quotes once the row expands. Fetched lazily per expansion.
 */
function ExpandedMentions({
  entityId,
  item,
  primarySnippet,
}: {
  entityId: string;
  item: EntityTimelineItem;
  primarySnippet: string | null;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-mentions", entityId, item.fileId],
    queryFn: () => api.entities.mentions(entityId, { fileId: item.fileId, limit: 25 }),
  });
  if (isLoading) return <p className="mt-1 text-[11px] text-muted-foreground">Loading mentions…</p>;
  const seen = new Set<string>(primarySnippet ? [primarySnippet.toLowerCase()] : []);
  const quotes: string[] = [];
  for (const mention of data?.mentions ?? []) {
    const snippet = usefulSnippet(mention.contextSnippet, item.fileName);
    if (!snippet || seen.has(snippet.toLowerCase())) continue;
    seen.add(snippet.toLowerCase());
    quotes.push(snippet);
  }
  if (quotes.length === 0) return null;
  return (
    <div className="mt-1 space-y-1 border-l-2 border-border pl-2">
      {quotes.map((quote) => (
        <p key={quote} className="text-[11px] leading-snug text-muted-foreground">
          {quote}
        </p>
      ))}
    </div>
  );
}

function TimelineRow({ item, entityId }: { item: EntityTimelineItem; entityId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const meta = item.crmActivity
    ? (ACTIVITY_META[item.crmActivity.activityType] ?? { Icon: FileTextIcon, label: "Activity" })
    : null;
  const snippet = item.crmActivity ? null : usefulSnippet(item.contextSnippet, item.fileName);
  const expandable = !item.crmActivity && (snippet !== null || (item.mentionCount > 1 && !!entityId));
  const time = clockTime(item.occurredAt);

  const attribution: string[] = [];
  if (meta) attribution.push(meta.label);
  else attribution.push(sourceLabel(item.sourceType));
  if (item.mentionCount > 1) attribution.push(`×${item.mentionCount}`);

  return (
    <div className="relative flex gap-2.5 pb-3.5 last:pb-0">
      <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
        <Glyph item={item} />
      </span>
      <button
        type="button"
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
        aria-expanded={expandable ? expanded : undefined}
        className={cn(
          "min-w-0 flex-1 rounded-md pt-0.5 text-left",
          expandable && "-mx-1.5 cursor-pointer px-1.5 transition-colors hover:bg-muted/40",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-snug text-foreground">
            {item.fileName}
          </p>
          {time ? <span className="shrink-0 pt-px text-[10px] text-muted-foreground">{time}</span> : null}
        </div>
        {snippet ? (
          <p className={cn("mt-0.5 text-[11px] leading-snug text-muted-foreground", !expanded && "line-clamp-2")}>
            {snippet}
          </p>
        ) : null}
        {expanded && entityId ? <ExpandedMentions entityId={entityId} item={item} primarySnippet={snippet} /> : null}
        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/70">
          <span className="truncate">{attribution.join(" · ")}</span>
          {item.crmActivity?.hasBody ? <SparkleIcon size={10} weight="fill" className="shrink-0 text-primary" /> : null}
        </p>
      </button>
    </div>
  );
}

export function TimelineStrip({ groups, entityId }: TimelineStripProps) {
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
                <TimelineRow key={item.fileId} item={item} entityId={entityId} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
