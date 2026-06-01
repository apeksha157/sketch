import { useDashboardAuth } from "@/routes/dashboard";
import {
  BuildingsIcon,
  CalendarCheckIcon,
  CaretDownIcon,
  CheckIcon,
  CopySimpleIcon,
  GiftIcon,
  RocketLaunchIcon,
  UsersIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { createRoute } from "@tanstack/react-router";
import { forwardRef, useEffect, useRef, useState } from "react";
import { dashboardRoute } from "./dashboard";
import { hideTrialBanner } from "./demo/mock-query-provider";

export const plansRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans",
  component: function PlansPage() {
    const auth = useDashboardAuth();
    return <PlansPageContent userRole={auth.role} />;
  },
});

// New user — no plan
export const plansNewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/new",
  component: () => (
    <PlansPageContent viewOverride="new" lowCreditOverride={false} planOverride={null} promoOverride={false} />
  ),
});

// Startups plan — member
export const plansMemberStartupsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/member-startups",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="member" lowCreditOverride={false} planOverride="startups" promoOverride={false} />
  ),
});

// Startups plan — admin
export const plansAdminStartupsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/admin-startups",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="admin" lowCreditOverride={false} planOverride="startups" promoOverride={false} />
  ),
});

// Startups plan — admin, low credit
export const plansAdminStartupsLowRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/admin-startups-low",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="admin" lowCreditOverride={true} planOverride="startups" promoOverride={false} />
  ),
});

// Business plan — member
export const plansMemberBizRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/member-biz",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="member" lowCreditOverride={false} planOverride="business" promoOverride={false} />
  ),
});

// Business plan — admin
export const plansAdminBizRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/admin-biz",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="admin" lowCreditOverride={false} planOverride="business" promoOverride={false} />
  ),
});

// Business plan — admin, low credit
export const plansAdminBizLowRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/admin-biz-low",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="admin" lowCreditOverride={true} planOverride="business" promoOverride={false} />
  ),
});

// Promo — new user
export const plansPromoNewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/promo-new",
  component: () => <PlansPageContent viewOverride="new" lowCreditOverride={false} planOverride={null} promoOverride />,
});

// Promo — member startups
export const plansPromoMemberRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/promo-member",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="member" lowCreditOverride={false} planOverride="startups" promoOverride />
  ),
});

// Promo — admin startups
export const plansPromoAdminRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/promo-admin",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="admin" lowCreditOverride={false} planOverride="startups" promoOverride />
  ),
});

// Promo — admin business
export const plansPromoAdminBizRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/promo-admin-biz",
  beforeLoad: hideTrialBanner,
  component: () => (
    <PlansPageContent viewOverride="admin" lowCreditOverride={false} planOverride="business" promoOverride />
  ),
});

// Promo expiring — admin startups (7 days left)
export const plansPromoExpiringRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/promo-expiring",
  beforeLoad: hideTrialBanner,
  component: () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return (
      <PlansPageContent
        viewOverride="admin"
        lowCreditOverride={false}
        planOverride="startups"
        promoOverride
        promoEndDateOverride={d.toISOString().split("T")[0]}
      />
    );
  },
});

// Promo expiring — admin business (7 days left)
export const plansPromoExpiringBizRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/promo-expiring-biz",
  beforeLoad: hideTrialBanner,
  component: () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return (
      <PlansPageContent
        viewOverride="admin"
        lowCreditOverride={false}
        planOverride="business"
        promoOverride
        promoEndDateOverride={d.toISOString().split("T")[0]}
      />
    );
  },
});

// Trial banner — celebration state (day 1)
export const plansTrialCelebrationRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/trial-celebration",
  beforeLoad: () => {
    // Inject ?trial=1 so the banner preview hook picks it up
    if (!new URLSearchParams(window.location.search).has("trial")) {
      window.history.replaceState(null, "", `${window.location.pathname}?trial=1`);
    }
  },
  component: () => (
    <PlansPageContent viewOverride="admin" lowCreditOverride={false} planOverride="startups" promoOverride={false} />
  ),
});

// Trial banner — urgency state (day 12)
export const plansTrialUrgencyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans/trial-urgency",
  beforeLoad: () => {
    if (!new URLSearchParams(window.location.search).has("trial")) {
      window.history.replaceState(null, "", `${window.location.pathname}?trial=12`);
    }
  },
  component: () => (
    <PlansPageContent viewOverride="admin" lowCreditOverride={false} planOverride="startups" promoOverride={false} />
  ),
});

/* ─── Types & mock data ─── */

type PricingView = "new" | "member" | "admin";

const MOCK_WORKSPACE = {
  plan: "startups" as "startups" | "business" | null,
  credits: { total: 5000, remaining: 3100, used: 1900 },
  renewalDate: "May 1, 2026",
  members: 8,
};

const MOCK_WORKSPACE_LOW = {
  plan: "startups" as "startups" | "business" | null,
  credits: { total: 5000, remaining: 800, used: 4200 },
  renewalDate: "May 1, 2026",
  members: 8,
};

const MOCK_WORKSPACE_BIZ = {
  plan: "business" as "startups" | "business" | null,
  credits: { total: 15000, remaining: 9200, used: 5800 },
  renewalDate: "May 1, 2026",
  members: 22,
};

const MOCK_WORKSPACE_BIZ_LOW = {
  plan: "business" as "startups" | "business" | null,
  credits: { total: 15000, remaining: 2400, used: 12600 },
  renewalDate: "May 1, 2026",
  members: 22,
};

const DAYS_ELAPSED = 17;
const DAYS_UNTIL_RENEWAL = 14;

/* ─── Promo state ─── */

const MOCK_PROMO = {
  active: true,
  endDate: "2026-07-14",
};

const MOCK_PROMO_WORKSPACE = {
  plan: "startups" as "startups" | "business" | null,
  credits: { total: 5000, remaining: 3100, used: 1900 },
  renewalDate: "May 1, 2026",
  members: 8,
  tasksRun: 342,
  activeMemberCount: 6,
  memberCount: 8,
};

const MOCK_PROMO_WORKSPACE_BIZ = {
  plan: "business" as "startups" | "business" | null,
  credits: { total: 15000, remaining: 9200, used: 5800 },
  renewalDate: "May 1, 2026",
  members: 22,
  tasksRun: 1247,
  activeMemberCount: 18,
  memberCount: 22,
};

function formatPromoDate(isoDate: string) {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function promoDaysRemaining(endDate: string) {
  return Math.ceil((new Date(endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

interface CreditTier {
  credits: number;
  price: number;
}

const STARTUPS_BASE_PRICE = 100;
const STARTUPS_TIERS: CreditTier[] = [
  { credits: 5000, price: 50 },
  { credits: 10000, price: 96 },
  { credits: 15000, price: 138 },
  { credits: 25000, price: 220 },
];

const BUSINESS_BASE_PRICE = 250;
const BUSINESS_TIERS: CreditTier[] = [
  { credits: 15000, price: 138 },
  { credits: 25000, price: 220 },
  { credits: 50000, price: 420 },
  { credits: 100000, price: 800 },
];

const STARTUPS_FEATURES = [
  "Slack + WhatsApp + Email",
  "3,000+ integrations (unlimited)",
  "Unlimited workflows & scheduled tasks",
  "BYO API keys — cloud or on-prem",
  "Email support",
];

const BUSINESS_FEATURES = [
  "Slack + WhatsApp + Email",
  "3,000+ integrations (unlimited)",
  "Unlimited workflows & scheduled tasks",
  "BYO API keys — cloud or on-prem",
  "Priority email support",
];

function getSuggestedTopUp(dailyBurnRate: number, remaining: number) {
  const creditsNeeded = dailyBurnRate * DAYS_UNTIL_RENEWAL - remaining;
  return Math.ceil(Math.max(creditsNeeded, 1000) / 1000) * 1000;
}

/* ─── Main component ─── */

export function PlansPageContent({
  userRole = "admin",
  viewOverride,
  lowCreditOverride,
  planOverride,
  promoOverride,
  promoEndDateOverride,
}: {
  userRole?: "admin" | "member";
  viewOverride?: PricingView;
  lowCreditOverride?: boolean;
  planOverride?: "startups" | "business" | null;
  promoOverride?: boolean;
  promoEndDateOverride?: string;
}) {
  const topUpRef = useRef<HTMLDivElement>(null);

  const promoActive = promoOverride ?? MOCK_PROMO.active;
  const promoEndDate = promoEndDateOverride ?? MOCK_PROMO.endDate;
  const promoExpiring = promoActive && promoDaysRemaining(promoEndDate) <= 10 && userRole === "admin";

  const plan = planOverride ?? "startups";
  const useLowCredit = lowCreditOverride ?? false;
  const isBiz = plan === "business";

  // Use promo workspaces when promo is active
  const workspace = promoActive
    ? isBiz
      ? MOCK_PROMO_WORKSPACE_BIZ
      : MOCK_PROMO_WORKSPACE
    : isBiz
      ? useLowCredit
        ? MOCK_WORKSPACE_BIZ_LOW
        : MOCK_WORKSPACE_BIZ
      : useLowCredit
        ? MOCK_WORKSPACE_LOW
        : MOCK_WORKSPACE;

  const derivedView: PricingView = !workspace.plan ? "new" : userRole === "admin" ? "admin" : "member";
  const view = viewOverride ?? derivedView;

  const dailyBurnRate = Math.round(workspace.credits.used / DAYS_ELAPSED);
  const daysRemaining = dailyBurnRate > 0 ? Math.round(workspace.credits.remaining / dailyBurnRate) : 0;
  const creditPct = workspace.credits.remaining / workspace.credits.total;
  const isLowCredit = !promoActive && creditPct <= 0.2;
  const suggestedTopUp = getSuggestedTopUp(dailyBurnRate, workspace.credits.remaining);

  return (
    <div className="mx-auto max-w-4xl px-10 py-8 pb-20">
      {/* 1. Page header */}
      <h1 className="text-xl font-semibold text-foreground">Plans & pricing</h1>
      <p className="mt-2 text-sm text-muted-foreground">Manage your workspace plan and credit usage.</p>

      {/* 2. Credit overview — member & admin */}
      {view !== "new" &&
        (promoActive ? (
          <PromoCreditOverview
            workspace={workspace as typeof MOCK_PROMO_WORKSPACE}
            promoEndDate={promoEndDate}
            expiring={promoExpiring}
          />
        ) : (
          <CreditOverview workspace={workspace} daysRemaining={daysRemaining} isLowCredit={isLowCredit} />
        ))}

      {/* 3. Plan cards */}
      <PlanCards
        view={view}
        currentPlan={workspace.plan}
        renewalDate={workspace.renewalDate}
        promoActive={promoActive}
        promoEndDate={promoEndDate}
        promoExpiring={promoExpiring}
      />

      {/* 5. Top-up + what uses credits — hidden during promo */}
      {!promoActive && (view === "new" || view === "admin") && (
        <div className="mt-8 rounded-xl border border-border bg-card">
          <TopUpInteractive ref={topUpRef} />
          <div className="mx-6 flex items-center gap-2.5 border-t border-border py-3.5">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground">
              Credits per task
            </span>
            {[
              { label: "Quick tasks", range: "10–200" },
              { label: "Workflows", range: "100–300" },
              { label: "Projects", range: "500–750" },
            ].map((item) => (
              <span key={item.label} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                {item.label} <span className="font-semibold tabular-nums text-foreground">{item.range}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 7. Referral */}
      <ReferralSection />
    </div>
  );
}

/* ─── Credit overview stats ─── */

function CreditOverview({
  workspace,
  daysRemaining,
  isLowCredit,
}: {
  workspace: typeof MOCK_WORKSPACE;
  daysRemaining: number;
  isLowCredit: boolean;
}) {
  const warnLabel = isLowCredit
    ? "font-mono text-[10px] font-medium uppercase tracking-[.08em] text-warning/70"
    : "font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground";
  const warnNum = "mt-1.5 text-3xl font-bold leading-none tracking-[-1px] text-foreground";
  const subCls = "mt-1 whitespace-nowrap text-[11px] text-muted-foreground";

  return (
    <div className="mt-6 rounded-xl border border-border bg-card">
      <div className="grid grid-cols-3 px-1 py-4">
        {/* Credits left */}
        <div className="flex flex-col px-5">
          <p className={warnLabel}>Credits left</p>
          <p className={warnNum}>{workspace.credits.remaining.toLocaleString()}</p>
          <p className={subCls}>of {workspace.credits.total.toLocaleString()} this month</p>
        </div>

        {/* Used this month */}
        <div className="flex flex-col border-l border-border px-5">
          <p className={warnLabel}>Credits used</p>
          <p className={warnNum}>{workspace.credits.used.toLocaleString()}</p>
          <p className={subCls}>{Math.round((workspace.credits.used / workspace.credits.total) * 100)}% of plan</p>
        </div>

        {/* Resets in */}
        <div className="flex flex-col border-l border-border px-5">
          <p className={warnLabel}>Credits reset</p>
          <p className={warnNum}>{daysRemaining} days</p>
          <p className={subCls}>{workspace.renewalDate}</p>
        </div>
      </div>

      {isLowCredit && (
        <div className="mx-5 flex items-center gap-3 border-t border-border py-3">
          <WarningIcon size={16} weight="fill" className="shrink-0 text-warning/60" />
          <p className="text-[13px] text-muted-foreground">
            <span className="font-semibold text-foreground">Running low</span> — {daysRemaining} day
            {daysRemaining !== 1 ? "s" : ""} left at current pace. Top up credits below to avoid interruption.
          </p>
        </div>
      )}
    </div>
  );
}

/* ─── Promo credit overview (replaces CreditOverview during promo) ─── */

function PromoCreditOverview({
  workspace,
  promoEndDate,
  expiring = false,
}: {
  workspace: typeof MOCK_PROMO_WORKSPACE;
  promoEndDate: string;
  expiring?: boolean;
}) {
  const labelCls = "font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground";
  const numCls = "mt-1.5 text-3xl font-bold leading-none tracking-[-1px] text-foreground";
  const subCls = "mt-1 whitespace-nowrap text-[11px] text-muted-foreground";
  const daysLeft = promoDaysRemaining(promoEndDate);

  return (
    <div className="mt-6 rounded-xl border border-border bg-card">
      <div className="grid grid-cols-3 px-1 py-4">
        {/* Credits */}
        <div className="flex flex-col px-5">
          <p className={labelCls}>Credits</p>
          <p className={numCls}>∞</p>
          <p className={subCls}>Unlimited during launch</p>
        </div>

        {/* Tasks run */}
        <div className="flex flex-col border-l border-border px-5">
          <p className={labelCls}>Tasks run</p>
          <p className={numCls}>{workspace.tasksRun.toLocaleString()}</p>
          <p className={subCls}>since you joined</p>
        </div>

        {/* Promo ends — warning styling when expiring */}
        <div className="flex flex-col border-l border-border px-5">
          <p
            className={
              expiring ? "font-mono text-[10px] font-medium uppercase tracking-[.08em] text-warning/70" : labelCls
            }
          >
            Promo ends
          </p>
          <p
            className={
              expiring
                ? "mt-1.5 text-3xl font-bold leading-none tracking-[-1px] text-warning animate-pulse [animation-duration:3s]"
                : numCls
            }
          >
            {daysLeft} days
          </p>
          <p className={subCls}>{formatPromoDate(promoEndDate)}</p>
        </div>
      </div>

      {expiring && (
        <div className="mx-5 flex items-center gap-3 border-t border-border py-3">
          <WarningIcon size={16} weight="fill" className="shrink-0 text-warning/60" />
          <p className="text-[13px] text-muted-foreground">
            <span className="font-semibold text-foreground">Promo ending soon</span> — your unlimited credits expire in{" "}
            {daysLeft} days. Select a credit tier below to continue uninterrupted.
          </p>
        </div>
      )}
    </div>
  );
}

/* ─── Promo unlimited chip (replaces CreditTierSelect during promo) ─── */

function PromoUnlimitedChip({ promoEndDate }: { promoEndDate: string }) {
  return (
    <div className="flex w-full items-center rounded-[14px] border border-border bg-muted px-4 py-[9px]">
      <span className="text-[13px] font-medium text-foreground">∞ Unlimited credits</span>
      <span className="ml-auto font-mono text-[11px] text-muted-foreground">
        Free until {formatPromoDate(promoEndDate)}
      </span>
    </div>
  );
}

/* ─── Plan cards ─── */

function PlanCards({
  view,
  currentPlan,
  renewalDate,
  promoActive,
  promoEndDate,
  promoExpiring,
}: {
  view: PricingView;
  currentPlan: string | null;
  renewalDate: string;
  promoActive: boolean;
  promoEndDate: string;
  promoExpiring: boolean;
}) {
  return (
    <div className="mt-8 grid grid-cols-2 gap-4">
      <StartupsCard
        view={view}
        isCurrent={currentPlan === "startups"}
        renewalDate={renewalDate}
        promoActive={promoActive}
        promoEndDate={promoEndDate}
        promoExpiring={promoExpiring}
      />
      <BusinessCard
        view={view}
        isCurrent={currentPlan === "business"}
        renewalDate={renewalDate}
        promoActive={promoActive}
        promoEndDate={promoEndDate}
        promoExpiring={promoExpiring}
      />
    </div>
  );
}

/* ─── Current plan badge (Prompt 3) ─── */

function CurrentPlanRibbon() {
  return (
    <div className="absolute left-1/2 top-0 -translate-x-1/2 rounded-b-[10px] bg-foreground px-3.5 py-[3px] font-mono text-[10px] font-bold uppercase tracking-[.09em] text-background">
      Current plan
    </div>
  );
}

function StartupsCard({
  view,
  isCurrent,
  renewalDate,
  promoActive,
  promoEndDate,
  promoExpiring,
}: {
  view: PricingView;
  isCurrent: boolean;
  renewalDate: string;
  promoActive: boolean;
  promoEndDate: string;
  promoExpiring: boolean;
}) {
  const [selectedTier, setSelectedTier] = useState<number | null>(0);
  const tier = selectedTier != null ? STARTUPS_TIERS[selectedTier] : null;
  const addOnPrice = promoActive && !promoExpiring ? 0 : (tier?.price ?? 0);
  const totalPrice = STARTUPS_BASE_PRICE + (promoActive && !promoExpiring ? 0 : addOnPrice);
  const totalCredits = promoActive && !promoExpiring ? 0 : (tier?.credits ?? 0);
  const showBadge = isCurrent && view !== "new";

  return (
    <div
      className={`group/card relative flex flex-col overflow-hidden rounded-[20px] border border-border bg-card px-7 pb-7 pt-9 transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${view === "member" ? "hover:-translate-y-[1px] hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)] dark:hover:shadow-[0_4px_16px_rgba(0,0,0,0.2)]" : "hover:-translate-y-0.5 hover:border-[rgba(200,184,50,0.3)] hover:shadow-[0_4px_16px_rgba(200,184,50,0.06),0_0_30px_rgba(200,184,50,0.03)] dark:hover:border-[rgba(254,237,1,0.2)] dark:hover:shadow-[0_4px_20px_rgba(0,0,0,0.25),0_0_40px_rgba(254,237,1,0.06)]"}`}
    >
      {/* Current plan ribbon */}
      {showBadge && <CurrentPlanRibbon />}

      {/* Name with icon */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RocketLaunchIcon size={18} className="text-foreground" />
          <h3 className="text-base font-semibold text-foreground">Startups</h3>
        </div>
        <span className="flex items-center gap-1 text-muted-foreground">
          <UsersIcon size={12} />
          <span className="font-mono text-[11px]">20</span>
        </span>
      </div>

      {/* Price */}
      <div className="mt-6 flex items-baseline gap-1">
        <span className="text-[42px] font-bold leading-none tracking-[-2px] text-foreground">${totalPrice}</span>
        <span className="text-[13px] text-muted-foreground">/month</span>
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
        {promoActive && !promoExpiring
          ? "Unlimited credits included"
          : totalCredits > 0
            ? `$${(totalPrice / totalCredits).toFixed(3)} per credit`
            : promoExpiring
              ? "Select a tier for after promo"
              : "Add credits below"}
      </p>

      {/* Monthly credits label + selector */}
      <div className="mt-6">
        <p className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground">
          Monthly credits
        </p>
        {promoActive && !promoExpiring ? (
          <PromoUnlimitedChip promoEndDate={promoEndDate} />
        ) : (
          <CreditTierSelect
            tiers={STARTUPS_TIERS}
            selectedIndex={selectedTier}
            onSelect={setSelectedTier}
            promoDaysLeft={promoExpiring ? promoDaysRemaining(promoEndDate) : undefined}
          />
        )}
      </div>

      {/* CTA or renewal info */}
      <div className="mt-5">
        {view === "new" && (
          <button
            type="button"
            className="h-10 w-full rounded-[12px] bg-foreground text-[13px] font-semibold text-background transition-all hover:opacity-90 active:scale-[0.98]"
          >
            Get started
          </button>
        )}
        {view !== "new" && isCurrent && (
          <div className="flex h-10 w-full items-center justify-center gap-2 rounded-[12px] border border-border bg-muted text-[13px] text-muted-foreground">
            <CalendarCheckIcon weight="fill" className="h-4 w-4 text-muted-foreground/70" />
            Renews {renewalDate}
          </div>
        )}
        {view === "admin" && !isCurrent && (
          <button
            type="button"
            className="flex h-10 w-full items-center justify-center rounded-[12px] border border-border text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Downgrade to Startups
          </button>
        )}
        {view === "member" && !isCurrent && (
          <p className="flex h-10 items-center justify-center text-xs text-muted-foreground/50">
            Ask your admin to switch plans
          </p>
        )}
      </div>

      {/* Features */}
      <div className="mt-auto space-y-2.5 pt-5">
        {STARTUPS_FEATURES.map((f) => (
          <FeatureItem key={f} text={f} />
        ))}
      </div>
    </div>
  );
}

function BusinessCard({
  view,
  isCurrent,
  renewalDate,
  promoActive,
  promoEndDate,
  promoExpiring,
}: {
  view: PricingView;
  isCurrent: boolean;
  renewalDate: string;
  promoActive: boolean;
  promoEndDate: string;
  promoExpiring: boolean;
}) {
  const showCurrentBadge = isCurrent && view !== "new";
  const [selectedTier, setSelectedTier] = useState<number | null>(0);
  const tier = selectedTier != null ? BUSINESS_TIERS[selectedTier] : null;
  const addOnPrice = promoActive && !promoExpiring ? 0 : (tier?.price ?? 0);
  const totalPrice = BUSINESS_BASE_PRICE + (promoActive && !promoExpiring ? 0 : addOnPrice);
  const totalCredits = promoActive && !promoExpiring ? 0 : (tier?.credits ?? 0);

  return (
    <div
      className={`group/card relative flex flex-col overflow-hidden rounded-[20px] border border-[#C8B832] bg-card px-7 pb-7 pt-9 transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${view === "member" ? "hover:-translate-y-[1px] hover:shadow-[0_2px_8px_rgba(200,184,50,0.04)] dark:hover:shadow-[0_4px_16px_rgba(0,0,0,0.2)]" : "hover:-translate-y-0.5 hover:border-[#C8B832] hover:shadow-[0_4px_16px_rgba(200,184,50,0.08),0_0_30px_rgba(200,184,50,0.04)] dark:hover:border-[rgba(254,237,1,0.4)] dark:hover:shadow-[0_4px_20px_rgba(0,0,0,0.25),0_0_40px_rgba(254,237,1,0.06)]"}`}
    >
      {/* Most popular ribbon — only when not showing current badge */}
      {!showCurrentBadge && (
        <div className="absolute left-1/2 top-0 -translate-x-1/2 rounded-b-[10px] bg-[#FEED01] px-3.5 py-[3px] font-mono text-[10px] font-bold uppercase tracking-[.09em] text-[#040404]">
          Most popular
        </div>
      )}

      {/* Current plan ribbon */}
      {showCurrentBadge && <CurrentPlanRibbon />}

      {/* Name with icon */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BuildingsIcon size={18} className="text-foreground" />
          <h3 className="text-base font-semibold text-foreground">Business</h3>
        </div>
        <span className="flex items-center gap-1 text-muted-foreground">
          <UsersIcon size={12} />
          <span className="font-mono text-[11px]">50</span>
        </span>
      </div>

      {/* Price */}
      <div className="mt-6 flex items-baseline gap-1">
        <span className="text-[42px] font-bold leading-none tracking-[-2px] text-foreground">${totalPrice}</span>
        <span className="text-[13px] text-muted-foreground">/month</span>
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
        {promoActive && !promoExpiring
          ? "Unlimited credits included"
          : totalCredits > 0
            ? `$${(totalPrice / totalCredits).toFixed(3)} per credit`
            : promoExpiring
              ? "Select a tier for after promo"
              : "Add credits below"}
      </p>

      {/* Monthly credits label + selector */}
      <div className="mt-6">
        <p className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground">
          Monthly credits
        </p>
        {promoActive && !promoExpiring ? (
          <PromoUnlimitedChip promoEndDate={promoEndDate} />
        ) : (
          <CreditTierSelect
            tiers={BUSINESS_TIERS}
            selectedIndex={selectedTier}
            onSelect={setSelectedTier}
            promoDaysLeft={promoExpiring ? promoDaysRemaining(promoEndDate) : undefined}
          />
        )}
      </div>

      {/* CTA or renewal info */}
      <div className="mt-5">
        {view === "new" && <YellowCta label="Get started" />}
        {view === "admin" && !isCurrent && <YellowCta label="Upgrade to Business" />}
        {view === "member" && !isCurrent && (
          <div className="group relative">
            <button
              type="button"
              disabled
              className="h-10 w-full cursor-not-allowed rounded-[12px] bg-[#FEED01] text-[13px] font-semibold text-[#040404] opacity-30"
            >
              Upgrade to Business
            </button>
            <div className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2.5 py-1.5 text-[11px] text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
              Only admins can upgrade
              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 border-4 border-transparent border-t-foreground" />
            </div>
          </div>
        )}
        {view !== "new" && isCurrent && (
          <div className="flex h-10 w-full items-center justify-center gap-2 rounded-[12px] border border-[#C8B832]/30 bg-[#C8B832]/5 text-[13px] text-muted-foreground dark:border-[#FEED01]/15 dark:bg-[#FEED01]/[0.02]">
            <CalendarCheckIcon weight="fill" className="h-4 w-4 text-[#C8B832] dark:text-[#E8D44D]" />
            Renews {renewalDate}
          </div>
        )}
      </div>

      {/* Features */}
      <div className="mt-auto space-y-2.5 pt-5">
        {BUSINESS_FEATURES.map((f) => (
          <FeatureItem key={f} text={f} />
        ))}
      </div>
    </div>
  );
}

/* ─── Shared plan card parts ─── */

function CreditTierSelect({
  tiers,
  selectedIndex,
  onSelect,
  promoDaysLeft,
}: {
  tiers: CreditTier[];
  selectedIndex: number | null;
  onSelect: (i: number | null) => void;
  promoDaysLeft?: number;
}) {
  const [open, setOpen] = useState(false);
  const selected = selectedIndex != null ? tiers[selectedIndex] : null;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {/* Promo expiring: unlimited chip as trigger */}
      {promoDaysLeft != null && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={`flex w-full cursor-pointer items-center rounded-[14px] border px-4 py-[9px] transition-colors hover:border-[#C8B832] hover:bg-[#C8B832]/10 group-hover/card:border-[#C8B832] group-hover/card:bg-[#C8B832]/10 dark:hover:border-[#FEED01]/30 dark:hover:bg-[#FEED01]/[0.02] dark:group-hover/card:border-[#FEED01]/30 dark:group-hover/card:bg-[#FEED01]/[0.02] ${open ? "border-[#C8B832] bg-[#C8B832]/10 dark:!border-[#FEED01]/30 dark:!bg-[#FEED01]/[0.02]" : "border-border bg-muted"}`}
        >
          <span className="text-[13px] font-medium text-foreground">
            ∞ Unlimited credits for <span className="font-bold text-warning">{promoDaysLeft} days</span>
          </span>
          <CaretDownIcon
            size={12}
            className={`ml-2 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      )}

      {/* Normal trigger */}
      {promoDaysLeft == null && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={`group/trigger flex w-full cursor-pointer items-center gap-2 rounded-[14px] border px-4 py-[9px] transition-colors hover:border-[#C8B832] hover:bg-[#C8B832]/10 group-hover/card:border-[#C8B832] group-hover/card:bg-[#C8B832]/10 dark:hover:border-[#FEED01]/30 dark:hover:bg-[#FEED01]/[0.02] dark:group-hover/card:border-[#FEED01]/30 dark:group-hover/card:bg-[#FEED01]/[0.02] ${open ? "border-[#C8B832] bg-[#C8B832]/10 dark:!border-[#FEED01]/30 dark:!bg-[#FEED01]/[0.02]" : "border-border bg-muted"}`}
        >
          <span className="shrink-0 text-[13px] font-medium text-foreground">
            {selected ? `${selected.credits.toLocaleString()} credits` : "No add-on"}
          </span>
          {selected && (
            <span
              className={`ml-1 text-[13px] font-medium transition-colors group-hover/trigger:text-[#6b6200] group-hover/card:text-[#6b6200] dark:group-hover/trigger:text-[#E8D44D] dark:group-hover/card:text-[#E8D44D] ${open ? "text-[#6b6200] dark:!text-[#E8D44D]" : "text-muted-foreground/60"}`}
            >
              +${selected.price}
            </span>
          )}
          <CaretDownIcon
            size={12}
            className={`ml-auto shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      )}

      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-[14px] border border-border bg-popover shadow-lg">
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            className={`group/row flex w-full items-center justify-between border-b border-border px-4 py-3 text-left transition-colors hover:bg-[#C8B832]/10 dark:hover:bg-[#FEED01]/[0.02] ${selectedIndex == null ? "bg-[#C8B832]/5 dark:bg-[#FEED01]/[0.01]" : ""}`}
          >
            <span className="text-[13px] font-medium text-foreground">No add-on</span>
            <span className="tabular-nums text-[13px] font-medium text-muted-foreground/60">Base plan only</span>
          </button>
          {tiers.map((t, i) => (
            <button
              key={t.credits}
              type="button"
              onClick={() => {
                onSelect(i);
                setOpen(false);
              }}
              className={`group/row flex w-full items-center justify-between border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[#C8B832]/10 dark:hover:bg-[#FEED01]/[0.02] ${selectedIndex === i ? "bg-[#C8B832]/5 dark:bg-[#FEED01]/[0.01]" : ""}`}
            >
              <span className="text-[13px] font-medium text-foreground">
                {t.credits.toLocaleString()} credits monthly
              </span>
              <span className="tabular-nums text-[13px] font-medium text-muted-foreground/60 transition-colors group-hover/row:text-[#6b6200] dark:group-hover/row:text-[#E8D44D]">
                +${t.price}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FeatureItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <CheckIcon size={14} weight="bold" className="mt-0.5 shrink-0 text-foreground" />
      <span className="text-sm text-muted-foreground">{text}</span>
    </div>
  );
}

function YellowCta({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="h-10 w-full rounded-[12px] border-none bg-[#FEED01] text-[13px] font-semibold text-[#040404] transition-all hover:opacity-90 active:scale-[0.98]"
    >
      {label}
    </button>
  );
}

/* ─── Top-up (interactive — admin, healthy credits) ─── */

const TOP_UP_PACKS = [
  { credits: 5000, price: 50 },
  { credits: 10000, price: 96 },
  { credits: 15000, price: 138 },
  { credits: 25000, price: 220 },
  { credits: 50000, price: 420 },
  { credits: 100000, price: 800 },
];
const CREDIT_OPTIONS = TOP_UP_PACKS.map((p) => p.credits);

const TopUpInteractive = forwardRef<HTMLDivElement, object>(function TopUpInteractive(_props, ref) {
  const [stepIndex, setStepIndex] = useState(0);
  const pack = TOP_UP_PACKS[stepIndex];
  const credits = pack.credits;
  const price = pack.price;
  const [creditInput, setCreditInput] = useState(credits.toLocaleString());

  const snapCredits = (raw: string) => {
    const num = Number.parseInt(raw.replace(/,/g, ""), 10) || 0;
    const closest = CREDIT_OPTIONS.reduce((prev, curr) => (Math.abs(curr - num) < Math.abs(prev - num) ? curr : prev));
    const idx = CREDIT_OPTIONS.indexOf(closest);
    setStepIndex(idx);
    setCreditInput(closest.toLocaleString());
  };

  // Keep input in sync when slider changes
  useEffect(() => {
    setCreditInput(credits.toLocaleString());
  }, [credits]);

  return (
    <div id="topup" ref={ref} className="px-6 py-5">
      <div className="flex items-baseline justify-between">
        <p className="text-[15px] font-semibold text-foreground">Top up credits</p>
        <p className="font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground">
          From $0.008/credit · no expiry
        </p>
      </div>
      <div className="mt-3 flex items-center gap-4">
        <div className="relative flex flex-1 items-center">
          <input
            type="range"
            min={0}
            max={CREDIT_OPTIONS.length - 1}
            step={1}
            value={stepIndex}
            onChange={(e) => setStepIndex(Number.parseInt(e.target.value))}
            className="relative z-10 h-1.5 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:z-20 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#FEED01] [&::-webkit-slider-thumb]:bg-[#FEED01] [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.15)] [&::-webkit-slider-thumb]:transition-shadow [&::-webkit-slider-thumb]:hover:shadow-[0_0_0_4px_rgba(254,237,1,0.15)]"
          />
          <div className="pointer-events-none absolute inset-0 flex items-center">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(stepIndex / (CREDIT_OPTIONS.length - 1)) * 100}%`,
                  background: "linear-gradient(to right, #C8B832, #FEED01)",
                }}
              />
            </div>
          </div>
        </div>
        <div className="group/credit flex items-center gap-1 rounded-full border border-border pl-2 pr-2.5 py-1 transition-all hover:border-[#C8B832]/40 hover:bg-[#C8B832]/5 focus-within:border-[#C8B832]/60 focus-within:bg-[#C8B832]/5 active:scale-[0.98]">
          <input
            type="text"
            inputMode="numeric"
            title="Available packs: 5,000 · 10,000 · 15,000 · 25,000 · 50,000 · 100,000"
            value={creditInput}
            onChange={(e) => setCreditInput(e.target.value.replace(/[^\d,]/g, ""))}
            onBlur={() => snapCredits(creditInput)}
            onKeyDown={(e) => {
              if (e.key === "Enter") snapCredits(creditInput);
            }}
            className="min-w-12 w-16 bg-transparent text-center text-sm font-semibold tabular-nums text-foreground outline-none"
          />
          <span className="text-xs text-muted-foreground transition-colors group-hover/credit:text-[#6b6200] dark:group-hover/credit:text-[#E8D44D]">
            credits
          </span>
        </div>
        <span className="min-w-[3.5rem] text-right text-lg font-bold tabular-nums tracking-[-0.5px] text-foreground">
          ${price}
        </span>
        <button
          type="button"
          className="h-9 shrink-0 whitespace-nowrap rounded-[10px] bg-[#FEED01] px-5 text-[13px] font-semibold text-[#040404] transition-opacity hover:opacity-90"
        >
          Buy now
        </button>
      </div>
    </div>
  );
});

/* ─── Referral section ─── */

function ReferralSection() {
  return (
    <div className="mt-8 flex items-center justify-between border-t border-border pt-6">
      <div className="flex items-center gap-3">
        <GiftIcon size={18} className="text-[#C8B832]" />
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">Refer a teammate</h2>
            <span className="rounded-full bg-[#C8B832]/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-[#8B7A1A] dark:text-[#E8D44D]">
              Coming soon
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">Invite others to Sketch and earn credits together.</p>
        </div>
      </div>
      <div title="Coming soon" className="flex items-center gap-0 rounded-full border border-border opacity-50">
        <span className="pl-3 pr-2 text-[13px] text-muted-foreground">sketch.dev/refer/you</span>
        <button type="button" disabled className="shrink-0 rounded-full p-2 transition-colors">
          <CopySimpleIcon size={14} className="text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
