/**
 * /conversations — §5.11. Full conversation history with date grouping and
 * channel filters.
 *
 * Sidebar: Home stays the active nav item because /conversations is
 * conceptually a sub-route of home (§4.1 active-route logic).
 */
import { ConversationRow, type ConversationRowProps } from "@/components/sketch/conversation-row";
import { DateGroupHeader } from "@/components/sketch/date-group-header";
import { FilterPill } from "@/components/sketch/filter-pill";
import { SearchIcon } from "@/components/sketch/icons";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_ALL_CONVERSATIONS, MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

type FilterKey = "all" | "slack" | "whatsapp" | "web";

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
  items: ConversationRowProps[];
}

function groupByDate(items: ConversationRowProps[], now: Date): DateGroup[] {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const today: ConversationRowProps[] = [];
  const yesterday: ConversationRowProps[] = [];
  const thisWeek: ConversationRowProps[] = [];
  const monthGroups = new Map<string, ConversationRowProps[]>();
  const earlier: ConversationRowProps[] = [];

  for (const item of items) {
    const t = new Date(item.occurredAt).getTime();
    if (t >= todayStart) today.push(item);
    else if (t >= yesterdayStart) yesterday.push(item);
    else if (t >= weekStart) thisWeek.push(item);
    else if (t >= monthStart) {
      const key = `This ${MONTH_NAMES[now.getMonth()]}`;
      if (!monthGroups.has(key)) monthGroups.set(key, []);
      monthGroups.get(key)?.push(item);
    } else {
      const occurred = new Date(item.occurredAt);
      if (occurred.getFullYear() === now.getFullYear()) {
        const key = MONTH_NAMES[occurred.getMonth()];
        if (!monthGroups.has(key)) monthGroups.set(key, []);
        monthGroups.get(key)?.push(item);
      } else {
        earlier.push(item);
      }
    }
  }

  const groups: DateGroup[] = [];
  if (today.length) groups.push({ label: "Today", items: today });
  if (yesterday.length) groups.push({ label: "Yesterday", items: yesterday });
  if (thisWeek.length) groups.push({ label: "This week", items: thisWeek });
  for (const [label, list] of monthGroups) groups.push({ label, items: list });
  if (earlier.length) groups.push({ label: "Earlier", items: earlier });
  return groups;
}

function ConversationsPage() {
  const auth = useSketchAuth();
  const [filter, setFilter] = useState<FilterKey>("all");

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

  const filtered = useMemo(
    () => (filter === "all" ? MOCK_ALL_CONVERSATIONS : MOCK_ALL_CONVERSATIONS.filter((c) => c.channel === filter)),
    [filter],
  );

  const groups = useMemo(() => groupByDate(filtered, new Date()), [filtered]);

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
      <div className="mx-auto w-full max-w-4xl px-10 py-8">
        <div className="mb-[18px] flex items-baseline gap-[10px]">
          <h1 className="text-xl font-semibold text-foreground">Conversations</h1>
          <span className="text-[12px] text-muted-foreground/65 tabular-nums">{counts.all}</span>
        </div>

        <SearchTrigger />

        <div className="mt-[14px] flex flex-wrap gap-[6px]">
          <FilterPill label="All" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterPill
            label="Slack"
            count={counts.slack}
            active={filter === "slack"}
            onClick={() => setFilter("slack")}
          />
          <FilterPill
            label="WhatsApp"
            count={counts.whatsapp}
            active={filter === "whatsapp"}
            onClick={() => setFilter("whatsapp")}
          />
          <FilterPill label="Web" count={counts.web} active={filter === "web"} onClick={() => setFilter("web")} />
        </div>

        <div className="mt-[6px]">
          {groups.map((group, idx) => (
            <div key={group.label} className={idx === 0 ? "mt-[14px]" : "mt-[14px]"}>
              <DateGroupHeader label={group.label} className="mb-[6px]" />
              <div className="flex flex-col">
                {group.items.map((item) => (
                  <ConversationRow key={item.id} {...item} />
                ))}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <p className="mt-[24px] px-[6px] text-[12px] text-muted-foreground/65">
              No conversations match this filter.
            </p>
          )}
        </div>
      </div>
    </SketchShell>
  );
}

function SearchTrigger() {
  return (
    <button
      type="button"
      onClick={() => {
        /* opens the global ⌘K palette — separate work item */
      }}
      className={cn(
        "flex w-full items-center gap-[10px] rounded-[6px] bg-muted/40",
        "px-[12px] py-[9px] text-left text-[13px] text-muted-foreground/75",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-muted/70 hover:text-foreground",
      )}
    >
      <SearchIcon size={13} aria-hidden />
      <span className="flex-1">Search conversations…</span>
      <span className="text-[10px] tracking-[0.02em] text-muted-foreground/50">⌘ K</span>
    </button>
  );
}

export const conversationsRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/conversations",
  component: ConversationsPage,
});
