import { Hono } from "hono";
import type { Kysely } from "kysely";
import { createAgentRunsRepo } from "../db/repositories/agent-runs";
import type { DB } from "../db/schema";

const VALID_PERIODS = ["weekly", "monthly", "quarterly"] as const;
type PeriodType = (typeof VALID_PERIODS)[number];

interface Period {
  from: string;
  to: string;
  type: PeriodType;
}

export function usageRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const repo = createAgentRunsRepo(db);

  routes.get("/me", async (c) => {
    const sub = c.get("sub");
    const period = parsePeriodOrError(c);
    if ("error" in period) return c.json({ error: { code: "BAD_REQUEST", message: period.error } }, 400);

    const [summary, skills, dailyBreakdown] = await Promise.all([
      repo.getMemberSummary(sub, period.from, period.to),
      repo.getMemberSkills(sub, period.from, period.to),
      repo.getDailyBreakdown(sub, period.from, period.to),
    ]);

    return c.json({
      period,
      messages: {
        total: summary.totalMessages,
        by_platform: summary.messagesByPlatform,
      },
      spend: { total_cost_usd: round2(summary.totalCostUsd) },
      skills: { total: summary.totalSkills, by_skill: skills },
      daily_breakdown: dailyBreakdown,
    });
  });

  routes.get("/summary", async (c) => {
    if (c.get("role") !== "admin") {
      return c.json({ error: { code: "FORBIDDEN", message: "Admin access required" } }, 403);
    }

    const period = parsePeriodOrError(c);
    if ("error" in period) return c.json({ error: { code: "BAD_REQUEST", message: period.error } }, 400);

    const [summary, skills, byUser, byGroup] = await Promise.all([
      repo.getOrgSummary(period.from, period.to),
      repo.getOrgSkills(period.from, period.to),
      repo.getOrgByUser(period.from, period.to),
      repo.getGroupBreakdown(period.from, period.to),
    ]);

    return c.json({
      period,
      messages: {
        total: summary.totalMessages,
        by_platform: summary.messagesByPlatform,
      },
      spend: { total_cost_usd: round2(summary.totalCostUsd) },
      skills: { total: summary.totalSkills, by_skill: skills },
      by_user: byUser.map((u) => ({ ...u, costUsd: round2(u.costUsd) })),
      by_group: byGroup,
    });
  });

  return routes;
}

function computePeriod(type: PeriodType, date: Date): Period {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  switch (type) {
    case "weekly": {
      const day = date.getUTCDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(Date.UTC(year, month, date.getUTCDate() + mondayOffset));
      const nextMonday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000);
      return { from: monday.toISOString(), to: nextMonday.toISOString(), type };
    }
    case "monthly":
      return {
        from: new Date(Date.UTC(year, month, 1)).toISOString(),
        to: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
        type,
      };
    case "quarterly": {
      const qStart = Math.floor(month / 3) * 3;
      return {
        from: new Date(Date.UTC(year, qStart, 1)).toISOString(),
        to: new Date(Date.UTC(year, qStart + 3, 1)).toISOString(),
        type,
      };
    }
  }
}

function parsePeriodOrError(c: {
  req: { query: (k: string) => string | undefined };
}): Period | { error: string } {
  const rawPeriod = c.req.query("period");
  const rawDate = c.req.query("date");

  if (rawPeriod && !VALID_PERIODS.includes(rawPeriod as PeriodType)) {
    return { error: `Invalid period: "${rawPeriod}". Must be weekly, monthly, or quarterly.` };
  }

  const periodType: PeriodType = rawPeriod ? (rawPeriod as PeriodType) : "monthly";

  let date = new Date();
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return { error: `Invalid date: "${rawDate}". Must be YYYY-MM-DD.` };
    }
    date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) {
      return { error: `Invalid date: "${rawDate}". Must be YYYY-MM-DD.` };
    }
  }

  return computePeriod(periodType, date);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
