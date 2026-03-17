import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useDashboardAuth } from "@/routes/dashboard";
import { ArrowDownIcon, ArrowUpIcon, CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { createRoute } from "@tanstack/react-router";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import { useEffect, useMemo, useState } from "react";
import { Chart } from "react-chartjs-2";
import { dashboardRoute } from "./dashboard";

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend, Filler);

export const usageRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/usage",
  component: UsagePage,
});

type TimePeriod = "Week" | "Month" | "Quarter";
type AdminTab = "team" | "my-usage";
type TableFilter = "all" | "members" | "groups" | "agents";

// --- Mock data (replace with API calls when backend is ready) ---

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
  memberCount: number;
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

const MOCK_MEMBERS: TeamMember[] = [
  {
    name: "Himanshu Kalra",
    type: "member",
    isCurrentUser: true,
    messages: 98,
    skillsUsed: 22,
    lastActive: "Today",
    activityPct: 85,
  },
  {
    name: "Apeksha Maithani",
    type: "member",
    isCurrentUser: false,
    messages: 116,
    skillsUsed: 19,
    lastActive: "Today",
    activityPct: 90,
  },
  {
    name: "Bharat Gandhi",
    type: "member",
    isCurrentUser: false,
    messages: 42,
    skillsUsed: 8,
    lastActive: "Yesterday",
    activityPct: 34,
  },
  {
    name: "Nayan Das",
    type: "member",
    isCurrentUser: false,
    messages: 12,
    skillsUsed: 3,
    lastActive: "3d ago",
    activityPct: 11,
  },
  {
    name: "Aditya Priyam",
    type: "member",
    isCurrentUser: false,
    messages: null,
    skillsUsed: null,
    lastActive: "Never",
    activityPct: 0,
  },
  {
    name: "K Saurabh",
    type: "member",
    isCurrentUser: false,
    messages: null,
    skillsUsed: null,
    lastActive: "Never",
    activityPct: 0,
  },
];

const MOCK_GROUPS: TeamGroup[] = [
  {
    name: "Engineering",
    type: "group",
    memberCount: 4,
    messages: 268,
    skillsUsed: 52,
    lastActive: "Today",
    activityPct: 78,
  },
  {
    name: "Sales",
    type: "group",
    memberCount: 3,
    messages: 84,
    skillsUsed: 14,
    lastActive: "Yesterday",
    activityPct: 42,
  },
  {
    name: "Marketing",
    type: "group",
    memberCount: 2,
    messages: 36,
    skillsUsed: 6,
    lastActive: "3d ago",
    activityPct: 18,
  },
];

const MOCK_AGENTS: TeamAgent[] = [
  { name: "Sketcher Agent", type: "agent", messages: 47, lastActive: "Today", activityPct: 44 },
  { name: "SEO Ninja Agent", type: "agent", messages: 18, lastActive: "2d ago", activityPct: 18 },
];

const MOCK_ALL_ENTITIES: TeamEntity[] = [...MOCK_MEMBERS, ...MOCK_GROUPS, ...MOCK_AGENTS];

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
  skillsTriggered: { value: 74, delta: 8, deltaLabel: "vs previous period" },
  amountSpent: { value: 14.2, delta: 0, periodLabel: "this week" },
};

const MOCK_PERSONAL_METRICS = {
  messagesHandled: { value: 98, delta: 15, deltaLabel: "vs previous period" },
  amountSpent: { value: 3.4, delta: 0, periodLabel: "this week" },
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

const MOCK_USAGE_CHART_WEEK = {
  labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  messages: [18, 24, 14, 22, 12, 4, 4],
  skills: [6, 8, 4, 7, 5, 1, 1],
};

const MOCK_USAGE_CHART_MONTH = {
  labels: Array.from({ length: 30 }, (_, i) => {
    const d = i + 1;
    return d % 3 === 1 ? `Mar ${d}` : "";
  }),
  messages: Array.from({ length: 30 }, () => Math.floor(Math.random() * 20) + 2),
  skills: Array.from({ length: 30 }, () => Math.floor(Math.random() * 8)),
};

const MOCK_USAGE_CHART_QUARTER = {
  labels: Array.from({ length: 13 }, (_, i) => `W${i + 1}`),
  messages: Array.from({ length: 13 }, () => Math.floor(Math.random() * 120) + 20),
  skills: Array.from({ length: 13 }, () => Math.floor(Math.random() * 40)),
};

// --- Components ---

function UsagePage() {
  const auth = useDashboardAuth();
  const isAdmin = auth.role === "admin";
  const [activeTab, setActiveTab] = useState<AdminTab>("team");
  const [timePeriod, setTimePeriod] = useState<TimePeriod>("Week");

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div>
        <h1 className="text-[22px] font-medium">{isAdmin ? "Usage" : "My usage"}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
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
        "relative pb-3 font-mono text-[11px] uppercase tracking-[0.07em] transition-colors",
        isActive ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
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
  const options: TimePeriod[] = ["Week", "Month", "Quarter"];
  return (
    <div className="inline-flex rounded-lg border-[0.5px] border-border bg-card p-0.5 dark:bg-[#111110]">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={cn(
            "rounded-md px-3 py-1 text-xs transition-colors",
            value === opt
              ? "bg-accent font-medium text-foreground dark:bg-[#1C1C1A]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt}
        </button>
      ))}
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
  const m = MOCK_TEAM_METRICS;

  return (
    <div className="mt-6 space-y-6">
      {/* Time filter + plan tag */}
      <div className="flex items-center justify-between">
        <TimeFilter value={timePeriod} onChange={onTimePeriodChange} />
        <span className="font-mono text-[11px] text-muted-foreground">Pro plan · renews Apr 1</span>
      </div>

      {/* 3-up metric cards */}
      <div className="grid grid-cols-3 gap-3">
        <MetricCard
          label="Total messages"
          value={m.totalMessages.value.toLocaleString()}
          delta={m.totalMessages.delta}
        />
        <MetricCard
          label="Skills triggered"
          value={m.skillsTriggered.value.toLocaleString()}
          delta={m.skillsTriggered.delta}
        />
        <AmountSpentCard value={m.amountSpent.value} periodLabel={m.amountSpent.periodLabel} />
      </div>

      {/* Team adoption table */}
      <div>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Team adoption</p>
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

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between">
        <TimeFilter value={timePeriod} onChange={onTimePeriodChange} />
      </div>

      {/* 2-up metric cards */}
      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          label="Messages handled"
          value={m.messagesHandled.value.toLocaleString()}
          delta={m.messagesHandled.delta}
        />
        <AmountSpentCard value={m.amountSpent.value} periodLabel={m.amountSpent.periodLabel} />
      </div>

      {/* Usage over time graph */}
      <UsageOverTimeChart timePeriod={timePeriod} />

      {/* Activity by channel + Top skills */}
      <div className="grid gap-6 sm:grid-cols-2">
        <ActivityByChannel channels={MOCK_PERSONAL_CHANNELS} title="My activity by channel" />
        <TopSkills skills={MOCK_PERSONAL_SKILLS} title="My top skills" />
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
  value: string;
  delta: number;
  deltaLabel?: string;
}) {
  const isNegative = delta < 0;
  const isPositive = delta > 0;

  return (
    <div className="rounded-lg bg-card p-4 dark:bg-[#111110]">
      <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-[26px] font-medium leading-tight">{value}</p>
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

function AmountSpentCard({ value, periodLabel }: { value: number; periodLabel: string }) {
  const pctOfPlan = Math.min((value / 100) * 100, 100);
  const isAmber = pctOfPlan >= 80;

  return (
    <div className="rounded-lg bg-card p-4 dark:bg-[#111110]">
      <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Amount spent</p>
      <p className={cn("mt-1 text-[26px] font-medium leading-tight", isAmber && "text-amber-600 dark:text-amber-400")}>
        ${value.toFixed(2)}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">{periodLabel}</p>
      <div className="mt-2 h-[7px] w-full overflow-hidden rounded-[4px] bg-[#B4B2A9] dark:bg-[#4A4840]">
        <div
          className={cn("h-full rounded-[4px] transition-all", isAmber ? "bg-amber-500" : "bg-[#FEED01]")}
          style={{ width: `${pctOfPlan}%` }}
        />
      </div>
      <p className="mt-1 font-mono text-[9px] text-muted-foreground">{Math.round(pctOfPlan)}% of plan</p>
    </div>
  );
}

// --- Usage Over Time Chart ---

function useDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function UsageOverTimeChart({ timePeriod }: { timePeriod: TimePeriod }) {
  const isDark = useDarkMode();
  const chartData =
    timePeriod === "Week"
      ? MOCK_USAGE_CHART_WEEK
      : timePeriod === "Month"
        ? MOCK_USAGE_CHART_MONTH
        : MOCK_USAGE_CHART_QUARTER;

  const data = useMemo(
    () => ({
      labels: chartData.labels,
      datasets: [
        {
          type: "line" as const,
          label: "Messages",
          data: chartData.messages,
          borderColor: "#C8A800",
          backgroundColor: (ctx: {
            chart: { ctx: CanvasRenderingContext2D; chartArea?: { top: number; bottom: number } };
          }) => {
            const { chart } = ctx;
            const fallback = isDark ? "rgba(200,168,0,0.25)" : "rgba(254,237,1,0.28)";
            if (!chart.chartArea) return fallback;
            const gradient = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
            if (isDark) {
              gradient.addColorStop(0, "rgba(200,168,0,0.25)");
              gradient.addColorStop(0.7, "rgba(200,168,0,0.06)");
              gradient.addColorStop(1, "rgba(200,168,0,0)");
            } else {
              gradient.addColorStop(0, "rgba(254,237,1,0.28)");
              gradient.addColorStop(0.7, "rgba(254,237,1,0.08)");
              gradient.addColorStop(1, "rgba(254,237,1,0)");
            }
            return gradient;
          },
          borderWidth: 2,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointBackgroundColor: "#FEED01",
          pointHoverBackgroundColor: "#FEED01",
          pointBorderColor: "#C8A800",
          pointHoverBorderColor: "#C8A800",
          pointBorderWidth: 1.5,
          fill: true,
          yAxisID: "y",
        },
        {
          type: "line" as const,
          label: "Skills triggered",
          data: chartData.skills,
          borderColor: isDark ? "#444441" : "#B4B2A9",
          backgroundColor: "transparent",
          borderWidth: 1.5,
          borderDash: [4, 3],
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 3,
          pointBackgroundColor: isDark ? "#040404" : "#ffffff",
          pointHoverBackgroundColor: isDark ? "#040404" : "#ffffff",
          pointBorderColor: isDark ? "#5F5E5A" : "#888780",
          pointHoverBorderColor: isDark ? "#5F5E5A" : "#888780",
          pointBorderWidth: 1.5,
          fill: false,
          yAxisID: "y1",
        },
      ],
    }),
    [chartData, isDark],
  );

  const tickColor = isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)";
  const gridColor = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)";

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index" as const, intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? "#1C1C1A" : "#ffffff",
          titleColor: isDark ? "#FAFAF8" : "#040404",
          titleFont: { family: "IBM Plex Mono", size: 10 },
          bodyColor: isDark ? "#9C9A92" : "#5f5e5a",
          bodyFont: { family: "Inter", size: 11 },
          borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
          borderWidth: 0.5,
          padding: 10,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: tickColor, font: { family: "Inter", size: 11 }, padding: 4 },
        },
        y: {
          position: "left" as const,
          grid: { color: gridColor, lineWidth: 0.5 },
          border: { display: false, dash: [3, 3] },
          ticks: { color: tickColor, font: { family: "Inter", size: 10 } },
        },
        y1: {
          position: "right" as const,
          grid: { display: false },
          border: { display: false },
          ticks: { color: tickColor, font: { family: "Inter", size: 10 } },
        },
      },
    }),
    [isDark, tickColor, gridColor],
  );

  const skillsLegendGradient = isDark
    ? "repeating-linear-gradient(to right, #444441 0px, #444441 4px, transparent 4px, transparent 7px)"
    : "repeating-linear-gradient(to right, #B4B2A9 0px, #B4B2A9 4px, transparent 4px, transparent 7px)";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Usage over time</p>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded-full bg-[#C8A800]" />
            Messages
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ backgroundImage: skillsLegendGradient }} />
            Skills triggered
          </span>
        </div>
      </div>
      <div className="h-[120px]">
        <Chart type="line" data={data} options={options} />
      </div>
    </div>
  );
}

// --- Team Adoption Table ---

const ROWS_PER_PAGE = 20;

function TeamAdoptionTable() {
  const [filter, setFilter] = useState<TableFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const filteredEntities = useMemo(() => {
    let entities: TeamEntity[];
    switch (filter) {
      case "members":
        entities = MOCK_MEMBERS;
        break;
      case "groups":
        entities = MOCK_GROUPS;
        break;
      case "agents":
        entities = MOCK_AGENTS;
        break;
      default:
        entities = MOCK_ALL_ENTITIES;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      entities = entities.filter((e) => e.name.toLowerCase().includes(q));
    }
    return entities;
  }, [filter, search]);

  const totalPages = Math.max(1, Math.ceil(filteredEntities.length / ROWS_PER_PAGE));
  const pagedEntities = filteredEntities.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);

  const filteredCounts = useMemo(() => {
    if (!search.trim()) {
      return {
        all: MOCK_ALL_ENTITIES.length,
        members: MOCK_MEMBERS.length,
        groups: MOCK_GROUPS.length,
        agents: MOCK_AGENTS.length,
      };
    }
    const q = search.toLowerCase();
    return {
      all: MOCK_ALL_ENTITIES.filter((e) => e.name.toLowerCase().includes(q)).length,
      members: MOCK_MEMBERS.filter((e) => e.name.toLowerCase().includes(q)).length,
      groups: MOCK_GROUPS.filter((e) => e.name.toLowerCase().includes(q)).length,
      agents: MOCK_AGENTS.filter((e) => e.name.toLowerCase().includes(q)).length,
    };
  }, [search]);

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

  const colCount = filter === "agents" ? 4 : filter === "groups" ? 6 : 5;

  return (
    <div className="overflow-hidden rounded-lg border-[0.5px] border-border bg-card">
      {/* Toolbar: filter tabs + search */}
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

      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="px-4 py-2.5 font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
              {filter === "groups" ? "Group" : filter === "agents" ? "Agent" : "Member"}
            </th>
            {filter === "groups" ? (
              <th className="px-4 py-2.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
                Members
              </th>
            ) : null}
            <th className="px-4 py-2.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
              Messages
            </th>
            {filter !== "agents" ? (
              <th className="px-4 py-2.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
                Skills used
              </th>
            ) : null}
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
              <td colSpan={colCount} className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                No results for &ldquo;{search}&rdquo;
              </td>
            </tr>
          ) : (
            pagedEntities.map((entity) => (
              <EntityRow
                key={entity.name}
                entity={entity}
                showSkills={filter !== "agents"}
                showMembers={filter === "groups"}
              />
            ))
          )}
        </tbody>
      </table>

      {/* Pagination */}
      {filteredEntities.length > 0 ? (
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5 font-mono text-[10px] uppercase text-muted-foreground">
          <span>
            Showing {Math.min(pagedEntities.length, ROWS_PER_PAGE)} of {filteredEntities.length}
          </span>
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
            {totalPages > 5 ? <span className="px-1">…</span> : null}
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
        </div>
      ) : null}
    </div>
  );
}

function EntityRow({
  entity,
  showSkills,
  showMembers,
}: {
  entity: TeamEntity;
  showSkills: boolean;
  showMembers: boolean;
}) {
  const messages = entity.messages;
  const skillsUsed = entity.type !== "agent" ? (entity as TeamMember | TeamGroup).skillsUsed : null;
  const isCurrentUser = entity.type === "member" && (entity as TeamMember).isCurrentUser;
  const memberCount = entity.type === "group" ? (entity as TeamGroup).memberCount : null;

  return (
    <tr className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-secondary/50 dark:hover:bg-muted/30">
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
          {entity.type === "agent" ? (
            <Badge variant="secondary" className="rounded-[4px] px-1.5 py-0 text-[9px]">
              Agent
            </Badge>
          ) : null}
          {entity.type === "group" ? (
            <>
              <Badge
                variant="secondary"
                className="rounded-[4px] bg-muted px-1.5 py-0 text-[9px] text-muted-foreground"
              >
                Group
              </Badge>
              {memberCount !== null ? (
                <span className="text-[11px] text-muted-foreground">· {memberCount} members</span>
              ) : null}
            </>
          ) : null}
        </div>
      </td>
      {showMembers ? (
        <td className="px-4 py-2.5 text-right text-xs text-muted-foreground tabular-nums">
          {memberCount !== null ? `${memberCount}` : <span className="text-muted-foreground">&mdash;</span>}
        </td>
      ) : null}
      <td className="px-4 py-2.5 text-right tabular-nums">
        {messages !== null ? messages : <span className="text-muted-foreground">&mdash;</span>}
      </td>
      {showSkills ? (
        <td className="px-4 py-2.5 text-right tabular-nums">
          {entity.type === "agent" ? (
            <span className="text-muted-foreground">&mdash;</span>
          ) : skillsUsed !== null ? (
            skillsUsed
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </td>
      ) : null}
      <td className="px-4 py-2.5 text-muted-foreground">{entity.lastActive}</td>
      <td className="px-4 py-2.5">
        <ActivityBar pct={entity.activityPct} />
      </td>
    </tr>
  );
}

// --- Shared components ---

function AvatarChip({ name, type = "member" }: { name: string; type?: "member" | "agent" }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={cn(
        "flex size-[24px] shrink-0 items-center justify-center rounded-full text-[9px] font-medium",
        type === "agent"
          ? "border-[0.5px] border-dashed border-muted-foreground/40 bg-muted text-muted-foreground dark:bg-muted/50"
          : "border-[0.5px] border-border bg-muted text-muted-foreground dark:bg-muted/50",
      )}
    >
      {initials}
    </div>
  );
}

function GroupAvatar({ name }: { name: string }) {
  const initial = name[0]?.toUpperCase() ?? "G";
  return (
    <div className="flex size-[24px] shrink-0 items-center justify-center rounded-[6px] border-[0.5px] border-border bg-muted text-[9px] font-medium text-muted-foreground dark:bg-muted/50">
      {initial}
    </div>
  );
}

function ActivityBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-[7px] w-[80px] overflow-hidden rounded-[4px] bg-[#B4B2A9] dark:bg-[#4A4840]">
        {pct > 0 ? <div className="h-full rounded-[4px] bg-[#FEED01]" style={{ width: `${pct}%` }} /> : null}
      </div>
    </div>
  );
}

function ChannelIcon({ platform }: { platform: "slack" | "whatsapp" | "email" }) {
  if (platform === "slack")
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0 rounded-[4px]" aria-hidden="true">
        <rect width={16} height={16} rx={4} fill="#4A154B" />
        <text
          x={8}
          y={12}
          textAnchor="middle"
          fill="white"
          fontSize={11}
          fontWeight={700}
          fontFamily="Inter, sans-serif"
        >
          #
        </text>
      </svg>
    );
  if (platform === "whatsapp")
    return (
      <svg width={16} height={16} viewBox="0 0 10 10" className="shrink-0 rounded-[4px]" aria-hidden="true">
        <rect width={10} height={10} rx={2.5} fill="#25D366" />
        <path
          d="M5 1C2.79 1 1 2.79 1 5C1 5.74 1.21 6.43 1.57 7.02L1 9L3.06 8.45C3.63 8.78 4.29 8.97 5 8.97C7.21 8.97 9 7.18 9 4.97C9 2.79 7.21 1 5 1Z"
          fill="white"
        />
      </svg>
    );
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0 rounded-[4px]" aria-hidden="true">
      <rect width={16} height={16} rx={4} fill="#444441" />
      <path
        d="M12 4.5H4c-.55 0-1 .45-1 1v5c0 .55.45 1 1 1h8c.55 0 1-.45 1-1v-5c0-.55-.45-1-1-1zm0 2-4 2.5-4-2.5v-1l4 2.5 4-2.5v1z"
        fill="white"
      />
    </svg>
  );
}

function ActivityByChannel({
  channels,
  title = "Activity by channel",
}: {
  channels: Array<{ platform: "slack" | "whatsapp" | "email"; label: string; count: number; pct: number }>;
  title?: string;
}) {
  const maxCount = Math.max(...channels.map((c) => c.count), 1);

  return (
    <div>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
      <div className="space-y-3">
        {channels.map((ch) => (
          <div key={ch.platform} className="flex items-center gap-2.5">
            <div className="flex w-[90px] items-center gap-2 text-[13px] text-foreground">
              <ChannelIcon platform={ch.platform} />
              <span>{ch.label}</span>
            </div>
            <div className="h-[7px] flex-1 overflow-hidden rounded-[4px] bg-[#B4B2A9] dark:bg-[#4A4840]">
              <div className="h-full rounded-[4px] bg-[#FEED01]" style={{ width: `${(ch.count / maxCount) * 100}%` }} />
            </div>
            <span className="w-[28px] text-right font-mono text-[11px] tabular-nums text-foreground">{ch.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopSkills({
  skills,
  title = "Top skills",
}: {
  skills: Array<{ name: string; category: string; count: number }>;
  title?: string;
}) {
  return (
    <div>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
      <div className="space-y-2.5">
        {skills.map((skill) => (
          <div key={skill.name} className="flex items-center justify-between">
            <div>
              <p className={cn("text-[13px] font-medium", skill.count === 0 && "italic text-muted-foreground")}>
                {skill.name}
              </p>
              <p className="text-[11px] text-muted-foreground">{skill.category}</p>
            </div>
            <span className="font-mono text-[12px] tabular-nums">
              <span className={cn("font-medium", skill.count === 0 && "text-muted-foreground")}>{skill.count}</span>
              <span className="text-muted-foreground">×</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
