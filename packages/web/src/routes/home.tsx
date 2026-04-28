/**
 * Home page — personal dashboard. Answers "What is Sketch doing for me,
 * and am I getting the most out of it?" Structure is identical for admin
 * and member; content is personalised.
 */
import { CustomizeQuickJumpDialog } from "@/components/customize-quick-jump-dialog";
import { type NavItem, getDashboardNav } from "@/lib/dashboard-nav";
import { useDashboardAuth } from "@/routes/dashboard";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BrainIcon,
  CalendarDotsIcon,
  ChatCircleIcon,
  CheckIcon,
  LinkSimpleIcon,
  MagnifyingGlassIcon,
  PlugIcon,
  PlusIcon,
  SparkleIcon,
  TargetIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type React from "react";
import { useEffect, useState } from "react";

const QUICK_JUMP_STORAGE_KEY = "sketch.home.quickJump";

// ── Types ────────────────────────────────────────────────────────────────────

interface SetupSteps {
  slack: boolean;
  firstConversation: boolean;
  firstSkill: boolean;
  integration: boolean;
  scheduledTask: boolean;
}

type ActivityItem = (
  | {
      kind: "sketch";
      icon: React.ReactNode;
      title: string;
      outcome: string;
    }
  | {
      kind: "user";
      initials: string;
      title: string;
    }
) & {
  /** Grouping label, e.g. "Today", "Yesterday", "Mon". */
  day: string;
  /** Clock time only, e.g. "9:00 AM". */
  time: string;
};

/** Sketch-action tile: subtle brand-yellow wash + olive icon (light) / yellow icon (dark). */
const SKETCH_TILE = "bg-[#FEED01]/15 dark:bg-[#FEED01]/[0.06] text-[#8B7A00] dark:text-[#FEED01]";

interface UsageStats {
  /** Messages this week. */
  messages: number;
  /** Percent change vs previous week (0 = no change / unavailable). */
  messagesDelta: number;
  /** Skills triggered this week. */
  skills: number;
  /** Percent change vs previous week (0 = no change / unavailable). */
  skillsDelta: number;
}

interface QuickShortcut {
  label: string;
  href: string;
  icon: React.ReactNode;
}

interface DiscoverItem {
  kind: "skill" | "integration";
  icon: React.ReactNode;
  name: string;
  description: string;
  href: string;
}

/** Drives the rotating subtitle under the greeting. */
export interface HomeDigest {
  /** Days since the user joined. < 7 → only nudges; ≥ 7 → rotate all variants. */
  daysActive: number;
  tasksRanToday: number;
  /** Pre-formatted, e.g. "5:00 PM" or "Tomorrow 9 AM". */
  nextScheduledLabel?: string;
  hoursSavedThisWeek: number;
  runningNow: number;
  scheduledToday: number;
}

export interface HomePageProps {
  setupSteps?: SetupSteps;
  activity?: ActivityItem[];
  usage?: UsageStats;
  shortcuts?: QuickShortcut[];
  discover?: DiscoverItem[];
  digest?: HomeDigest;
}

// ── Defaults (populated admin view) ──────────────────────────────────────────

const DEFAULT_SETUP: SetupSteps = {
  slack: true,
  firstConversation: true,
  firstSkill: true,
  integration: false,
  scheduledTask: false,
};

const DEFAULT_ACTIVITY: ActivityItem[] = [
  {
    kind: "sketch",
    icon: <CalendarDotsIcon size={16} />,
    title: "Weekly standup digest ran",
    outcome: "Posted summary to #team-product",
    day: "Today",
    time: "9:00 AM",
  },
  {
    kind: "user",
    initials: "AP",
    title: "You triggered Meeting Summary",
    day: "Today",
    time: "8:42 AM",
  },
  {
    kind: "sketch",
    icon: <MagnifyingGlassIcon size={16} />,
    title: "Competitive Intel ran",
    outcome: "Drafted report on 3 competitors",
    day: "Yesterday",
    time: "4:15 PM",
  },
  {
    kind: "user",
    initials: "AP",
    title: "You asked about Q2 pipeline",
    day: "Yesterday",
    time: "2:30 PM",
  },
  {
    kind: "sketch",
    icon: <ChatCircleIcon size={16} />,
    title: "Slack digest posted",
    outcome: "3 threads summarised",
    day: "Mon",
    time: "9:00 AM",
  },
];

const DEFAULT_USAGE: UsageStats = {
  messages: 42,
  messagesDelta: 40,
  skills: 8,
  skillsDelta: -27,
};

const DEFAULT_SHORTCUTS: QuickShortcut[] = [
  { label: "Skills", href: "/skills", icon: <BrainIcon size={18} /> },
  { label: "Scheduled", href: "/scheduled-tasks", icon: <CalendarDotsIcon size={18} /> },
  { label: "Integrations", href: "/integrations", icon: <LinkSimpleIcon size={18} /> },
];

const DEFAULT_DIGEST: HomeDigest = {
  daysActive: 30,
  tasksRanToday: 3,
  nextScheduledLabel: "5:00 PM",
  hoursSavedThisWeek: 2,
  runningNow: 1,
  scheduledToday: 2,
};

const NUDGES = [
  "Ask me to summarize today's standup in Slack",
  "Ask me what's blocking the launch and I'll dig in",
  "Schedule a daily digest and future you will say thanks",
  "Connect Notion so I can actually read your docs",
];

const DEFAULT_DISCOVER: DiscoverItem[] = [
  {
    kind: "skill",
    icon: <TargetIcon size={16} />,
    name: "Lead Qualifier",
    description: "3 teammates use this to score inbound leads",
    href: "/skills",
  },
  {
    kind: "integration",
    icon: <PlugIcon size={16} />,
    name: "Notion",
    description: "Connected by 2 teammates — give Sketch access to your docs",
    href: "/integrations",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getGreeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] ?? displayName;
}

function countCompleted(steps: SetupSteps): number {
  return Object.values(steps).filter(Boolean).length;
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

/**
 * Subtitle under the greeting. New users (< 7 days) only see nudges so they
 * learn what Sketch can do. Established users get a random pick across four
 * framings (today snapshot, value framing, what's running, nudge) so the page
 * feels alive on each visit and on a 30-min interval.
 *
 * Variants whose underlying data is empty are filtered out so we never show
 * "0 tasks done today".
 */
function pickSubtitle(digest: HomeDigest): string {
  if (digest.daysActive < 7) {
    return pickRandom(NUDGES);
  }

  const variants: string[] = [];

  if (digest.tasksRanToday > 0) {
    variants.push(
      digest.nextScheduledLabel
        ? `Knocked out ${pluralize(digest.tasksRanToday, "task")} today and the next one runs at ${digest.nextScheduledLabel}`
        : `${pluralize(digest.tasksRanToday, "task")} done today and nothing else on the books`,
    );
  }

  if (digest.hoursSavedThisWeek > 0) {
    variants.push(
      pickRandom([
        `Got about ${pluralize(digest.hoursSavedThisWeek, "hour")} of your week back`,
        `Saved you roughly ${pluralize(digest.hoursSavedThisWeek, "hour")} this week so go take a long lunch`,
      ]),
    );
  }

  if (digest.runningNow > 0 && digest.scheduledToday > 0) {
    variants.push(
      pickRandom([
        `Heads down on ${pluralize(digest.runningNow, "task")} with ${digest.scheduledToday} more lined up today`,
        `${pluralize(digest.runningNow, "task")} in flight and ${digest.scheduledToday} more queued for today`,
      ]),
    );
  } else if (digest.runningNow > 0) {
    variants.push(`Heads down on ${pluralize(digest.runningNow, "task")} right now`);
  } else if (digest.scheduledToday > 0) {
    variants.push(`${pluralize(digest.scheduledToday, "task")} queued for today`);
  }

  variants.push(pickRandom(NUDGES));

  return pickRandom(variants);
}

const SUBTITLE_ROTATE_MS = 30 * 60 * 1000;

// ── Page ─────────────────────────────────────────────────────────────────────

export function HomePage({
  setupSteps = DEFAULT_SETUP,
  activity = DEFAULT_ACTIVITY,
  usage = DEFAULT_USAGE,
  shortcuts = DEFAULT_SHORTCUTS,
  discover = DEFAULT_DISCOVER,
  digest = DEFAULT_DIGEST,
}: HomePageProps) {
  const auth = useDashboardAuth();

  const completedCount = countCompleted(setupSteps);
  const setupComplete = completedCount === 5;

  return (
    <div className="mx-auto max-w-4xl px-10 py-8">
      <GreetingBar firstName={firstName(auth.displayName)} digest={digest} />

      <div className="mt-8 grid grid-cols-1 gap-x-6 gap-y-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          {!setupComplete && <YourSetup steps={setupSteps} completedCount={completedCount} />}
          <ActivityFeed items={activity} />
        </div>

        <div className="space-y-6 xl:col-span-2">
          <YourUsage usage={usage} />
          <QuickJump shortcuts={shortcuts} />
          {discover.length > 0 && <Discover items={discover} />}
        </div>
      </div>
    </div>
  );
}

// ── Zone 1: Greeting ─────────────────────────────────────────────────────────

function GreetingBar({ firstName, digest }: { firstName: string; digest: HomeDigest }) {
  const hour = new Date().getHours();
  const greeting = getGreeting(hour);

  // Lazy init pins the pick to mount (so it's stable on render). The interval
  // re-rolls every 30 min for users who leave the page open.
  const [subtitle, setSubtitle] = useState(() => pickSubtitle(digest));

  useEffect(() => {
    const id = setInterval(() => setSubtitle(pickSubtitle(digest)), SUBTITLE_ROTATE_MS);
    return () => clearInterval(id);
  }, [digest]);

  return (
    <div className="min-w-0">
      <h1 className="text-xl font-semibold text-foreground">
        {greeting}, {firstName}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

// ── Zone 2: Your setup ───────────────────────────────────────────────────────

interface StepDef {
  key: keyof SetupSteps;
  label: string;
  subtext?: string;
  cta?: { label: string; href: string };
}

const SETUP_STEPS: StepDef[] = [
  {
    key: "slack",
    label: "Connected Slack",
    subtext: "Sketch lives in your DMs and channels",
    cta: { label: "Connect", href: "/integrations" },
  },
  {
    key: "firstConversation",
    label: "Had your first conversation",
    subtext: "Send Sketch a DM and ask anything",
    cta: { label: "Open Slack", href: "/channels" },
  },
  {
    key: "firstSkill",
    label: "Triggered a skill",
    subtext: "Run a saved workflow your team uses",
    cta: { label: "Browse", href: "/skills" },
  },
  {
    key: "integration",
    label: "Connected an integration",
    subtext: "Give Sketch context about your tools",
    cta: { label: "Connect", href: "/integrations" },
  },
  {
    key: "scheduledTask",
    label: "Scheduled your first task",
    subtext: "Automate something you do every week",
    cta: { label: "Schedule", href: "/scheduled-tasks" },
  },
];

function YourSetup({ steps, completedCount }: { steps: SetupSteps; completedCount: number }) {
  const nextIndex = SETUP_STEPS.findIndex((s) => !steps[s.key]);

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Your setup</p>
        <p className="shrink-0 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{completedCount}</span> of 5
        </p>
      </div>

      <ol className="mt-5 space-y-2">
        {SETUP_STEPS.map((step, idx) => {
          const done = steps[step.key];
          const isNext = !done && idx === nextIndex;
          return <SetupStepRow key={step.key} step={step} done={done} isNext={isNext} />;
        })}
      </ol>
    </section>
  );
}

function SetupStepRow({ step, done, isNext }: { step: StepDef; done: boolean; isNext: boolean }) {
  return (
    <li className="flex items-start gap-3">
      <StepDot done={done} isNext={isNext} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className={cn("text-sm", done ? "text-muted-foreground" : "font-medium")}>{step.label}</p>
          {!done && step.cta ? (
            <Link
              to={step.cta.href}
              className={cn(
                "shrink-0 text-xs font-medium hover:text-[#8B7A00] dark:hover:text-[#FEED01]",
                isNext ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step.cta.label} →
            </Link>
          ) : null}
        </div>
        {!done && step.subtext ? <p className="mt-1 text-xs text-muted-foreground">{step.subtext}</p> : null}
      </div>
    </li>
  );
}

function StepDot({ done, isNext }: { done: boolean; isNext: boolean }) {
  if (done) {
    return (
      <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[#FEED01] ring-1 ring-[#C8B832]/40 dark:ring-0">
        <CheckIcon size={10} weight="bold" className="text-[#040404]" />
      </div>
    );
  }
  if (isNext) {
    return (
      <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-foreground">
        <div className="size-1.5 rounded-full bg-foreground" />
      </div>
    );
  }
  return <div className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-border" />;
}

// ── Zone 3: Activity feed ────────────────────────────────────────────────────

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  const visible = items.slice(0, 4);
  const groups = groupByDay(visible);

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Recent activity</p>
        <Link
          to="/usage"
          className="shrink-0 text-xs font-medium text-muted-foreground hover:text-[#8B7A00] dark:hover:text-[#FEED01]"
        >
          All →
        </Link>
      </div>

      {visible.length === 0 ? (
        <div className="mt-5 flex flex-col items-center gap-2 py-10 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <SparkleIcon size={18} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">No activity yet</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Send your first message in Slack, and Sketch will start showing up here.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {groups.map((group) => (
            <ActivityDayGroup key={group.day} day={group.day} items={group.items} />
          ))}
        </div>
      )}
    </section>
  );
}

function groupByDay(items: ActivityItem[]): { day: string; items: ActivityItem[] }[] {
  const groups: { day: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.day === item.day) {
      last.items.push(item);
    } else {
      groups.push({ day: item.day, items: [item] });
    }
  }
  return groups;
}

function ActivityDayGroup({ day, items }: { day: string; items: ActivityItem[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{day}</p>
      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <ActivityRow key={`${item.kind}-${item.title}-${item.time}`} item={item} />
        ))}
      </ul>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <li className="flex items-center gap-3">
      {item.kind === "sketch" ? (
        <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", SKETCH_TILE)}>
          {item.icon}
        </div>
      ) : (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
          {item.initials}
        </div>
      )}
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{item.title}</span>
        {item.kind === "sketch" && item.outcome ? (
          <span className="text-muted-foreground"> · {item.outcome}</span>
        ) : null}
      </p>
      <p className="shrink-0 text-xs text-muted-foreground tabular-nums">{item.time}</p>
    </li>
  );
}

// ── Zone 4: Your usage ───────────────────────────────────────────────────────

function YourUsage({ usage }: { usage: UsageStats }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Your usage · this week</p>
      <div className="mt-5 grid grid-cols-2 gap-4">
        <UsageStat label="Messages" value={usage.messages} delta={usage.messagesDelta} />
        <UsageStat label="Skills used" value={usage.skills} delta={usage.skillsDelta} />
      </div>
    </section>
  );
}

function UsageStat({ label, value, delta }: { label: string; value: number; delta: number }) {
  const isNegative = delta < 0;
  const isPositive = delta > 0;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-[26px] font-medium leading-tight">{value}</p>
      {delta !== 0 ? (
        <p
          className={cn(
            "mt-1 flex items-center gap-1 text-xs",
            isNegative ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {isPositive ? <ArrowUpIcon size={10} /> : <ArrowDownIcon size={10} />}
          {Math.abs(delta)}%
        </p>
      ) : null}
    </div>
  );
}

// ── Zone 5: Quick jump ───────────────────────────────────────────────────────

function loadStoredHrefs(fallback: string[]): string[] {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(QUICK_JUMP_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return (parsed as string[]).slice(0, 4);
    }
  } catch {
    /* ignore parse errors — fall through to fallback */
  }
  return fallback;
}

function QuickJump({ shortcuts: initialShortcuts }: { shortcuts: QuickShortcut[] }) {
  const fallbackHrefs = initialShortcuts.map((s) => s.href);
  const [hrefs, setHrefs] = useState<string[]>(() => loadStoredHrefs(fallbackHrefs));
  const [editOpen, setEditOpen] = useState(false);

  const navByHref = new Map<string, NavItem>(getDashboardNav(18).map((n) => [n.href, n]));
  const shortcuts: QuickShortcut[] = hrefs
    .map((href) => navByHref.get(href))
    .filter((n): n is NavItem => n != null)
    .map((n) => ({ label: n.label, href: n.href, icon: n.icon }));

  const slots: { key: string; shortcut: QuickShortcut | null }[] = shortcuts.map((s) => ({
    key: s.href,
    shortcut: s,
  }));
  while (slots.length < 4) slots.push({ key: `empty-${slots.length}`, shortcut: null });

  const handleSave = (newHrefs: string[]) => {
    setHrefs(newHrefs);
    try {
      window.localStorage.setItem(QUICK_JUMP_STORAGE_KEY, JSON.stringify(newHrefs));
    } catch {
      /* localStorage unavailable or quota exceeded — keep in-memory state only */
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Quick jump</p>
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground hover:text-[#8B7A00] dark:hover:text-[#FEED01]"
          onClick={() => setEditOpen(true)}
        >
          Edit
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        {slots.map(({ key, shortcut }) =>
          shortcut ? (
            <Link
              key={key}
              to={shortcut.href}
              className="group flex h-[82px] min-w-0 flex-col items-center justify-center gap-2 rounded-md bg-[#FEED01]/15 px-2 text-center transition-colors hover:bg-[#FEED01]/25 dark:bg-[#FEED01]/[0.06] dark:hover:bg-[#FEED01]/10"
            >
              <span className="text-muted-foreground transition-colors group-hover:text-foreground">
                {shortcut.icon}
              </span>
              <span className="line-clamp-2 w-full text-sm font-medium leading-tight">{shortcut.label}</span>
            </Link>
          ) : (
            <button
              key={key}
              type="button"
              onClick={() => setEditOpen(true)}
              className="flex h-[82px] min-w-0 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-[#8B7A00]/20 px-2 text-center text-muted-foreground/60 transition-colors hover:border-[#8B7A00]/50 hover:text-[#8B7A00] dark:border-[#FEED01]/15 dark:hover:border-[#FEED01]/40 dark:hover:text-[#FEED01]"
            >
              <PlusIcon size={18} />
              <span className="text-sm leading-tight">Add</span>
            </button>
          ),
        )}
      </div>

      <CustomizeQuickJumpDialog open={editOpen} initialHrefs={hrefs} onOpenChange={setEditOpen} onSave={handleSave} />
    </section>
  );
}

// ── Zone 6: Discover ─────────────────────────────────────────────────────────

function Discover({ items }: { items: DiscoverItem[] }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Discover</p>

      <ul className="mt-3 space-y-2">
        {items.slice(0, 1).map((item) => (
          <li key={`${item.kind}-${item.name}`}>
            <Link to={item.href} className="group flex items-start gap-3 py-1">
              <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", SKETCH_TILE)}>
                {item.icon}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium transition-colors group-hover:text-[#8B7A00] dark:group-hover:text-[#FEED01]">
                  {item.name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
              </div>
              <ArrowRightIcon
                size={14}
                className="mt-2 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:text-[#8B7A00] group-hover:opacity-100 dark:group-hover:text-[#FEED01]"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
