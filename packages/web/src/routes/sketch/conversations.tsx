/**
 * /conversations — §5.11. Full conversation history with date grouping,
 * channel filters, and in-place text search.
 *
 * Sidebar: Home stays the active nav item because /conversations is
 * conceptually a sub-route of home (§4.1 active-route logic).
 */
import { ConversationRow, type ConversationRowProps } from "@/components/sketch/conversation-row";
import { DateGroupHeader } from "@/components/sketch/date-group-header";
import { FilterPill } from "@/components/sketch/filter-pill";
import { BrowserIcon, GridIcon, SearchIcon, SlackBrandIcon, WhatsappBrandIcon } from "@/components/sketch/icons";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_ALL_CONVERSATIONS, MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { cn } from "@sketch/ui/lib/utils";
import { Link, createRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

type FilterKey = "all" | "slack" | "whatsapp" | "web";

/**
 * Warm, action-inviting subtitles. Randomised once on mount so each page
 * load has its own framing without flickering on re-render. Frames the
 * page as a place to resume rather than as a static history list.
 */
const SUBTITLE_OPTIONS = [
  "Pick up where you left off.",
  "Jump back in.",
  "Resume any conversation.",
  "Pick a thread, keep going.",
  "Where would you like to pick up?",
] as const;

function pickSubtitle(): string {
  return SUBTITLE_OPTIONS[Math.floor(Math.random() * SUBTITLE_OPTIONS.length)];
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

interface DateGroup {
  label: string;
  /** Month index relative to the current month. Used for sorting; not rendered. */
  sortKey: number;
  items: ConversationRowProps[];
}

/**
 * Buckets a list of conversations into date groups for display.
 *
 * Group labels are intentionally consistent in style — temporal where
 * the user expects it ("Today", "Yesterday", "This week", "This month",
 * "Earlier") and calendar-only for prior months ("April"). The earlier
 * "This May" mix of temporal+calendar was confusing.
 */
function groupByDate(items: ConversationRowProps[], now: Date): DateGroup[] {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const today: ConversationRowProps[] = [];
  const yesterday: ConversationRowProps[] = [];
  const thisWeek: ConversationRowProps[] = [];
  const thisMonth: ConversationRowProps[] = [];
  const monthGroups = new Map<string, { items: ConversationRowProps[]; monthIndex: number }>();
  const earlier: ConversationRowProps[] = [];

  for (const item of items) {
    const t = new Date(item.occurredAt).getTime();
    if (t >= todayStart) today.push(item);
    else if (t >= yesterdayStart) yesterday.push(item);
    else if (t >= weekStart) thisWeek.push(item);
    else if (t >= monthStart) thisMonth.push(item);
    else {
      const occurred = new Date(item.occurredAt);
      if (occurred.getFullYear() === now.getFullYear()) {
        const key = MONTH_NAMES[occurred.getMonth()];
        const entry = monthGroups.get(key);
        if (entry) {
          entry.items.push(item);
        } else {
          monthGroups.set(key, { items: [item], monthIndex: occurred.getMonth() });
        }
      } else {
        earlier.push(item);
      }
    }
  }

  const groups: DateGroup[] = [];
  if (today.length) groups.push({ label: "Today", sortKey: 100, items: today });
  if (yesterday.length) groups.push({ label: "Yesterday", sortKey: 99, items: yesterday });
  if (thisWeek.length) groups.push({ label: "This week", sortKey: 98, items: thisWeek });
  if (thisMonth.length) groups.push({ label: "This month", sortKey: 97, items: thisMonth });
  // Prior-month groups sorted descending by month index so May > April > March,
  // independent of which item was inserted into the Map first.
  const priorMonths = [...monthGroups.entries()].sort(([, a], [, b]) => b.monthIndex - a.monthIndex);
  for (const [label, { items: list, monthIndex }] of priorMonths) {
    groups.push({ label, sortKey: monthIndex, items: list });
  }
  if (earlier.length) groups.push({ label: "Earlier", sortKey: -1, items: earlier });
  return groups;
}

function ConversationsPage() {
  const auth = useSketchAuth();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().toLowerCase();
  // Init via lazy useState so the random pick happens exactly once per mount.
  const [subtitle] = useState(pickSubtitle);

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = {
      all: MOCK_ALL_CONVERSATIONS.length,
      slack: 0,
      whatsapp: 0,
      web: 0,
    };
    for (const item of MOCK_ALL_CONVERSATIONS) c[item.channel]++;
    return c;
  }, []);

  const filtered = useMemo(() => {
    const byChannel =
      filter === "all" ? MOCK_ALL_CONVERSATIONS : MOCK_ALL_CONVERSATIONS.filter((c) => c.channel === filter);
    if (!trimmedQuery) return byChannel;
    return byChannel.filter((c) => c.title.toLowerCase().includes(trimmedQuery));
  }, [filter, trimmedQuery]);

  const groups = useMemo(() => groupByDate(filtered, new Date()), [filtered]);

  const totalConversations = MOCK_ALL_CONVERSATIONS.length;
  const isWorkspaceEmpty = totalConversations === 0;

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      files={MOCK_FILES}
    >
      <div className="mx-auto max-w-4xl px-10 py-8">
        {/* Header — matches the H1 + subtitle pattern used by GreetingBar
         * (home) and scheduled-tasks: text-xl semibold + mt-2 text-sm muted. */}
        <header>
          <h1 className="text-xl font-semibold text-foreground">Conversations</h1>
          {!isWorkspaceEmpty && <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>}
        </header>

        {/* mt-6 between header and first content section mirrors the
         * scheduled-tasks page's rhythm. */}
        <div className="mt-6">
          {/* In-place text filter. Narrows the conversation list by title. The
           * global ⌘K palette is still available via the sidebar's Search;
           * this input is scoped to the current page so the affordance does
           * what its label says. */}
          <SearchInput value={query} onChange={setQuery} disabled={isWorkspaceEmpty} />

          <div className="mt-4 flex flex-wrap gap-1.5">
            <FilterPill
              label="All"
              count={counts.all}
              active={filter === "all"}
              onClick={() => setFilter("all")}
              icon={GridIcon}
              iconWeight="bold"
            />
            <FilterPill
              label="Slack"
              count={counts.slack}
              active={filter === "slack"}
              onClick={() => setFilter("slack")}
              icon={SlackBrandIcon}
            />
            <FilterPill
              label="WhatsApp"
              count={counts.whatsapp}
              active={filter === "whatsapp"}
              onClick={() => setFilter("whatsapp")}
              icon={WhatsappBrandIcon}
            />
            <FilterPill
              label="Web"
              count={counts.web}
              active={filter === "web"}
              onClick={() => setFilter("web")}
              icon={BrowserIcon}
            />
          </div>

          <div className="mt-6">
            {groups.map((group, idx) => (
              <div key={group.label} className={idx === 0 ? "" : "mt-6"}>
                <DateGroupHeader label={group.label} className="mb-2" />
                <div className="flex flex-col">
                  {group.items.map((item) => (
                    <ConversationRow key={item.id} {...item} />
                  ))}
                </div>
              </div>
            ))}
            {groups.length === 0 && (
              <EmptyState
                isWorkspaceEmpty={isWorkspaceEmpty}
                filter={filter}
                hasQuery={trimmedQuery.length > 0}
                onClearFilter={() => setFilter("all")}
                onClearQuery={() => setQuery("")}
              />
            )}
          </div>
        </div>
      </div>
    </SketchShell>
  );
}

const CHANNEL_LABEL_FOR_EMPTY: Record<Exclude<FilterKey, "all">, string> = {
  slack: "Slack",
  whatsapp: "WhatsApp",
  web: "Web",
};

/**
 * Empty-state copy is split between three conditions so each one points the
 * user toward the right action:
 *   - Workspace has zero conversations → "Start one by mentioning @Sketch…"
 *   - Active filter matches nothing → "No [Channel] conversations yet"
 *     plus a "Show all" affordance to clear the filter.
 *   - Search query matches nothing → "No matches for '<query>'" plus a
 *     "Clear search" affordance.
 */
function EmptyState({
  isWorkspaceEmpty,
  filter,
  hasQuery,
  onClearFilter,
  onClearQuery,
}: {
  isWorkspaceEmpty: boolean;
  filter: FilterKey;
  hasQuery: boolean;
  onClearFilter: () => void;
  onClearQuery: () => void;
}) {
  if (isWorkspaceEmpty) {
    return (
      <div className="mt-6 px-1.5">
        <p className="text-sm font-medium text-foreground">No conversations yet.</p>
        <p className="mt-1 max-w-[44ch] text-sm text-muted-foreground">
          Start one by mentioning <strong className="text-foreground">@Sketch</strong> in Slack, messaging the bot on
          WhatsApp, or{" "}
          <Link to="/home/default" className="text-foreground underline-offset-2 hover:underline">
            starting a thread from home
          </Link>
          .
        </p>
      </div>
    );
  }

  if (hasQuery) {
    return (
      <div className="mt-6 flex items-center gap-2.5 px-1.5">
        <p className="text-sm text-muted-foreground">No conversations match your search.</p>
        <button
          type="button"
          onClick={onClearQuery}
          className={cn(
            "rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-foreground",
            "transition-colors duration-100 ease-out cursor-pointer hover:bg-accent",
          )}
          style={{ borderWidth: "0.5px" }}
        >
          Clear search
        </button>
      </div>
    );
  }

  if (filter !== "all") {
    const channelName = CHANNEL_LABEL_FOR_EMPTY[filter];
    return (
      <div className="mt-6 flex items-center gap-2.5 px-1.5">
        <p className="text-sm text-muted-foreground">No {channelName} conversations yet.</p>
        <button
          type="button"
          onClick={onClearFilter}
          className={cn(
            "rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-foreground",
            "transition-colors duration-100 ease-out cursor-pointer hover:bg-accent",
          )}
          style={{ borderWidth: "0.5px" }}
        >
          Show all
        </button>
      </div>
    );
  }

  // Defensive fallback — `all` filter, no query, but no items. Shouldn't
  // happen because !isWorkspaceEmpty guarantees at least one item.
  return <p className="mt-6 px-[6px] text-sm text-muted-foreground/65">No conversations to show.</p>;
}

function SearchInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md bg-muted/40",
        "px-3 py-2 text-sm",
        "transition-colors duration-100 ease-out",
        !disabled && "focus-within:bg-muted/70 focus-within:ring-1 focus-within:ring-border",
        disabled && "opacity-50",
      )}
    >
      <SearchIcon size={14} aria-hidden className="shrink-0 text-muted-foreground/75" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search conversations…"
        disabled={disabled}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/65",
          "disabled:cursor-not-allowed",
        )}
        aria-label="Filter conversations by title"
      />
    </label>
  );
}

export const conversationsRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/conversations",
  component: ConversationsPage,
});
