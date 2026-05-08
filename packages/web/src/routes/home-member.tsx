import type { SkillCategory } from "@/lib/skills-data";
import { useDashboardAuth } from "@/routes/dashboard";
/**
 * Member home — bento-grid dashboard. Single viewport, no scroll on standard heights.
 *
 * The same layout serves both empty (new member) and mature (active member) states.
 * Cards keep the same dimensions across states; only their content changes. This is
 * intentional — a layout that reshuffles as setup progresses feels disorienting.
 *
 * Discovery / "what can Sketch do?" lives in the chatbot widget (rendered separately,
 * shared across pages). Setup guidance lives in the AppSidebar's stepper. Neither is
 * the home page's job.
 *
 * Bento grid (5 rows × 3 cols):
 *
 *   greet    greet         greet
 *   activity activity      files
 *   skills   team          files
 *   skills   integrations  files
 *   usage    usage         files
 */
import { GreetingBar, type HomeDigest } from "@/routes/home";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChartBarIcon,
  ChatCircleIcon,
  ClockIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  NewspaperIcon,
  type Icon as PhosphorIcon,
  PlugIcon,
  PlusIcon,
  StackIcon,
  TargetIcon,
  UsersThreeIcon,
  WarningIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type React from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export interface UpcomingRun {
  id: string;
  title: string;
  /** Where this runs — e.g. "#standup", "Daily DM". */
  target: string;
  /** Clock time, e.g. "9:00 AM". */
  time: string;
  /** Time-until-next-run, e.g. "in 2h", "Mon", "tomorrow". */
  relativeTime: string;
}

export type RecentEvent =
  | {
      kind: "sketch" | "scheduled";
      id: string;
      title: string;
      category: SkillCategory;
      day: string;
      time: string;
    }
  | {
      kind: "user";
      id: string;
      title: string;
      initials: string;
      day: string;
      time: string;
    };

export interface ActiveSkill {
  id: string;
  name: string;
  category: SkillCategory;
  /** ISO string or null for "never run". Display formatting is up to the renderer. */
  lastUsedAt: string | null;
  /** Pre-formatted relative time, e.g. "ran 2h ago". Empty string for never-run. */
  lastUsedLabel: string;
}

export interface ExploreSuggestion {
  id: string;
  name: string;
  description: string;
  href: string;
}

export interface TeamMember {
  id: string;
  initials: string;
  /** Tailwind background class for the avatar tint, e.g. "bg-blue-500/20". */
  tint: string;
}

export interface TeamSummary {
  totalCount: number;
  humanCount: number;
  agentCount: number;
  pendingInvites: number;
  /** First few members shown in the avatar row. */
  members: TeamMember[];
}

export interface IntegrationProvider {
  id: string;
  /** Tailwind background class for the connector swatch, e.g. "bg-orange-500". */
  tint: string;
  status: "ok" | "error";
}

export interface IntegrationSummary {
  totalCount: number;
  needsReconnectCount: number;
  providers: IntegrationProvider[];
}

export interface UsageSummary {
  messages: number;
  /** Percent change vs last week (0 = no change / unavailable). */
  messagesDelta: number;
  automations: number;
  /** Raw count change vs last week (0 = no change / unavailable). */
  automationsDelta: number;
}

export interface FilesEntityCounts {
  people: number;
  companies: number;
  projects: number;
  databases: number;
  documents: number;
}

export interface RecentlyIndexedFile {
  id: string;
  fileName: string;
  /** Display label for the source, e.g. "Drive", "Notion". */
  source: string;
  /** Pre-formatted relative time, e.g. "2h ago", "today". */
  syncedLabel: string;
}

export interface FilesSourceStatus {
  id: string;
  name: string;
  status: "ok" | "syncing" | "error";
}

export interface FilesSummary {
  entityCounts: FilesEntityCounts;
  recentlyIndexed: RecentlyIndexedFile[];
  sources: FilesSourceStatus[];
}

export interface HomeMemberPageProps {
  digest: HomeDigest;
  upcoming: UpcomingRun[];
  recent: RecentEvent[];
  activeSkills: ActiveSkill[];
  exploreSuggestion: ExploreSuggestion;
  team: TeamSummary;
  integrations: IntegrationSummary;
  usage: UsageSummary;
  files: FilesSummary;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function firstName(displayName: string): string {
  return displayName.split(" ")[0] ?? displayName;
}

/**
 * Phosphor icon per skill category. Picked once and stable so Activity and Active
 * skill rows feel cohesive (a "research" run looks like a "research" skill).
 * Only the categories that show up frequently get a dedicated icon; everything
 * else falls back to a generic spark.
 */
const CATEGORY_ICON: Partial<Record<SkillCategory, PhosphorIcon>> = {
  crm: TargetIcon,
  comms: ChatCircleIcon,
  research: MagnifyingGlassIcon,
  ops: WrenchIcon,
  reporting: ChartBarIcon,
  sales: TargetIcon,
  analytics: ChartBarIcon,
  marketing: NewspaperIcon,
};

function CategoryIcon({ category, size = 11 }: { category: SkillCategory; size?: number }) {
  const Icon = CATEGORY_ICON[category] ?? StackIcon;
  return <Icon size={size} />;
}

/** Yellow-wash tile used for sketch-action and active-skill rows. */
const SKETCH_TILE = "bg-[#FEED01]/15 dark:bg-[#FEED01]/[0.06] text-[#8B7A00] dark:text-[#FEED01]";

/** Standard section label style — uppercase, monospaced, tight tracking. */
const SECTION_LABEL = "font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground";

// ── Page ─────────────────────────────────────────────────────────────────────

export function HomeMemberPage(props: HomeMemberPageProps) {
  const auth = useDashboardAuth();

  return (
    <div
      className="grid gap-3 overflow-hidden px-5 py-4 lg:h-[calc(100dvh-3rem)]"
      style={{
        gridTemplateColumns: "1.2fr 0.78fr 1.05fr",
        gridTemplateRows: "auto 1.95fr 1fr 1fr 0.4fr",
        gridTemplateAreas: `
          "greet greet greet"
          "activity activity files"
          "skills team files"
          "skills integrations files"
          "usage usage files"
        `,
      }}
    >
      <div style={{ gridArea: "greet" }} className="min-w-0">
        <GreetingBar firstName={firstName(auth.displayName)} digest={props.digest} />
      </div>

      <div style={{ gridArea: "activity" }} className="min-h-0">
        <ActivityCard upcoming={props.upcoming} recent={props.recent} />
      </div>

      <div style={{ gridArea: "skills" }} className="min-h-0">
        <SkillsCard active={props.activeSkills} suggestion={props.exploreSuggestion} />
      </div>

      <div style={{ gridArea: "team" }} className="min-h-0">
        <TeamCard team={props.team} />
      </div>

      <div style={{ gridArea: "integrations" }} className="min-h-0">
        <IntegrationsCard summary={props.integrations} />
      </div>

      <div style={{ gridArea: "usage" }} className="min-h-0">
        <UsageStrip usage={props.usage} />
      </div>

      <div style={{ gridArea: "files" }} className="min-h-0">
        <FilesCard files={props.files} />
      </div>
    </div>
  );
}

// ── Activity card ────────────────────────────────────────────────────────────

function ActivityCard({ upcoming, recent }: { upcoming: UpcomingRun[]; recent: RecentEvent[] }) {
  const upcomingEmpty = upcoming.length === 0;
  const recentEmpty = recent.length === 0;
  const dayGroups = groupRecentByDay(recent);

  return (
    <Card>
      <h2 className={cn(SECTION_LABEL, "mb-3")}>Activity</h2>

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <SectionHeader
          label="Upcoming"
          action={
            upcomingEmpty
              ? { kind: "link", icon: <PlusIcon size={11} />, label: "Schedule a task", href: "/scheduled-tasks" }
              : { kind: "link", label: "View all →", href: "/scheduled-tasks" }
          }
        />
        {upcomingEmpty ? (
          <VoiceLine>I'm built for routines. Tell me when, and I'll run on time.</VoiceLine>
        ) : (
          <ul className="space-y-2">
            {upcoming.slice(0, 2).map((run) => (
              <UpcomingRow key={run.id} run={run} />
            ))}
          </ul>
        )}

        <Divider />

        <SectionHeader
          label="Recent"
          action={recentEmpty ? null : { kind: "link", label: "View all →", href: "/usage" }}
        />
        {recentEmpty ? (
          <>
            <VoiceLine>My logbook — every task I run, every question you ask, lands here.</VoiceLine>
            <ul className="space-y-2 opacity-40">
              <RecentRow
                event={{
                  kind: "sketch",
                  id: "ghost",
                  title: "Standup digest sent",
                  category: "comms",
                  day: "Today",
                  time: "9:02 AM",
                }}
              />
            </ul>
          </>
        ) : (
          <div className="space-y-3">
            {dayGroups.map((group) => (
              <div key={group.day}>
                <p className="mb-1 text-[10.5px] font-medium text-muted-foreground">{group.day}</p>
                <ul className="space-y-2">
                  {group.events.map((event) => (
                    <RecentRow key={event.id} event={event} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function UpcomingRow({ run }: { run: UpcomingRun }) {
  return (
    <li className="flex items-center gap-3">
      <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <ClockIcon size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs">{run.title}</p>
        <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
          {run.target} · {run.time}
        </p>
      </div>
      <p className="shrink-0 text-[10.5px] text-muted-foreground">{run.relativeTime}</p>
    </li>
  );
}

function RecentRow({ event }: { event: RecentEvent }) {
  return (
    <li className="flex items-center gap-3">
      {event.kind === "user" ? (
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-[9.5px] font-medium text-blue-700 dark:bg-blue-500/[0.12] dark:text-blue-300">
          {event.initials}
        </div>
      ) : (
        <div className={cn("flex size-5 shrink-0 items-center justify-center rounded-[5px]", SKETCH_TILE)}>
          <CategoryIcon category={event.category} size={11} />
        </div>
      )}
      <p className="min-w-0 flex-1 truncate text-xs">{event.title}</p>
      <p className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">{event.time}</p>
    </li>
  );
}

function groupRecentByDay(events: RecentEvent[]): { day: string; events: RecentEvent[] }[] {
  const groups: { day: string; events: RecentEvent[] }[] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (last && last.day === event.day) {
      last.events.push(event);
    } else {
      groups.push({ day: event.day, events: [event] });
    }
  }
  // Cap to 2-3 day windows max per spec; keep all events within those days.
  return groups.slice(0, 3);
}

// ── Skills card ──────────────────────────────────────────────────────────────

function SkillsCard({ active, suggestion }: { active: ActiveSkill[]; suggestion: ExploreSuggestion }) {
  const empty = active.length === 0;

  return (
    <Card>
      <SectionHeader label="Skills" action={{ kind: "link", label: "View all →", href: "/skills" }} />

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
        <p className={SECTION_LABEL}>Active</p>
        {empty ? (
          <div className="space-y-3">
            <VoiceLine>I work on what you set me up to do.</VoiceLine>
            <Link
              to="/skills"
              className="inline-flex items-center gap-1.5 self-start rounded-md border border-border px-2.5 py-1.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              <PlusIcon size={11} />
              Activate a skill
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {active.slice(0, 3).map((skill) => (
              <ActiveSkillRow key={skill.id} skill={skill} />
            ))}
          </ul>
        )}

        <Divider />

        <p className={SECTION_LABEL}>Explore</p>
        <Link
          to={suggestion.href}
          className="group flex items-center gap-3 rounded-md transition-colors hover:bg-muted/40"
        >
          <div className="flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-border bg-muted/60 text-muted-foreground">
            <NewspaperIcon size={11} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs">
              <span className="text-muted-foreground">Try: </span>
              <span className="font-medium">{suggestion.name}</span>
            </p>
            <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">{suggestion.description}</p>
          </div>
          <ArrowRightIcon
            size={12}
            className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      </div>
    </Card>
  );
}

function ActiveSkillRow({ skill }: { skill: ActiveSkill }) {
  return (
    <li className="flex items-center gap-3">
      <div className={cn("flex size-5 shrink-0 items-center justify-center rounded-[5px]", SKETCH_TILE)}>
        <CategoryIcon category={skill.category} size={11} />
      </div>
      <p className="min-w-0 flex-1 truncate text-xs">{skill.name}</p>
      <p className="shrink-0 text-[10.5px] text-muted-foreground">{skill.lastUsedLabel}</p>
    </li>
  );
}

// ── Team card ────────────────────────────────────────────────────────────────

function TeamCard({ team }: { team: TeamSummary }) {
  const empty = team.totalCount <= 1;
  const visible = team.members.slice(0, 3);
  const overflow = team.totalCount - visible.length;

  return (
    <Card padding="sm">
      <div className="flex items-center justify-between">
        <h2 className={SECTION_LABEL}>Team</h2>
        <UsersThreeIcon size={12} className="text-muted-foreground" />
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <p className="text-[18px] font-medium leading-none tracking-tight tabular-nums">{team.totalCount}</p>
        <p className="text-[11px] text-muted-foreground">{team.totalCount === 1 ? "member" : "members"}</p>
      </div>

      {empty ? (
        team.pendingInvites > 0 ? (
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            {team.pendingInvites} {team.pendingInvites === 1 ? "invite" : "invites"} pending
          </p>
        ) : null
      ) : (
        <p className="mt-1 text-[10.5px] text-muted-foreground">
          {team.humanCount} humans
          {team.agentCount > 0 ? ` · ${team.agentCount} agents` : ""}
          {team.pendingInvites > 0 ? ` · ${team.pendingInvites} pending` : ""}
        </p>
      )}

      <div className="mt-auto flex items-center pt-2">
        {visible.map((member, idx) => (
          <div
            key={member.id}
            className={cn(
              "flex size-[18px] items-center justify-center rounded-full border-[1.5px] border-card text-[8px] font-medium",
              member.tint,
            )}
            style={{ marginLeft: idx === 0 ? 0 : -5 }}
          >
            {member.initials}
          </div>
        ))}
        {overflow > 0 && !empty ? (
          <div
            className="flex size-[18px] items-center justify-center rounded-full border-[1.5px] border-card bg-muted text-[8px] font-medium text-muted-foreground"
            style={{ marginLeft: -5 }}
          >
            +{overflow}
          </div>
        ) : null}
        {empty ? (
          <Link
            to="/team"
            aria-label="Invite teammate"
            className="flex size-[18px] items-center justify-center rounded-full border border-dashed border-border/80 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            style={{ marginLeft: visible.length > 0 ? -5 : 0 }}
          >
            <PlusIcon size={10} />
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

// ── Integrations card ────────────────────────────────────────────────────────

function IntegrationsCard({ summary }: { summary: IntegrationSummary }) {
  const empty = summary.totalCount === 0;
  const visible = summary.providers.slice(0, 5);
  const overflow = summary.totalCount - visible.length;

  // Empty-state structure preserves slot count so the row's visual rhythm matches mature.
  const emptyPlaceholderKeys = ["a", "b", "c", "d"];

  return (
    <Card padding="sm">
      <div className="flex items-center justify-between">
        <h2 className={SECTION_LABEL}>Integrations</h2>
        <PlugIcon size={12} className="text-muted-foreground" />
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <p
          className={cn(
            "text-[18px] font-medium leading-none tracking-tight tabular-nums",
            empty && "text-muted-foreground",
          )}
        >
          {summary.totalCount}
        </p>
        <p className="text-[11px] text-muted-foreground">connected</p>
      </div>

      {summary.needsReconnectCount > 0 ? (
        <p className="mt-1 text-[10.5px] text-amber-600 dark:text-amber-400">
          {summary.needsReconnectCount} {summary.needsReconnectCount === 1 ? "needs" : "need"} reconnect
        </p>
      ) : null}

      <div className="mt-auto flex items-center gap-1.5 pt-2">
        {empty ? (
          <>
            <Link
              to="/integrations"
              aria-label="Connect a tool"
              className="flex size-4 items-center justify-center rounded-[4px] border border-dashed border-border/80 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              <PlusIcon size={10} />
            </Link>
            {emptyPlaceholderKeys.map((key) => (
              <div key={key} className="size-4 rounded-[4px] bg-muted/50 opacity-40" />
            ))}
          </>
        ) : (
          <>
            {visible.map((provider) =>
              provider.status === "error" ? (
                <div
                  key={provider.id}
                  className="flex size-4 items-center justify-center rounded-[4px] bg-amber-500/20 text-amber-600 dark:text-amber-400"
                  aria-label="Needs reconnect"
                >
                  <WarningIcon size={9} weight="fill" />
                </div>
              ) : (
                <div key={provider.id} className={cn("size-4 rounded-[4px]", provider.tint)} />
              ),
            )}
            {overflow > 0 ? (
              <div className="flex size-4 items-center justify-center rounded-[4px] bg-muted text-[8px] font-medium text-muted-foreground">
                +{overflow}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

// ── Usage strip ──────────────────────────────────────────────────────────────

function UsageStrip({ usage }: { usage: UsageSummary }) {
  return (
    <div className="flex h-full overflow-hidden rounded-lg border border-border bg-card">
      <UsageHalf label="Messages" value={usage.messages} delta={usage.messagesDelta} deltaUnit="%" />
      <div className="w-px bg-border" />
      <UsageHalf label="Automations" value={usage.automations} delta={usage.automationsDelta} deltaUnit="" />
    </div>
  );
}

function UsageHalf({
  label,
  value,
  delta,
  deltaUnit,
}: {
  label: string;
  value: number;
  delta: number;
  deltaUnit: string;
}) {
  const empty = value === 0;
  const isNegative = delta < 0;
  const isPositive = delta > 0;

  return (
    <div className="flex flex-1 items-center justify-between px-4 py-2.5">
      <p className={SECTION_LABEL}>{label}</p>
      <div className="flex items-baseline gap-2">
        <p
          className={cn(
            "text-base font-medium leading-none tracking-tight tabular-nums",
            empty && "text-muted-foreground",
          )}
        >
          {value}
        </p>
        {empty ? (
          <span className="text-[10px] text-muted-foreground">—</span>
        ) : delta !== 0 ? (
          <span
            className={cn(
              "flex items-center gap-0.5 text-[10px] tabular-nums",
              isNegative ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
            )}
          >
            {isPositive ? <ArrowUpIcon size={9} /> : <ArrowDownIcon size={9} />}
            {Math.abs(delta)}
            {deltaUnit}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── Files card ───────────────────────────────────────────────────────────────

function FilesCard({ files }: { files: FilesSummary }) {
  const isEmpty = files.recentlyIndexed.length === 0 && files.sources.length === 0;

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <StackIcon size={13} className="text-muted-foreground" />
          <h2 className={SECTION_LABEL}>Files</h2>
        </div>
        {isEmpty ? null : (
          <Link to="/files" className="text-[10.5px] text-muted-foreground transition-colors hover:text-foreground">
            View all →
          </Link>
        )}
      </div>

      <Link
        to="/files"
        className="mt-3 flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted"
      >
        <MagnifyingGlassIcon size={11} />
        <span className="text-xs">Search memory</span>
      </Link>

      {isEmpty ? (
        <div className="mt-3">
          <VoiceLine>I'll start building this as you connect tools and we talk.</VoiceLine>
        </div>
      ) : null}

      <div className="mt-4">
        <p className={SECTION_LABEL}>{isEmpty ? "What I'll know" : "What I know"}</p>
        <ul className="mt-2 space-y-1.5">
          <FilesEntityRow label="People" count={files.entityCounts.people} empty={isEmpty} />
          <FilesEntityRow label="Companies" count={files.entityCounts.companies} empty={isEmpty} />
          <FilesEntityRow label="Projects" count={files.entityCounts.projects} empty={isEmpty} />
          <FilesEntityRow label="Databases" count={files.entityCounts.databases} empty={isEmpty} />
          <FilesEntityRow label="Documents" count={files.entityCounts.documents} empty={isEmpty} />
        </ul>
      </div>

      {!isEmpty && files.recentlyIndexed.length > 0 ? (
        <div className="mt-4">
          <p className={SECTION_LABEL}>Recently indexed</p>
          <ul className="mt-2 space-y-2">
            {files.recentlyIndexed.slice(0, 3).map((file) => (
              <li key={file.id} className="flex items-center gap-2">
                <FileTextIcon size={12} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11.5px]">{file.fileName}</p>
                  <p className="mt-0.5 truncate text-[9.5px] text-muted-foreground">
                    {file.source} · {file.syncedLabel}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className={SECTION_LABEL}>Sources</p>
          {isEmpty ? (
            <Link
              to="/integrations"
              className="inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <PlusIcon size={11} />
              Connect
            </Link>
          ) : null}
        </div>
        {!isEmpty && files.sources.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            {files.sources.map((source) => (
              <span key={source.id} className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground">
                <span
                  className={cn(
                    "size-[5px] rounded-full",
                    source.status === "ok" && "bg-emerald-500",
                    source.status === "syncing" && "bg-amber-500",
                    source.status === "error" && "bg-red-500",
                  )}
                />
                {source.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function FilesEntityRow({ label, count, empty }: { label: string; count: number; empty: boolean }) {
  return (
    <li className="flex items-center justify-between text-[11.5px]">
      <span className="text-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", empty && "text-muted-foreground/70")}>{empty ? "—" : count}</span>
    </li>
  );
}

// ── Shared building blocks ───────────────────────────────────────────────────

function Card({ children, padding = "lg" }: { children: React.ReactNode; padding?: "lg" | "sm" }) {
  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
        padding === "lg" ? "px-4 py-3.5" : "px-3.5 py-3",
      )}
    >
      {children}
    </section>
  );
}

type SectionAction = { kind: "link"; label: string; href: string; icon?: React.ReactNode } | null;

function SectionHeader({ label, action }: { label: string; action: SectionAction }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className={SECTION_LABEL}>{label}</p>
      {action ? (
        <Link
          to={action.href}
          className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {action.icon}
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

function VoiceLine({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

function Divider() {
  return <div className="my-1 h-px w-full bg-border/60" />;
}
