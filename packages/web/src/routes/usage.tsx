import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDashboardAuth } from "@/routes/dashboard";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChatCircleIcon,
  EnvelopeSimpleIcon,
  SlackLogoIcon,
  WarningIcon,
  WhatsappLogoIcon,
} from "@phosphor-icons/react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute } from "./dashboard";

export const usageRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/usage",
  component: UsagePage,
});

type TimePeriod = "7D" | "1M" | "3M";
type AdminTab = "team" | "my-usage";

// --- Mock data (replace with API calls when backend is ready) ---

const MOCK_TEAM_MEMBERS = [
  { name: "Himanshu Kalra", isCurrentUser: true, messages: 98, skillsUsed: 22, lastActive: "Today", activityPct: 85 },
  {
    name: "Apeksha Maithani",
    isCurrentUser: false,
    messages: 116,
    skillsUsed: 19,
    lastActive: "Today",
    activityPct: 90,
  },
  {
    name: "Bharat Gandhi",
    isCurrentUser: false,
    messages: 42,
    skillsUsed: 8,
    lastActive: "Yesterday",
    activityPct: 34,
  },
  { name: "Nayan Das", isCurrentUser: false, messages: 12, skillsUsed: 3, lastActive: "3d ago", activityPct: 11 },
  {
    name: "Aditya Priyam",
    isCurrentUser: false,
    messages: null,
    skillsUsed: null,
    lastActive: "Never",
    activityPct: 0,
  },
  { name: "K Saurabh", isCurrentUser: false, messages: null, skillsUsed: null, lastActive: "Never", activityPct: 0 },
];

const MOCK_AGENTS = [
  { name: "Sketcher Agent", messages: 47, lastActive: "Today", activityPct: 44 },
  { name: "SEO Ninja Agent", messages: 18, lastActive: "2d ago", activityPct: 18 },
];

const MOCK_CHANNELS = [
  { platform: "slack" as const, label: "Slack", count: 214, pct: 100 },
  { platform: "whatsapp" as const, label: "WhatsApp", count: 56, pct: 26 },
];

const MOCK_SKILLS = [
  { name: "Weekly Report", category: "Reporting", count: 34 },
  { name: "Lead Enrichment", category: "Sales", count: 22 },
  { name: "Meeting Summary", category: "Productivity", count: 18 },
  { name: "Competitor Watch", category: "Research", count: 0 },
];

const MOCK_TEAM_METRICS = {
  totalMessages: { value: 290, delta: 12, deltaLabel: "vs previous period" },
  tasksAutomated: { value: 47, delta: -2, deltaLabel: "2 failed this week" },
  skillsTriggered: { value: 74, delta: 8, deltaLabel: "vs previous period" },
  creditsUsed: { value: 62, label: "of monthly plan" },
};

const MOCK_PERSONAL_METRICS = {
  messagesHandled: { value: 98, delta: 15, deltaLabel: "vs previous period" },
  tasksAutomated: { value: 12, delta: 0, deltaLabel: "" },
  skillsTriggered: { value: 22, delta: 3, deltaLabel: "3 new this week" },
};

const MOCK_PERSONAL_CHANNELS = [
  { platform: "slack" as const, label: "Slack", count: 82, pct: 100 },
  { platform: "whatsapp" as const, label: "WhatsApp", count: 16, pct: 20 },
];

const MOCK_PERSONAL_SKILLS = [
  { name: "Weekly Report", category: "Reporting", count: 12 },
  { name: "Meeting Summary", category: "Productivity", count: 8 },
  { name: "Lead Enrichment", category: "Sales", count: 2 },
  { name: "Competitor Watch", category: "Research", count: 0 },
];

// --- Components ---

function UsagePage() {
  const auth = useDashboardAuth();
  const isAdmin = auth.role === "admin";
  const [activeTab, setActiveTab] = useState<AdminTab>("team");
  const [timePeriod, setTimePeriod] = useState<TimePeriod>("7D");

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div>
        <h1 className="text-xl font-bold">{isAdmin ? "Usage" : "My Usage"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isAdmin
            ? "Monitor your workspace activity and team adoption."
            : "Your personal activity with Sketch this week."}
        </p>
      </div>

      {isAdmin ? (
        <>
          <div className="mt-6 flex items-center gap-6 border-b border-border">
            <TabButton label="Team" isActive={activeTab === "team"} onClick={() => setActiveTab("team")} />
            <TabButton label="My usage" isActive={activeTab === "my-usage"} onClick={() => setActiveTab("my-usage")} />
          </div>

          {activeTab === "team" ? (
            <TeamView timePeriod={timePeriod} onTimePeriodChange={setTimePeriod} />
          ) : (
            <PersonalView timePeriod={timePeriod} onTimePeriodChange={setTimePeriod} />
          )}
        </>
      ) : (
        <PersonalView timePeriod={timePeriod} onTimePeriodChange={setTimePeriod} />
      )}
    </div>
  );
}

function TabButton({ label, isActive, onClick }: { label: string; isActive: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative pb-3 text-sm font-medium transition-colors",
        isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {isActive ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[#FEED01]" /> : null}
    </button>
  );
}

function TimeFilter({
  value,
  onChange,
}: {
  value: TimePeriod;
  onChange: (v: TimePeriod) => void;
}) {
  const options: TimePeriod[] = ["7D", "1M", "3M"];
  return (
    <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition-colors",
            value === opt ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function HealthBanner({
  message,
  ctaLabel,
  ctaHref,
}: {
  message: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/30">
      <WarningIcon size={16} className="shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="flex-1 text-sm text-amber-800 dark:text-amber-300">{message}</p>
      <button
        type="button"
        onClick={() => navigate({ to: ctaHref })}
        className="shrink-0 text-sm font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-200"
      >
        {ctaLabel}
      </button>
    </div>
  );
}

// --- Team View ---

function TeamView({
  timePeriod,
  onTimePeriodChange,
}: {
  timePeriod: TimePeriod;
  onTimePeriodChange: (v: TimePeriod) => void;
}) {
  const navigate = useNavigate();
  const m = MOCK_TEAM_METRICS;

  return (
    <div className="mt-6 space-y-6">
      {/* Time filter + plan tag */}
      <div className="flex items-center justify-between">
        <TimeFilter value={timePeriod} onChange={onTimePeriodChange} />
        <span className="text-xs text-muted-foreground">Pro plan · renews Apr 1</span>
      </div>

      {/* Health banner — shown conditionally */}
      {m.tasksAutomated.delta < 0 ? (
        <HealthBanner
          message={`${Math.abs(m.tasksAutomated.delta)} scheduled tasks failed across the workspace.`}
          ctaLabel="Review"
          ctaHref="/scheduled-tasks?filter=failed"
        />
      ) : null}

      {/* 4-up metric cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Total messages" value={m.totalMessages.value} delta={m.totalMessages.delta} />
        <MetricCard
          label="Tasks automated"
          value={m.tasksAutomated.value}
          delta={m.tasksAutomated.delta}
          deltaLabel={m.tasksAutomated.deltaLabel}
        />
        <MetricCard label="Skills triggered" value={m.skillsTriggered.value} delta={m.skillsTriggered.delta} />
        <CreditsCard value={m.creditsUsed.value} />
      </div>

      {/* Team adoption table */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">Team adoption</p>
          <button
            type="button"
            onClick={() => navigate({ to: "/team" })}
            className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Invite members
          </button>
        </div>
        <TeamAdoptionTable />
      </div>

      {/* Activity by channel + Top skills */}
      <div className="grid gap-6 sm:grid-cols-2">
        <ActivityByChannel channels={MOCK_CHANNELS} />
        <TopSkills skills={MOCK_SKILLS} />
      </div>
    </div>
  );
}

// --- Personal View (shared by admin "My usage" tab and member view) ---

function PersonalView({
  timePeriod,
  onTimePeriodChange,
}: {
  timePeriod: TimePeriod;
  onTimePeriodChange: (v: TimePeriod) => void;
}) {
  const m = MOCK_PERSONAL_METRICS;
  const failedCount = m.tasksAutomated.delta < 0 ? Math.abs(m.tasksAutomated.delta) : 0;

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between">
        <TimeFilter value={timePeriod} onChange={onTimePeriodChange} />
      </div>

      {failedCount > 0 ? (
        <HealthBanner
          message={`${failedCount} of your scheduled tasks failed last night.`}
          ctaLabel="View task"
          ctaHref="/scheduled-tasks"
        />
      ) : null}

      {/* 3-up metric cards */}
      <div className="grid grid-cols-3 gap-3">
        <MetricCard label="Messages handled" value={m.messagesHandled.value} delta={m.messagesHandled.delta} />
        <MetricCard
          label="Tasks automated"
          value={m.tasksAutomated.value}
          delta={m.tasksAutomated.delta}
          deltaLabel={m.tasksAutomated.deltaLabel}
        />
        <MetricCard
          label="Skills triggered"
          value={m.skillsTriggered.value}
          delta={m.skillsTriggered.delta}
          deltaLabel={m.skillsTriggered.deltaLabel}
        />
      </div>

      {/* Activity by channel + Top skills */}
      <div className="grid gap-6 sm:grid-cols-2">
        <ActivityByChannel channels={MOCK_PERSONAL_CHANNELS} />
        <TopSkills skills={MOCK_PERSONAL_SKILLS} />
      </div>
    </div>
  );
}

// --- Metric Cards ---

function MetricCard({
  label,
  value,
  delta,
  deltaLabel,
}: {
  label: string;
  value: number;
  delta: number;
  deltaLabel?: string;
}) {
  const isNegative = delta < 0;
  const isPositive = delta > 0;

  return (
    <div className="rounded-lg bg-[#F4F4F2] p-4 dark:bg-muted/50">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold">{value.toLocaleString()}</p>
      {delta !== 0 ? (
        <p
          className={cn(
            "mt-1 flex items-center gap-1 text-[11px]",
            isNegative ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {isPositive ? <ArrowUpIcon size={10} /> : <ArrowDownIcon size={10} />}
          {isNegative ? deltaLabel || `${Math.abs(delta)}%` : deltaLabel || `${delta}%`}
        </p>
      ) : null}
    </div>
  );
}

function CreditsCard({ value }: { value: number }) {
  const isWarning = value >= 80;
  return (
    <div className="rounded-lg bg-[#F4F4F2] p-4 dark:bg-muted/50">
      <p className="text-[11px] font-medium text-muted-foreground">Credits used</p>
      <p className={cn("mt-1 text-lg font-bold", isWarning && "text-amber-600 dark:text-amber-400")}>{value}%</p>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div
          className={cn("h-full rounded-full transition-all", isWarning ? "bg-amber-500" : "bg-foreground/60")}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    </div>
  );
}

// --- Team Adoption Table ---

function TeamAdoptionTable() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">Member</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Messages</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Skills used</th>
            <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">Last active</th>
            <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">Activity</th>
          </tr>
        </thead>
        <tbody>
          {MOCK_TEAM_MEMBERS.map((member) => (
            <tr key={member.name} className="border-b border-border last:border-b-0">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <AvatarChip name={member.name} />
                  <span className="text-sm font-medium">{member.name}</span>
                  {member.isCurrentUser ? (
                    <Badge className="bg-[#E6F1FB] text-[#185FA5] text-[9px] px-1.5 py-0 dark:bg-[#185FA5]/20 dark:text-[#6CB4EE]">
                      You
                    </Badge>
                  ) : null}
                </div>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {member.messages !== null ? member.messages : <span className="text-muted-foreground">&mdash;</span>}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {member.skillsUsed !== null ? (
                  member.skillsUsed
                ) : (
                  <span className="text-muted-foreground">&mdash;</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{member.lastActive}</td>
              <td className="px-4 py-2.5">
                <ActivityBar pct={member.activityPct} />
              </td>
            </tr>
          ))}

          {/* Agents divider */}
          <tr className="border-b border-border">
            <td
              colSpan={5}
              className="px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              Agents
            </td>
          </tr>

          {MOCK_AGENTS.map((agent) => (
            <tr key={agent.name} className="border-b border-border last:border-b-0">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <AvatarChip name={agent.name} />
                  <span className="text-sm font-medium">{agent.name}</span>
                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                    Agent
                  </Badge>
                </div>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{agent.messages}</td>
              <td className="px-4 py-2.5 text-right text-muted-foreground">&mdash;</td>
              <td className="px-4 py-2.5 text-muted-foreground">{agent.lastActive}</td>
              <td className="px-4 py-2.5">
                <ActivityBar pct={agent.activityPct} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Shared components ---

const AVATAR_COLORS = [
  { bg: "bg-violet-100 dark:bg-violet-900/40", text: "text-violet-700 dark:text-violet-300" },
  { bg: "bg-sky-100 dark:bg-sky-900/40", text: "text-sky-700 dark:text-sky-300" },
  { bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-700 dark:text-amber-300" },
  { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-700 dark:text-emerald-300" },
  { bg: "bg-rose-100 dark:bg-rose-900/40", text: "text-rose-700 dark:text-rose-300" },
  { bg: "bg-indigo-100 dark:bg-indigo-900/40", text: "text-indigo-700 dark:text-indigo-300" },
];

function AvatarChip({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const colorPair = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];

  return (
    <div
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-medium",
        colorPair.bg,
        colorPair.text,
      )}
    >
      {initials}
    </div>
  );
}

function ActivityBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-[5px] w-14 overflow-hidden rounded-full bg-muted">
        {pct > 0 ? <div className="h-full rounded-full bg-[#E0A020]" style={{ width: `${pct}%` }} /> : null}
      </div>
    </div>
  );
}

function ChannelIcon({ platform }: { platform: "slack" | "whatsapp" | "email" }) {
  if (platform === "slack") return <SlackLogoIcon size={14} />;
  if (platform === "whatsapp") return <WhatsappLogoIcon size={14} />;
  return <EnvelopeSimpleIcon size={14} />;
}

const CHANNEL_BAR_COLORS: Record<string, string> = {
  slack: "bg-[#E0A020]",
  whatsapp: "bg-[#4CAF82]",
  email: "bg-blue-500",
};

function ActivityByChannel({
  channels,
}: {
  channels: Array<{ platform: "slack" | "whatsapp" | "email"; label: string; count: number; pct: number }>;
}) {
  const maxCount = Math.max(...channels.map((c) => c.count), 1);

  return (
    <div>
      <p className="mb-3 text-sm font-medium text-muted-foreground">Activity by channel</p>
      <div className="space-y-3">
        {channels.map((ch) => (
          <div key={ch.platform} className="flex items-center gap-3">
            <div className="flex w-20 items-center gap-1.5 text-xs text-muted-foreground">
              <ChannelIcon platform={ch.platform} />
              <span>{ch.label}</span>
            </div>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", CHANNEL_BAR_COLORS[ch.platform] ?? "bg-muted-foreground")}
                style={{ width: `${(ch.count / maxCount) * 100}%` }}
              />
            </div>
            <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{ch.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopSkills({
  skills,
}: {
  skills: Array<{ name: string; category: string; count: number }>;
}) {
  return (
    <div>
      <p className="mb-3 text-sm font-medium text-muted-foreground">Top skills</p>
      <div className="space-y-2.5">
        {skills.map((skill) => (
          <div key={skill.name} className="flex items-center justify-between">
            <div>
              <p className={cn("text-xs font-medium", skill.count === 0 && "italic text-muted-foreground")}>
                {skill.name}
              </p>
              <p className="text-[10px] text-muted-foreground">{skill.category}</p>
            </div>
            <span
              className={cn(
                "rounded-md bg-[#F4F4F2] px-2 py-0.5 text-[11px] tabular-nums dark:bg-muted/50",
                skill.count === 0 && "text-muted-foreground",
              )}
            >
              {skill.count}×
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
