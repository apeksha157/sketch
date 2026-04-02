import { api } from "@/lib/api";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { AmountSpentCard, MetricCard } from "./metric-cards";
import { ActivityByChannel, PERIOD_MAP, TimeFilter, TopSkills, formatPeriodLabel } from "./shared";
import type { TimePeriod } from "./shared";
import { UsageOverTimeChart } from "./usage-chart";

export function PersonalView({
  timePeriod,
  onTimePeriodChange,
}: {
  timePeriod: TimePeriod;
  onTimePeriodChange: (v: TimePeriod) => void;
}) {
  const apiPeriod = PERIOD_MAP[timePeriod];

  const { data } = useQuery({
    queryKey: ["usage", "me", apiPeriod],
    queryFn: () => api.usage.me({ period: apiPeriod }),
    placeholderData: keepPreviousData,
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

      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="Messages handled" value={data ? data.messages.total.toLocaleString() : "—"} delta={0} />
        <AmountSpentCard value={data?.spend.total_cost_usd ?? 0} periodLabel={timePeriod.toLowerCase()} />
      </div>

      <UsageOverTimeChart timePeriod={timePeriod} data={data} />

      <div className="grid gap-6 sm:grid-cols-2">
        <ActivityByChannel channels={channels} title="My activity by channel" />
        <TopSkills skills={skills} title="My top skills" />
      </div>
    </div>
  );
}
