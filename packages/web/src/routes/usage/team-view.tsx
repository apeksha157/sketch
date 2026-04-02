import { api } from "@/lib/api";
import { useDashboardAuth } from "@/routes/dashboard";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { AmountSpentCard, MetricCard } from "./metric-cards";
import { ActivityByChannel, PERIOD_MAP, TimeFilter, TopSkills, formatPeriodLabel } from "./shared";
import type { TimePeriod } from "./shared";
import { TeamAdoptionTable } from "./team-adoption-table";

export function TeamView({
  timePeriod,
  onTimePeriodChange,
}: {
  timePeriod: TimePeriod;
  onTimePeriodChange: (v: TimePeriod) => void;
}) {
  const auth = useDashboardAuth();
  const apiPeriod = PERIOD_MAP[timePeriod];

  const { data } = useQuery({
    queryKey: ["usage", "summary", apiPeriod],
    queryFn: () => api.usage.summary({ period: apiPeriod }),
    placeholderData: keepPreviousData,
  });

  const { data: usersData } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.users.list(),
  });

  const channels = useMemo(() => {
    if (!data) return [];
    return data.messages.by_platform.map((p) => ({
      platform: p.platform as "slack" | "whatsapp" | "email",
      label: p.platform.charAt(0).toUpperCase() + p.platform.slice(1),
      count: p.count,
      pct: data.messages.total > 0 ? Math.round((p.count / data.messages.total) * 100) : 0,
    }));
  }, [data]);

  const skills = useMemo(() => {
    if (!data) return [];
    return data.skills.by_skill.map((s) => ({ name: s.name, category: "", count: s.count }));
  }, [data]);

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between">
        <TimeFilter value={timePeriod} onChange={onTimePeriodChange} />
        {data ? (
          <span className="font-mono text-[11px] text-muted-foreground">{formatPeriodLabel(data.period)}</span>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <MetricCard label="Total messages" value={data ? data.messages.total.toLocaleString() : "—"} delta={0} />
        <MetricCard label="Skills triggered" value={data ? data.skills.total.toLocaleString() : "—"} delta={0} />
        <AmountSpentCard value={data?.spend.total_cost_usd ?? 0} periodLabel={timePeriod.toLowerCase()} />
      </div>

      <div>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Team adoption</p>
        <TeamAdoptionTable
          byUser={data?.by_user ?? []}
          byGroup={data?.by_group ?? []}
          allUsers={usersData?.users ?? []}
          currentUserId={auth.userId}
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <ActivityByChannel channels={channels} />
        <TopSkills skills={skills} />
      </div>
    </div>
  );
}
