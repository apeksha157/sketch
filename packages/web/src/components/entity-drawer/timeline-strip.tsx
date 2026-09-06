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
 *
 * The two jobs are separate controls: the title opens the file itself in a
 * `FileDetailSheet` the strip owns, so every host gets file reading for free,
 * while a chevron toggles the inline quotes where quotes can exist at all.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { type EntityTimelineGroup, type EntityTimelineItem, api } from "@/lib/api";
import { FileDetailSheet } from "@/routes/files/file-detail-sheet";
import {
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
  /** Enables per-file mention expansion; without it rows only unclamp. */
  entityId?: string;
  /**
   * Custom quote source for rows without an entity behind them (review
   * evidence): expansion calls this instead of the entity-mentions endpoint.
   * `quotesScope` keys the cache — pass something stable like the review id.
   */
  loadQuotes?: (item: EntityTimelineItem) => Promise<(string | null)[]>;
  quotesScope?: string;
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
 * The drill-down: every quote of the entity in this one file, deduped, once
 * the row expands. Fetched lazily per expansion from whichever source the
 * strip was given (entity mentions, or a custom loader for review evidence).
 */
function ExpandedQuotes({
  scope,
  item,
  primarySnippet,
  load,
}: {
  scope: string;
  item: EntityTimelineItem;
  primarySnippet: string | null;
  load: (item: EntityTimelineItem) => Promise<(string | null)[]>;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["timeline-quotes", scope, item.fileId],
    queryFn: () => load(item),
  });
  if (isLoading) return <p className="mt-1 text-[11px] text-muted-foreground">Loading mentions…</p>;
  const seen = new Set<string>(primarySnippet ? [primarySnippet.toLowerCase()] : []);
  const quotes: string[] = [];
  for (const raw of data ?? []) {
    const snippet = usefulSnippet(raw, item.fileName);
    if (!snippet || seen.has(snippet.toLowerCase())) continue;
    seen.add(snippet.toLowerCase());
    quotes.push(snippet);
  }
  if (quotes.length === 0) {
    // The primary snippet un-clamps on expand, so text WAS found and is
    // already showing — claiming otherwise reads as a bug. Only say it
    // when there is truly nothing to show.
    if (primarySnippet) return null;
    return <p className="mt-1 text-[11px] italic text-muted-foreground/70">No quotable text found in this file.</p>;
  }
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

function TimelineRow({
  item,
  entityId,
  loadQuotes,
  quotesScope,
  onOpenFile,
}: {
  item: EntityTimelineItem;
  entityId?: string;
  loadQuotes?: (item: EntityTimelineItem) => Promise<(string | null)[]>;
  quotesScope?: string;
  onOpenFile: (fileId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const quotesId = useId();
  const meta = item.crmActivity
    ? (ACTIVITY_META[item.crmActivity.activityType] ?? { Icon: FileTextIcon, label: "Activity" })
    : null;
  const snippet = item.crmActivity ? null : usefulSnippet(item.contextSnippet, item.fileName);
  const load =
    loadQuotes ??
    (entityId
      ? async (target: EntityTimelineItem) => {
          const { quotes } = await api.entities.snippets(entityId, target.fileId);
          if (quotes.length > 0) return quotes;
          const res = await api.entities.mentions(entityId, { fileId: target.fileId, limit: 25 });
          return res.mentions.map((mention) => mention.contextSnippet);
        }
      : undefined);
  const scope = loadQuotes ? (quotesScope ?? "custom") : (entityId ?? "none");
  const expandable = !item.crmActivity && (snippet !== null || !!loadQuotes || (item.mentionCount > 1 && !!entityId));
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
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="-mx-1.5 flex items-start gap-1">
          <button
            type="button"
            onClick={() => onOpenFile(item.fileId)}
            className="min-w-0 flex-1 cursor-pointer rounded-md px-1.5 text-left transition-colors hover:bg-muted/40"
          >
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-snug text-foreground">
                {item.fileName}
              </span>
              {time ? <span className="shrink-0 pt-px text-[10px] text-muted-foreground">{time}</span> : null}
            </span>
          </button>
          {expandable ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-label="Show quotes"
              aria-expanded={expanded}
              aria-controls={quotesId}
              className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <CaretDownIcon size={12} className={cn("transition-transform", expanded && "rotate-180")} />
            </button>
          ) : null}
        </div>
        {snippet ? (
          <p className={cn("mt-0.5 text-[11px] leading-snug text-muted-foreground", !expanded && "line-clamp-2")}>
            {snippet}
          </p>
        ) : null}
        <div id={quotesId}>
          {expanded && load ? <ExpandedQuotes scope={scope} item={item} primarySnippet={snippet} load={load} /> : null}
        </div>
        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/70">
          <span className="truncate">{attribution.join(" · ")}</span>
          {item.crmActivity?.hasBody ? <SparkleIcon size={10} weight="fill" className="shrink-0 text-primary" /> : null}
        </p>
      </div>
    </div>
  );
}

export function TimelineStrip({ groups, entityId, loadQuotes, quotesScope }: TimelineStripProps) {
  const items = groups.flatMap((g) => g.items);
  const dayGroups = groupByDay(items);
  const [openFileId, setOpenFileId] = useState<string | null>(null);

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
                  onOpenFile={setOpenFileId}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <FileDetailSheet fileId={openFileId} onClose={() => setOpenFileId(null)} />
    </div>
  );
}
