import { useDashboardAuth } from "@/routes/dashboard";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute } from "../dashboard";
import { PersonalView } from "./personal-view";
import { TabButton } from "./shared";
import type { AdminTab, TimePeriod } from "./shared";
import { TeamView } from "./team-view";

export const usageRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/usage",
  component: UsagePage,
});

function UsagePage() {
  const auth = useDashboardAuth();
  const isAdmin = auth.role === "admin";
  const [activeTab, setActiveTab] = useState<AdminTab>("team");
  const [timePeriod, setTimePeriod] = useState<TimePeriod>("Month");

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
