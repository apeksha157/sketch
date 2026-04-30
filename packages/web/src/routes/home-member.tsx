/**
 * Member home — bento-grid dashboard. Single viewport, no scroll on standard heights.
 *
 * Layout (top to bottom):
 *   1. Greeting (shrink-0, ~60px)
 *   2. Top row: Activity + right column (shrink-0, sized to natural content; cards stretch via grid)
 *   3. Bottom row: 3 Usage tiles (shrink-0, natural-content height)
 *
 * Empty space at the bottom of the page is intentional — content is naturally sized
 * rather than artificially distributed.
 *
 * Top-row right column composition:
 *   • new user (incomplete setup): Discover dominates (40/60 with Activity), Get Started UI inside
 *   • active no errors: Activity + Discover, both stretch to grid alignment
 *   • active with errors (Iteration B — default): NotificationsCard on top of Discover (Discover always renders)
 *   • active with errors (Iteration A): banner inside Activity card; right column is just Discover
 *
 * When notifications are visible, Activity caps trim to keep the row from growing too tall,
 * and Discover row count drops from 4 to 2 to balance.
 */
import { useDashboardAuth } from "@/routes/dashboard";
import { GreetingBar, type HomeDigest } from "@/routes/home";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  MagnifyingGlassIcon,
  PlugIcon,
  SparkleIcon,
  TargetIcon,
  UsersThreeIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { Input } from "@sketch/ui/components/input";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type React from "react";
import { useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SetupSteps {
  slack: boolean;
  firstConversation: boolean;
  firstSkill: boolean;
  integration: boolean;
  scheduledTask: boolean;
}

export type { HomeDigest };

export interface UsageStats {
  messages: number;
  messagesDelta: number;
  skills: number;
  skillsDelta: number;
  automations: number;
  automationsDelta: number;
}

export type ActivityFeedItem = {
  id: string;
  type: "upcoming" | "running" | "completed_auto" | "completed_user";
  skillName: string;
  time: string;
  /** "today" | "yesterday" | "Mon" | etc. */
  day: string;
  meta: string;
  channel?: string;
  duration?: string;
};

export type NotificationItem = {
  id: string;
  type: "integration_disconnected" | "automation_failed" | "file_error";
  title: string;
  actionLabel: string;
  actionUrl: string;
  severity: "critical" | "warning";
};

export type DiscoverNudge = {
  id: string;
  type: "product_update" | "team_activity" | "popular" | "new_member" | "suggested";
  title: string;
  description?: string;
  ctaLabel: string;
  ctaUrl: string;
  dismissible: boolean;
};

export type LifecycleStage = "new_user" | "active_user" | "power_user";

export interface HomeMemberPageProps {
  setupSteps: SetupSteps;
  digest: HomeDigest;
  activity: ActivityFeedItem[];
  usage: UsageStats;
  discover: DiscoverNudge[];
  notifications: NotificationItem[];
  /** "card" = Iteration B (separate notifications card). "banner" = Iteration A (banner inside Activity). */
  notificationsMode?: "card" | "banner";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function firstName(displayName: string): string {
  return displayName.split(" ")[0] ?? displayName;
}

function countCompleted(steps: SetupSteps): number {
  return Object.values(steps).filter(Boolean).length;
}

/** Lifecycle derivation per spec — drives flex ratios and discover density. */
function deriveStage(digest: HomeDigest, steps: SetupSteps): LifecycleStage {
  const setupComplete = countCompleted(steps) === 5;
  if (digest.daysActive <= 7 && !setupComplete) return "new_user";
  if (digest.daysActive > 60) return "power_user";
  return "active_user";
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function HomeMemberPage({
  setupSteps,
  digest,
  activity,
  usage,
  discover,
  notifications,
  notificationsMode = "card",
}: HomeMemberPageProps) {
  const auth = useDashboardAuth();
  const stage = deriveStage(digest, setupSteps);
  const errorCount = notifications.length;
  const showNotificationsCard = notificationsMode === "card" && errorCount > 0;
  const showNotificationsBanner = notificationsMode === "banner" && errorCount > 0;
  const notificationsVisible = showNotificationsCard || showNotificationsBanner;

  // Grid ratios: new user → Discover dominant. Active → Activity dominant.
  const topRowCols = stage === "new_user" ? "grid-cols-1 lg:grid-cols-[2fr_3fr]" : "grid-cols-1 lg:grid-cols-[3fr_2fr]";

  return (
    <div className="mx-auto flex h-[calc(100dvh-3rem)] w-full max-w-4xl flex-col gap-4 overflow-hidden px-10 pt-8 pb-10">
      <div className="shrink-0">
        <GreetingBar firstName={firstName(auth.displayName)} digest={digest} />
      </div>

      <div className={cn("grid min-h-0 flex-1 gap-5 overflow-hidden", topRowCols)}>
        <ActivityCard
          items={activity}
          digest={digest}
          isNewUser={stage === "new_user"}
          banner={showNotificationsBanner ? <NotificationsBanner items={notifications} /> : null}
          notificationsVisible={notificationsVisible}
        />

        <div className="flex flex-col gap-5">
          {showNotificationsCard ? <NotificationsCard items={notifications} /> : null}
          <DiscoverCard
            setupSteps={setupSteps}
            isNewUser={stage === "new_user"}
            nudges={discover}
            showNotificationsCard={showNotificationsCard}
          />
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-4 sm:grid-cols-3">
        <UsageTile
          label="Messages"
          value={usage.messages}
          delta={usage.messagesDelta}
          emptyCopy={
            <>
              We haven't talked yet. Every conversation on Slack counts here.{" "}
              <Link to="/channels" className="font-medium text-foreground underline-offset-2 hover:underline">
                Send your first message →
              </Link>
            </>
          }
        />
        <UsageTile
          label="Skills used"
          value={usage.skills}
          delta={usage.skillsDelta}
          emptyCopy={
            <>
              I can summarize meetings, qualify leads, track competitors — and more.{" "}
              <Link to="/skills" className="font-medium text-foreground underline-offset-2 hover:underline">
                Try your first skill →
              </Link>
            </>
          }
        />
        <UsageTile
          label="Automations run"
          value={usage.automations}
          delta={usage.automationsDelta}
          emptyCopy={
            <>
              Schedule a task — daily, weekly, whatever you need — and I'll handle it from there.{" "}
              <Link to="/scheduled-tasks" className="font-medium text-foreground underline-offset-2 hover:underline">
                Set one up →
              </Link>
            </>
          }
        />
      </div>
    </div>
  );
}

// ── Activity card ────────────────────────────────────────────────────────────

function ActivityCard({
  items,
  digest,
  isNewUser,
  banner,
  notificationsVisible,
}: {
  items: ActivityFeedItem[];
  digest: HomeDigest;
  isNewUser: boolean;
  banner: React.ReactNode;
  notificationsVisible: boolean;
}) {
  // When notifications are visible, the right column is taller. Trim Activity caps
  // so the row doesn't grow too tall and force page scroll.
  const caps = notificationsVisible
    ? { upcoming: 1, running: 1, today: 1, yesterday: 1 }
    : { upcoming: 3, running: 3, today: 2, yesterday: 2 };

  const upcoming = items.filter((i) => i.type === "upcoming").slice(0, caps.upcoming);
  const running = items.filter((i) => i.type === "running").slice(0, caps.running);
  const todayCompleted = items
    .filter((i) => i.day === "today" && i.type !== "upcoming" && i.type !== "running")
    .slice(0, caps.today);
  const yesterdayCompleted = items.filter((i) => i.day === "yesterday").slice(0, caps.yesterday);

  const isEmpty = items.length === 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex shrink-0 items-center justify-between gap-4 px-5 pt-4">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Activity</h2>
        <Link
          to="/usage"
          className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-[#8B7A00] dark:hover:text-[#FEED01]"
        >
          View all →
        </Link>
      </header>

      <div className="flex flex-1 flex-col gap-3 px-5 py-4">
        {banner}
        {isNewUser && isEmpty ? (
          <ActivityEmptyState />
        ) : (
          <>
            <div className="space-y-2">
              {upcoming.length > 0 && <ActivitySection label="Upcoming" items={upcoming} />}
              {running.length > 0 && <ActivitySection label="Running now" items={running} />}
              {todayCompleted.length > 0 && <ActivitySection label="Today" items={todayCompleted} />}
              {yesterdayCompleted.length > 0 && <ActivitySection label="Yesterday" items={yesterdayCompleted} />}
            </div>
            <ActivityStatsStrip digest={digest} items={items} />
          </>
        )}
      </div>
    </section>
  );
}

function ActivityStatsStrip({ digest, items }: { digest: HomeDigest; items: ActivityFeedItem[] }) {
  const parts: { value: string; label: string }[] = [];

  // Tasks: prefer today, fall back to yesterday if today is empty.
  if (digest.tasksRanToday > 0) {
    parts.push({
      value: String(digest.tasksRanToday),
      label: digest.tasksRanToday === 1 ? "task today" : "tasks today",
    });
  } else {
    const yesterdayCount = items.filter((i) => i.day === "yesterday").length;
    if (yesterdayCount > 0) {
      parts.push({
        value: String(yesterdayCount),
        label: yesterdayCount === 1 ? "task yesterday" : "tasks yesterday",
      });
    }
  }

  if (digest.runningNow > 0) {
    parts.push({ value: String(digest.runningNow), label: "in progress" });
  }
  if (digest.hoursSavedThisWeek > 0) {
    parts.push({ value: `${digest.hoursSavedThisWeek}h`, label: "saved this week" });
  }
  if (parts.length === 0) return null;

  return (
    <div className="mt-auto border-t border-border/60 pt-3">
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {parts.map((part, i) => (
          <span key={part.label}>
            {i > 0 && <span className="mx-2 text-muted-foreground/50">·</span>}
            <span className="font-medium text-foreground">{part.value}</span> {part.label}
          </span>
        ))}
      </p>
    </div>
  );
}

function ActivitySection({ label, items }: { label: string; items: ActivityFeedItem[] }) {
  return (
    <div>
      <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">{label}</h3>
      <ul className="space-y-1">
        {items.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityFeedItem }) {
  const isUpcoming = item.type === "upcoming";
  const isRunning = item.type === "running";

  return (
    <li
      className={cn(
        "group flex items-center gap-4 rounded-md px-2 py-2 text-sm transition-colors",
        isUpcoming && "bg-muted/40",
        isRunning && "bg-[#FEED01]/15 dark:bg-[#FEED01]/[0.06]",
        !isUpcoming && !isRunning && "hover:bg-muted/50",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-tight">
          <span className={cn("font-medium", isRunning && "text-[#8B7A00] dark:text-[#FEED01]")}>
            {item.type === "completed_user" ? `You triggered ${item.skillName}` : item.skillName}
          </span>
          {item.meta ? <span className="text-muted-foreground"> · {item.meta}</span> : null}
        </p>
      </div>
      <p className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{item.time}</p>
    </li>
  );
}

function ActivityEmptyState() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-5">
        <GhostSection
          label="Upcoming"
          body="Nothing on my schedule yet. When you set one up, your next run shows here."
          example="Competitive Intel at 2:00 PM"
        />
        <GhostSection
          label="Completed"
          body="I'll log everything I run — summaries, reports, lead scoring — right in this feed."
          example="Meeting Summary ran · 8:42 AM"
        />
        <GhostSection
          label="Triggered by you"
          body="Ask me something on Slack and it shows up here too."
          example="You triggered Lead Scoring · 11:00 AM"
        />
      </div>

      <div className="mt-6 flex items-center gap-3 rounded-md border border-[#8B7A00]/20 bg-[#FEED01]/10 px-3 py-3 dark:border-[#FEED01]/20 dark:bg-[#FEED01]/[0.04]">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#FEED01]/20 text-[#8B7A00] dark:bg-[#FEED01]/[0.08] dark:text-[#FEED01]">
          <ClockIcon size={16} weight="fill" />
        </div>
        <p className="text-sm">
          I'm on Slack, ready when you are.{" "}
          <Link to="/channels" className="font-medium text-foreground underline-offset-2 hover:underline">
            Come say hi →
          </Link>
        </p>
      </div>
    </div>
  );
}

function GhostSection({ label, body, example }: { label: string; body: string; example: string }) {
  return (
    <div>
      <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">{label}</h3>
      <div className="px-2 py-1">
        <p className="text-sm text-muted-foreground">{body}</p>
        <p className="mt-1 text-xs italic text-muted-foreground/60">{example}</p>
      </div>
    </div>
  );
}

// ── Notifications ────────────────────────────────────────────────────────────

function NotificationsCard({ items }: { items: NotificationItem[] }) {
  const heading = items.length === 1 ? "1 issue" : `${items.length} issues`;
  return (
    <section className="flex max-h-full shrink-0 flex-col overflow-hidden rounded-lg border border-destructive/25 bg-destructive/[0.04] px-5 py-4">
      <header className="mb-3 flex items-center gap-2">
        <WarningCircleIcon size={14} weight="fill" className="text-destructive" />
        <h2 className="text-sm font-medium text-destructive">{heading}</h2>
      </header>
      <ul className="space-y-2 overflow-y-auto">
        {items.map((item) => (
          <NotificationRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function NotificationRow({ item }: { item: NotificationItem }) {
  const Icon = item.type === "integration_disconnected" ? PlugIcon : XCircleIcon;
  return (
    <li className="flex items-center gap-3 text-sm">
      <Icon size={14} className="shrink-0 text-destructive/80" />
      <p className="min-w-0 flex-1 truncate text-foreground">{item.title}</p>
      <Link to={item.actionUrl} className="shrink-0 text-xs font-medium text-destructive hover:underline">
        {item.actionLabel} →
      </Link>
    </li>
  );
}

function NotificationsBanner({ items }: { items: NotificationItem[] }) {
  const heading = items.length === 1 ? "1 issue" : `${items.length} issues`;
  const visible = items.slice(0, 3);
  return (
    <div className="mb-4 rounded-md border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5">
      <header className="mb-2 flex items-center gap-2">
        <WarningCircleIcon size={14} weight="fill" className="shrink-0 text-destructive" />
        <h3 className="text-sm font-medium text-destructive">{heading}</h3>
      </header>
      <ul className="space-y-1">
        {visible.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-xs">
            <p className="min-w-0 flex-1 truncate text-muted-foreground">{item.title}</p>
            <Link to={item.actionUrl} className="shrink-0 text-[11px] font-medium text-destructive hover:underline">
              {item.actionLabel} →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Discover / Get Started ───────────────────────────────────────────────────

interface ScenarioDef {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
}

const SCENARIOS: ScenarioDef[] = [
  {
    id: "standup",
    icon: <CalendarDotsIcon size={16} />,
    title: "Summarize standups every morning",
    description: "I'll read your channel and send a summary at 9 AM.",
    href: "/skills",
  },
  {
    id: "leads",
    icon: <TargetIcon size={16} />,
    title: "Qualify inbound leads automatically",
    description: "I'll score new leads and flag the hot ones.",
    href: "/skills",
  },
  {
    id: "intel",
    icon: <MagnifyingGlassIcon size={16} />,
    title: "Run competitive intel weekly",
    description: "I'll drop a report every Monday.",
    href: "/skills",
  },
];

/**
 * Discover-tone fallbacks for active users when real nudges are insufficient.
 * Phrased as skill suggestions, not setup steps — different voice from SCENARIOS.
 */
const DISCOVER_FALLBACKS: { id: string; title: string; description: string; href: string }[] = [
  {
    id: "meeting-summary",
    title: "Meeting Summary",
    description: "Most teams use this for design standups",
    href: "/skills",
  },
  {
    id: "lead-qualifier",
    title: "Lead Qualifier",
    description: "Score and triage incoming leads",
    href: "/skills",
  },
  {
    id: "competitive-intel",
    title: "Competitive Intel",
    description: "Track competitor moves, weekly",
    href: "/skills",
  },
  {
    id: "weekly-roundup",
    title: "Weekly Roundup",
    description: "A digest of what your team shipped this week",
    href: "/skills",
  },
  {
    id: "ask-anything",
    title: "Ask me anything",
    description: "On Slack, in a DM — I'll answer or take action",
    href: "/channels",
  },
];

interface SetupStepDef {
  key: keyof SetupSteps;
  label: string;
  hint: string;
  cta: { href: string };
}

const SETUP_STEPS: SetupStepDef[] = [
  { key: "slack", label: "Connect Slack", hint: "So I can talk to your team.", cta: { href: "/integrations" } },
  {
    key: "firstConversation",
    label: "Have your first conversation",
    hint: "Say hi to me on Slack — ask me anything.",
    cta: { href: "/channels" },
  },
  {
    key: "firstSkill",
    label: "Try your first skill",
    hint: "Pick a scenario above, or browse all skills.",
    cta: { href: "/skills" },
  },
  {
    key: "integration",
    label: "Connect an integration",
    hint: "Google Drive, Notion, HubSpot — whatever your team uses.",
    cta: { href: "/integrations" },
  },
  {
    key: "scheduledTask",
    label: "Schedule your first task",
    hint: "Set it to run daily or weekly and I'll take it from there.",
    cta: { href: "/scheduled-tasks" },
  },
];

/** Conservative height estimate per NudgeRow — slightly over actual to avoid clipping. */
const NUDGE_ROW_PX = 110;
/** Gap between nudge rows in vertical layout (gap-2). */
const NUDGE_ROW_GAP_PX = 8;

/**
 * Measure a container's inner content area and compute how many fixed-height rows fit.
 * Subtracts the container's vertical padding from clientHeight so we measure the
 * actual area available for rows, not the padded box. Uses both `ResizeObserver` and
 * a `requestAnimationFrame` backup since the observer's first fire can race the flex
 * layout cascade. Hard rule: NO PAGE SCROLL — the count must under-estimate to
 * guarantee no clipping.
 */
function useRowFitCount(rowPx: number, gapPx: number, fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const styles = window.getComputedStyle(el);
      const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
      const inner = el.clientHeight - paddingTop - paddingBottom;
      if (inner <= 0) {
        setCount((prev) => (prev === 0 ? prev : 0));
        return;
      }
      // Allow 0 — caller decides whether to render the card at all.
      const fits = Math.max(0, Math.floor((inner + gapPx) / (rowPx + gapPx)));
      setCount((prev) => (prev === fits ? prev : fits));
    };

    // Backup: measure on next paint in case the observer's first callback races layout.
    const rafId = requestAnimationFrame(() => requestAnimationFrame(measure));

    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [rowPx, gapPx]);

  return [ref, count] as const;
}

function DiscoverCard({
  setupSteps,
  isNewUser,
  nudges,
  showNotificationsCard,
}: {
  setupSteps: SetupSteps;
  isNewUser: boolean;
  nudges: DiscoverNudge[];
  showNotificationsCard: boolean;
}) {
  const completedCount = countCompleted(setupSteps);
  const setupComplete = completedCount === 5;
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  // Fallback of 4 keeps the card looking full if measurement is delayed; the observer
  // will narrow down to the actual fit on the next paint.
  const [bodyRef, fitCount] = useRowFitCount(NUDGE_ROW_PX, NUDGE_ROW_GAP_PX, 4);

  // Setup just completed — show celebration banner; user can dismiss to drop into discover
  if (isNewUser && setupComplete && !completionDismissed) {
    return (
      <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-[#8B7A00]/40 bg-card p-5 dark:border-[#FEED01]/40">
        <CompletionBanner onDismiss={() => setCompletionDismissed(true)} />
      </section>
    );
  }

  // New user with incomplete setup → show Get Started
  if (isNewUser && !setupComplete) {
    return (
      <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card">
        <SetupRow
          completedCount={completedCount}
          expanded={stepsExpanded}
          onToggle={() => setStepsExpanded((v) => !v)}
          steps={setupSteps}
          fillCard={stepsExpanded}
        />
        {!stepsExpanded && (
          <div className="flex min-h-0 flex-1 flex-col gap-2 border-t border-border/60 p-4">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Try a scenario</h3>
            <ul className="flex min-h-0 flex-1 flex-col gap-2">
              {SCENARIOS.map((s) => (
                <ScenarioRow key={s.id} scenario={s} />
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  }

  // Active user — Discover row count is driven by `fitCount` (measured via ResizeObserver
  // on the body container). This keeps the page no-scroll regardless of viewport size,
  // banner presence, or notifications card height. Hard rule: NO PAGE SCROLL.
  // When fitCount = 0 (no room — typically happens in iter B with many notifications),
  // the entire Discover card gets dropped so the right column belongs to NotificationsCard.
  const targetRowCount = fitCount;
  if (fitCount === 0) return null;
  const visibleNudges = nudges.slice(0, targetRowCount);
  const slotsLeft = targetRowCount - visibleNudges.length;
  const fallback: DiscoverNudge[] = DISCOVER_FALLBACKS.slice(0, slotsLeft).map((s) => ({
    id: `fallback-${s.id}`,
    type: "suggested",
    title: s.title,
    description: s.description,
    ctaLabel: "Try this",
    ctaUrl: s.href,
    dismissible: false,
  }));
  const rows = [...visibleNudges, ...fallback];

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card">
      <header className="flex shrink-0 items-center justify-between gap-4 px-5 pt-4">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Discover</h2>
      </header>
      <div className="px-5 pt-3">
        <DiscoverSearch />
      </div>
      <div
        ref={bodyRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-3 py-3 md:flex-row md:items-stretch md:gap-4 md:px-5 md:py-4 lg:flex-col lg:gap-2 lg:px-3 lg:py-3"
      >
        {rows.map((nudge) => (
          <NudgeRow key={nudge.id} nudge={nudge} />
        ))}
      </div>
    </section>
  );
}

function DiscoverSearch() {
  return (
    <div className="relative">
      <MagnifyingGlassIcon
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <Input type="search" placeholder="Search skills, integrations, teammates..." className="h-9 pl-8 text-sm" />
    </div>
  );
}

function SetupRow({
  completedCount,
  expanded,
  onToggle,
  steps,
  fillCard,
}: {
  completedCount: number;
  expanded: boolean;
  onToggle: () => void;
  steps: SetupSteps;
  fillCard: boolean;
}) {
  const next = SETUP_STEPS.find((s) => !steps[s.key]);
  const progressPct = (completedCount / SETUP_STEPS.length) * 100;

  return (
    <div className={cn("flex flex-col gap-3 px-5 py-4", fillCard && "min-h-0 flex-1")}>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm">
          <span className="text-muted-foreground">Setting up Sketch · </span>
          <span className="font-medium text-foreground">
            {completedCount} of {SETUP_STEPS.length}
          </span>
        </p>
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-[#8B7A00] dark:hover:text-[#FEED01]"
        >
          {expanded ? "Close" : "View steps"}
          {expanded ? <CaretUpIcon size={10} /> : <CaretDownIcon size={10} />}
        </button>
      </div>

      <div className="h-[3px] w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[#8B7A00] transition-all dark:bg-[#FEED01]"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {expanded ? (
        <ol className="flex min-h-0 flex-1 flex-col justify-around py-2">
          {SETUP_STEPS.map((step, idx) => {
            const done = steps[step.key];
            const isNext = !done && next?.key === step.key;
            return (
              <li key={step.key} className="flex items-start gap-3">
                <ChecklistDot done={done} isNext={isNext} index={idx} />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm transition-colors",
                      done && "text-muted-foreground line-through",
                      isNext && "font-medium text-foreground",
                      !done && !isNext && "text-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                  {!done && <p className="mt-0.5 text-xs text-muted-foreground">{step.hint}</p>}
                </div>
                {!done && isNext && (
                  <Link
                    to={step.cta.href}
                    className="shrink-0 text-xs font-medium text-[#8B7A00] transition-colors hover:underline dark:text-[#FEED01]"
                  >
                    Start →
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      ) : next ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{next.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{next.hint}</p>
          </div>
          <Link
            to={next.cta.href}
            className="shrink-0 text-xs font-medium text-[#8B7A00] transition-colors hover:underline dark:text-[#FEED01]"
          >
            Start →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function ChecklistDot({ done, isNext, index }: { done: boolean; isNext: boolean; index: number }) {
  if (done) {
    return (
      <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[#FEED01] ring-1 ring-[#C8B832]/40 dark:ring-0">
        <CheckIcon size={10} weight="bold" className="text-[#040404]" />
      </div>
    );
  }
  if (isNext) {
    return (
      <div
        className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-foreground"
        aria-label={`Step ${index + 1}`}
      />
    );
  }
  return (
    <div className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-border" aria-label={`Step ${index + 1}`} />
  );
}

function ScenarioRow({ scenario }: { scenario: ScenarioDef }) {
  return (
    <li>
      <Link
        to={scenario.href}
        className="group flex items-start gap-3 rounded-md border border-border/60 bg-background p-3 transition-all duration-150 hover:-translate-y-px hover:border-[#8B7A00]/40 hover:shadow-sm dark:hover:border-[#FEED01]/40"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#FEED01]/15 text-[#8B7A00] transition-colors group-hover:bg-[#FEED01]/25 dark:bg-[#FEED01]/[0.06] dark:text-[#FEED01] dark:group-hover:bg-[#FEED01]/10">
          {scenario.icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight transition-colors group-hover:text-[#8B7A00] dark:group-hover:text-[#FEED01]">
            {scenario.title}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{scenario.description}</p>
        </div>
        <ArrowRightIcon
          size={12}
          className="mt-1.5 shrink-0 -translate-x-1 text-[#8B7A00]/0 transition-all duration-150 group-hover:translate-x-0 group-hover:text-[#8B7A00] dark:group-hover:text-[#FEED01]"
        />
      </Link>
    </li>
  );
}

function CompletionBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-[#FEED01]/20 text-[#8B7A00] dark:bg-[#FEED01]/[0.08] dark:text-[#FEED01]">
        <CheckCircleIcon size={26} weight="fill" />
      </div>
      <div>
        <p className="text-base font-semibold text-foreground">You're all set up</p>
        <p className="mt-1 text-sm text-muted-foreground">
          I'm connected, configured, and running. Here's what else I can do.
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        Dismiss →
      </button>
    </div>
  );
}

interface NudgeStyle {
  tagLabel: string;
  icon: React.ReactNode;
}

const NUDGE_STYLES: Record<DiscoverNudge["type"], NudgeStyle> = {
  product_update: { tagLabel: "Product update", icon: <SparkleIcon size={12} weight="fill" /> },
  team_activity: { tagLabel: "Your team", icon: <UsersThreeIcon size={12} weight="fill" /> },
  popular: { tagLabel: "Popular", icon: <TargetIcon size={12} weight="fill" /> },
  new_member: { tagLabel: "New member", icon: <UsersThreeIcon size={12} weight="fill" /> },
  suggested: { tagLabel: "Try this", icon: <SparkleIcon size={12} weight="fill" /> },
};

function NudgeRow({ nudge }: { nudge: DiscoverNudge }) {
  const style = NUDGE_STYLES[nudge.type];
  return (
    <Link
      to={nudge.ctaUrl}
      className="group flex items-start gap-3 rounded-md p-3 transition-colors hover:bg-muted/40 md:flex-1 lg:flex-none"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#FEED01]/15 text-[#8B7A00] dark:bg-[#FEED01]/[0.06] dark:text-[#FEED01]">
        {style.icon}
      </div>
      {/* Inner wrapper changes direction by breakpoint:
          • sm/default: column → CTA stacked below content
          • md (cards stretched wide): row → CTA on right
          • lg+ (bento, narrow): column → CTA stacked below content again */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-3 lg:flex-col lg:items-start lg:gap-1">
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
            {style.tagLabel}
          </span>
          <p className="mt-0.5 truncate text-sm font-medium leading-snug transition-colors group-hover:text-[#8B7A00] dark:group-hover:text-[#FEED01]">
            {nudge.title}
          </p>
          {nudge.description && (
            <p className="mt-0.5 truncate text-xs leading-snug text-muted-foreground">{nudge.description}</p>
          )}
        </div>
        <p className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground/70 transition-colors group-hover:text-[#8B7A00] dark:group-hover:text-[#FEED01]">
          {nudge.ctaLabel}
          <ArrowRightIcon
            size={11}
            className="-translate-x-0.5 transition-transform duration-150 group-hover:translate-x-0"
          />
        </p>
      </div>
    </Link>
  );
}

// ── Usage tiles ──────────────────────────────────────────────────────────────

const USAGE_TINT = {
  bg: "bg-[#FEED01]/15 dark:bg-[#FEED01]/[0.06]",
  text: "text-[#8B7A00] dark:text-[#FEED01]",
  bar: "bg-[#8B7A00] dark:bg-[#FEED01]",
} as const;

function UsageTile({
  label,
  value,
  delta,
  emptyCopy,
}: {
  label: string;
  value: number;
  delta: number;
  emptyCopy: React.ReactNode;
}) {
  const isEmpty = value === 0;
  const isNegative = delta < 0;
  const isPositive = delta > 0;

  // Decorative bar — shows ~20% by default for non-zero, fills more as value grows (capped)
  const barPct = isEmpty ? 0 : Math.min(20 + value * 1.5, 100);

  return (
    <div className="group flex flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/15">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">{label}</h3>
      <p className="text-3xl font-medium leading-none tabular-nums">{value}</p>
      {isEmpty ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : delta !== 0 ? (
        <span
          className={cn(
            "flex items-center gap-1 text-xs tabular-nums",
            isNegative ? "text-destructive" : "text-success",
          )}
        >
          {isPositive ? <ArrowUpIcon size={10} /> : <ArrowDownIcon size={10} />}
          {Math.abs(delta)}% from last week
        </span>
      ) : null}
      {isEmpty ? (
        <p className="text-xs leading-snug text-muted-foreground">{emptyCopy}</p>
      ) : (
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-all", USAGE_TINT.bar)} style={{ width: `${barPct}%` }} />
        </div>
      )}
    </div>
  );
}
