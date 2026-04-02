import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { cn } from "@sketch/ui/lib/utils";
import { useMemo, useRef, useState } from "react";
import { ActivityBar, AvatarChip, GroupAvatar, formatLastActive } from "./shared";
import type { ByGroupEntry, ByUserEntry } from "./shared";

interface TeamMember {
  name: string;
  type: "member";
  isCurrentUser: boolean;
  messages: number | null;
  skillsUsed: number | null;
  lastActive: string;
  activityPct: number;
}

interface TeamGroup {
  name: string;
  type: "group";
  memberCount: number | null;
  messages: number | null;
  skillsUsed: number | null;
  lastActive: string;
  activityPct: number;
}

interface TeamAgent {
  name: string;
  type: "agent";
  messages: number | null;
  lastActive: string;
  activityPct: number;
}

type TeamEntity = TeamMember | TeamGroup | TeamAgent;
type TableFilter = "all" | "members" | "groups" | "agents";
const ROWS_PER_PAGE = 5;

function buildEntities(
  byUser: ByUserEntry[],
  byGroup: ByGroupEntry[],
  allUsers: { id: string; name: string; type: string }[],
  currentUserId: string | undefined,
): { members: TeamMember[]; groups: TeamGroup[]; agents: TeamAgent[] } {
  const usageMap = new Map(byUser.map((u) => [u.userId, u]));
  const maxMessages = Math.max(...byUser.map((u) => u.messageCount), 1);

  const members: TeamMember[] = [];
  const agents: TeamAgent[] = [];

  const seenIds = new Set<string>();
  for (const user of allUsers) {
    seenIds.add(user.id);
    const usage = usageMap.get(user.id);
    const msgs = usage?.messageCount ?? null;
    const actPct = msgs !== null ? Math.round((msgs / maxMessages) * 100) : 0;
    const lastActive = formatLastActive(usage?.lastRunAt ?? null);

    if (user.type === "agent") {
      agents.push({ name: user.name, type: "agent", messages: msgs, lastActive, activityPct: actPct });
    } else {
      members.push({
        name: user.name,
        type: "member",
        isCurrentUser: user.id === currentUserId,
        messages: msgs,
        skillsUsed: usage?.skillCount ?? null,
        lastActive,
        activityPct: actPct,
      });
    }
  }

  for (const usage of byUser) {
    if (seenIds.has(usage.userId)) continue;
    const actPct = Math.round((usage.messageCount / maxMessages) * 100);
    const lastActive = formatLastActive(usage.lastRunAt);
    if (usage.userType === "agent") {
      agents.push({
        name: usage.userName ?? usage.userId,
        type: "agent",
        messages: usage.messageCount,
        lastActive,
        activityPct: actPct,
      });
    } else {
      members.push({
        name: usage.userName ?? usage.userId,
        type: "member",
        isCurrentUser: false,
        messages: usage.messageCount,
        skillsUsed: usage.skillCount,
        lastActive,
        activityPct: actPct,
      });
    }
  }

  const groups: TeamGroup[] = byGroup.map((g) => ({
    name: g.name,
    type: "group",
    memberCount: null,
    messages: g.messageCount,
    skillsUsed: g.skillCount,
    lastActive: formatLastActive(g.lastRunAt),
    activityPct: Math.round((g.messageCount / maxMessages) * 100),
  }));

  return { members, groups, agents };
}

function EntityRow({ entity, filter }: { entity: TeamEntity; filter: TableFilter }) {
  const messages = entity.messages;
  const skillsUsed = entity.type !== "agent" ? (entity as TeamMember | TeamGroup).skillsUsed : null;
  const isCurrentUser = entity.type === "member" && (entity as TeamMember).isCurrentUser;
  const memberCount = entity.type === "group" ? (entity as TeamGroup).memberCount : null;

  return (
    <tr className="border-b border-border transition-colors last:border-b-0 hover:bg-secondary/50 dark:hover:bg-muted/30">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          {entity.type === "group" ? (
            <GroupAvatar name={entity.name} />
          ) : (
            <AvatarChip name={entity.name} type={entity.type === "agent" ? "agent" : "member"} />
          )}
          <span className="text-[13px] font-medium">{entity.name}</span>
          {isCurrentUser ? (
            <Badge className="rounded-[4px] bg-[#E6F1FB] px-1.5 py-0 text-[10px] text-[#185FA5] dark:bg-[#0C447C] dark:text-[#85B7EB]">
              You
            </Badge>
          ) : null}
          {entity.type === "agent" && filter !== "agents" ? (
            <Badge variant="secondary" className="rounded-[4px] px-1.5 py-0 text-[9px]">
              Agent
            </Badge>
          ) : null}
          {entity.type === "group" ? (
            <>
              {filter !== "groups" ? (
                <Badge
                  variant="secondary"
                  className="rounded-[4px] bg-muted px-1.5 py-0 text-[9px] text-muted-foreground"
                >
                  Group
                </Badge>
              ) : null}
              {memberCount !== null ? (
                <span className="text-[11px] text-muted-foreground">&middot; {memberCount} members</span>
              ) : null}
            </>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {messages !== null ? messages : <span className="text-muted-foreground">&mdash;</span>}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {entity.type === "agent" ? (
          <span className="text-muted-foreground">&mdash;</span>
        ) : skillsUsed !== null ? (
          skillsUsed
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-muted-foreground">{entity.lastActive}</td>
      <td className="px-4 py-2.5">
        <ActivityBar pct={entity.activityPct} />
      </td>
    </tr>
  );
}

export function TeamAdoptionTable({
  byUser,
  byGroup,
  allUsers,
  currentUserId,
}: {
  byUser: ByUserEntry[];
  byGroup: ByGroupEntry[];
  allUsers: { id: string; name: string; type: string }[];
  currentUserId: string | undefined;
}) {
  const [filter, setFilter] = useState<TableFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { members, groups, agents } = useMemo(
    () => buildEntities(byUser, byGroup, allUsers, currentUserId),
    [byUser, byGroup, allUsers, currentUserId],
  );
  const allEntities: TeamEntity[] = useMemo(() => [...members, ...groups, ...agents], [members, groups, agents]);

  // Reset page when underlying data changes (e.g. period switch)
  const prevEntitiesRef = useRef(allEntities);
  if (prevEntitiesRef.current !== allEntities) {
    prevEntitiesRef.current = allEntities;
    if (page !== 1) setPage(1);
  }

  const filteredEntities = useMemo(() => {
    let entities: TeamEntity[];
    switch (filter) {
      case "members":
        entities = members;
        break;
      case "groups":
        entities = groups;
        break;
      case "agents":
        entities = agents;
        break;
      default:
        entities = allEntities;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      entities = entities.filter((e) => e.name.toLowerCase().includes(q));
    }
    return entities;
  }, [filter, search, members, groups, agents, allEntities]);

  const totalPages = Math.max(1, Math.ceil(filteredEntities.length / ROWS_PER_PAGE));
  const pagedEntities = filteredEntities.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);

  const filteredCounts = useMemo(() => {
    if (!search.trim()) {
      return { all: allEntities.length, members: members.length, groups: groups.length, agents: agents.length };
    }
    const q = search.toLowerCase();
    return {
      all: allEntities.filter((e) => e.name.toLowerCase().includes(q)).length,
      members: members.filter((e) => e.name.toLowerCase().includes(q)).length,
      groups: groups.filter((e) => e.name.toLowerCase().includes(q)).length,
      agents: agents.filter((e) => e.name.toLowerCase().includes(q)).length,
    };
  }, [search, allEntities, members, groups, agents]);

  const filterTabs: { key: TableFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "members", label: "Members" },
    { key: "groups", label: "Groups" },
    { key: "agents", label: "Agents" },
  ];

  function handleFilterChange(f: TableFilter) {
    setFilter(f);
    setPage(1);
  }

  const colCount = 5;

  return (
    <div className="overflow-hidden rounded-lg border-[0.5px] border-border bg-card">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="inline-flex rounded-lg border-[0.5px] border-border bg-card p-0.5 dark:bg-[#111110]">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleFilterChange(tab.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                filter === tab.key
                  ? "bg-accent font-medium text-foreground dark:bg-[#1C1C1A]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              <span
                className={cn(
                  "ml-1 text-[10px]",
                  filter === tab.key ? "text-muted-foreground" : "text-muted-foreground/60",
                )}
              >
                {filteredCounts[tab.key]}
              </span>
            </button>
          ))}
        </div>
        <div className="relative">
          <svg
            width={12}
            height={12}
            viewBox="0 0 256 256"
            fill="currentColor"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          >
            <path d="M229.66,218.34l-50.07-50.07a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.31ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z" />
          </svg>
          <input
            type="text"
            placeholder="Search by name..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="h-7 min-w-[180px] rounded-md border-[0.5px] border-border bg-card pl-7 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none dark:bg-[#111110]"
          />
        </div>
      </div>

      {/* Fixed-height body: header + 5 rows = stable height regardless of content */}
      <div className="h-[274px]">
        <table className="w-full text-[13px]">
          <colgroup>
            <col />
            <col className="w-[100px]" />
            <col className="w-[100px]" />
            <col className="w-[110px]" />
            <col className="w-[110px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-2.5 font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
                {filter === "groups" ? "Group" : filter === "agents" ? "Agent" : "Member"}
              </th>
              <th className="px-4 py-2.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
                Messages
              </th>
              <th className="px-4 py-2.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
                Skills used
              </th>
              <th className="px-4 py-2.5 font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
                Last active
              </th>
              <th className="px-4 py-2.5 font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
                Activity
              </th>
            </tr>
          </thead>
          <tbody>
            {pagedEntities.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-4 pt-16 text-center text-[13px] text-muted-foreground">
                  {search ? <>No results for &ldquo;{search}&rdquo;</> : "No usage data yet"}
                </td>
              </tr>
            ) : (
              pagedEntities.map((entity) => (
                <EntityRow key={`${entity.type}-${entity.name}`} entity={entity} filter={filter} />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination — always rendered for stable height */}
      <div className="flex items-center justify-between border-t border-border px-4 py-2.5 font-mono text-[10px] uppercase text-muted-foreground">
        <span>
          {filteredEntities.length > 0
            ? `Showing ${Math.min(pagedEntities.length, ROWS_PER_PAGE)} of ${filteredEntities.length}`
            : "\u00A0"}
        </span>
        {totalPages > 1 ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded p-1 hover:bg-muted disabled:opacity-30"
            >
              <CaretLeftIcon size={12} />
            </button>
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              const pageNum = i + 1;
              return (
                <button
                  key={pageNum}
                  type="button"
                  onClick={() => setPage(pageNum)}
                  className={cn(
                    "min-w-[24px] rounded px-1.5 py-0.5 font-mono text-[10px]",
                    page === pageNum ? "bg-muted font-medium text-foreground" : "hover:bg-muted",
                  )}
                >
                  {pageNum}
                </button>
              );
            })}
            {totalPages > 5 ? <span className="px-1">&hellip;</span> : null}
            {totalPages > 5 ? (
              <button
                type="button"
                onClick={() => setPage(totalPages)}
                className={cn(
                  "min-w-[24px] rounded px-1.5 py-0.5 font-mono text-[10px]",
                  page === totalPages ? "bg-muted font-medium text-foreground" : "hover:bg-muted",
                )}
              >
                {totalPages}
              </button>
            ) : null}
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded p-1 hover:bg-muted disabled:opacity-30"
            >
              <CaretRightIcon size={12} />
            </button>
          </div>
        ) : (
          <span>&nbsp;</span>
        )}
      </div>
    </div>
  );
}
