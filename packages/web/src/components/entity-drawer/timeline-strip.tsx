/**
 * Vertical timeline for the entity drawer, day-grouped with a rail.
 *
 * The mention snippet is the row's content; the file name is demoted to the
 * attribution line underneath. Day headers carry the date ("Today",
 * "Yesterday", "May 22"), so rows only show a clock time — and only when the
 * source recorded one (date-only files would all read "12:00 AM"). Rows with
 * a snippet expand in place to the full snippet.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import type { EntityTimelineGroup, EntityTimelineItem } from "@/lib/api";
import {
  CalendarBlankIcon,
  CheckCircleIcon,
  FileTextIcon,
  NoteIcon,
  PhoneIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { useState } from "react";

interface TimelineStripProps {
  groups: EntityTimelineGroup[];
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

function TimelineRow({ item }: { item: EntityTimelineItem }) {
  const [expanded, setExpanded] = useState(false);
  const snippet = item.crmActivity ? null : item.contextSnippet;
  const meta = item.crmActivity
    ? (ACTIVITY_META[item.crmActivity.activityType] ?? { Icon: FileTextIcon, label: "Activity" })
    : null;
  const primary = snippet ?? item.fileName;
  const time = clockTime(item.occurredAt);

  const attribution: string[] = [];
  if (snippet) attribution.push(item.fileName);
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
        onClick={snippet ? () => setExpanded((v) => !v) : undefined}
        aria-expanded={snippet ? expanded : undefined}
        className={cn(
          "min-w-0 flex-1 rounded-md pt-0.5 text-left",
          snippet && "-mx-1.5 cursor-pointer px-1.5 transition-colors hover:bg-muted/40",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <p
            className={cn(
              "min-w-0 flex-1 text-[12.5px] leading-snug",
              snippet ? "text-foreground" : "font-medium text-foreground",
              snippet && !expanded && "line-clamp-2",
            )}
          >
            {primary}
          </p>
          {time ? <span className="shrink-0 pt-px text-[10px] text-muted-foreground">{time}</span> : null}
        </div>
        <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className="truncate">{attribution.join(" · ")}</span>
          {item.crmActivity?.hasBody ? <SparkleIcon size={10} weight="fill" className="shrink-0 text-primary" /> : null}
        </p>
      </button>
    </div>
  );
}

export function TimelineStrip({ groups }: TimelineStripProps) {
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
                <TimelineRow key={item.fileId} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
