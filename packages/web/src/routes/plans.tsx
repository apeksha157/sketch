import { AppSidebar } from "@/components/app-sidebar";
import { useDashboardAuth } from "@/routes/dashboard";
import { CaretDownIcon, CheckIcon, GiftIcon, MinusIcon, PlusIcon, UsersIcon, WarningIcon } from "@phosphor-icons/react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@sketch/ui/components/sidebar";
import { createRoute } from "@tanstack/react-router";
import { forwardRef, useEffect, useRef, useState } from "react";
import { dashboardRoute } from "./dashboard";
import { rootRoute } from "./root";

export const plansRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/plans",
  component: function PlansPage() {
    const auth = useDashboardAuth();
    return <PlansPageContent userRole={auth.role} />;
  },
});

function PreviewShell({
  view,
  lowCredit,
  plan = "team",
}: { view: PricingView; lowCredit: boolean; plan?: "team" | "business" | null }) {
  return (
    <SidebarProvider>
      {/* biome-ignore lint/a11y/useValidAriaRole: role is a component prop, not an ARIA attribute */}
      <AppSidebar displayName="Admin" displayIdentifier="admin@sketch.dev" role="admin" />
      <SidebarInset>
        <SidebarTrigger className="absolute left-3 top-3 z-20" />
        <main className="flex-1 overflow-auto pt-[52px]">
          <PlansPageContent viewOverride={view} lowCreditOverride={lowCredit} planOverride={plan} />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

// New user — no plan
export const plansNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/new",
  component: () => <PreviewShell view="new" lowCredit={false} plan={null} />,
});

// Team plan — member
export const plansMemberTeamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/member-team",
  component: () => <PreviewShell view="member" lowCredit={false} plan="team" />,
});

// Team plan — member, low credit
export const plansMemberTeamLowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/member-team-low",
  component: () => <PreviewShell view="member" lowCredit={true} plan="team" />,
});

// Team plan — admin
export const plansAdminTeamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/admin-team",
  component: () => <PreviewShell view="admin" lowCredit={false} plan="team" />,
});

// Team plan — admin, low credit
export const plansAdminTeamLowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/admin-team-low",
  component: () => <PreviewShell view="admin" lowCredit={true} plan="team" />,
});

// Business plan — member
export const plansMemberBizRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/member-biz",
  component: () => <PreviewShell view="member" lowCredit={false} plan="business" />,
});

// Business plan — member, low credit
export const plansMemberBizLowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/member-biz-low",
  component: () => <PreviewShell view="member" lowCredit={true} plan="business" />,
});

// Business plan — admin
export const plansAdminBizRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/admin-biz",
  component: () => <PreviewShell view="admin" lowCredit={false} plan="business" />,
});

// Business plan — admin, low credit
export const plansAdminBizLowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans/admin-biz-low",
  component: () => <PreviewShell view="admin" lowCredit={true} plan="business" />,
});

/* ─── Types & mock data ─── */

type PricingView = "new" | "member" | "admin";

const MOCK_WORKSPACE = {
  plan: "team" as "team" | "business" | null,
  credits: { total: 5000, remaining: 3100, used: 1900 },
  renewalDate: "May 1, 2026",
  members: 8,
};

const MOCK_WORKSPACE_LOW = {
  plan: "team" as "team" | "business" | null,
  credits: { total: 5000, remaining: 800, used: 4200 },
  renewalDate: "May 1, 2026",
  members: 8,
};

const MOCK_WORKSPACE_BIZ = {
  plan: "business" as "team" | "business" | null,
  credits: { total: 15000, remaining: 9200, used: 5800 },
  renewalDate: "May 1, 2026",
  members: 22,
};

const MOCK_WORKSPACE_BIZ_LOW = {
  plan: "business" as "team" | "business" | null,
  credits: { total: 15000, remaining: 2400, used: 12600 },
  renewalDate: "May 1, 2026",
  members: 22,
};

const DAYS_ELAPSED = 17;
const DAYS_UNTIL_RENEWAL = 14;

interface CreditTier {
  credits: number;
  price: number;
}

const TEAM_TIERS: CreditTier[] = [
  { credits: 5000, price: 50 },
  { credits: 10000, price: 90 },
  { credits: 20000, price: 160 },
];

const BUSINESS_TIERS: CreditTier[] = [
  { credits: 15000, price: 150 },
  { credits: 30000, price: 270 },
  { credits: 50000, price: 400 },
  { credits: 100000, price: 700 },
];

const TEAM_FEATURES = [
  "Slack, WhatsApp & Email",
  "3,000+ integrations",
  "Unlimited scheduled tasks & workflows",
  "Email support",
];

const BUSINESS_FEATURES = ["Up to 50 members (2.5×)", "15,000 credits per month", "Priority email support"];

const USAGE_ITEMS = [
  { label: "AI question (quick)", range: "20–50", barWidth: "17%" },
  { label: "AI task (report, analysis)", range: "100–300", barWidth: "55%" },
  { label: "Integration action", range: "5–15", barWidth: "6%" },
  { label: "Scheduled task run", range: "10–50", barWidth: "14%" },
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
}: {
  userRole?: "admin" | "member";
  viewOverride?: PricingView;
  lowCreditOverride?: boolean;
  planOverride?: "team" | "business" | null;
}) {
  const topUpRef = useRef<HTMLDivElement>(null);

  const plan = planOverride ?? "team";
  const useLowCredit = lowCreditOverride ?? false;
  const isBiz = plan === "business";
  const workspace = isBiz
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
  const isLowCredit = creditPct <= 0.2;
  const suggestedTopUp = getSuggestedTopUp(dailyBurnRate, workspace.credits.remaining);

  const scrollToTopUp = () => topUpRef.current?.scrollIntoView({ behavior: "smooth" });

  return (
    <div className="mx-auto max-w-4xl px-10 py-8 pb-20">
      {/* Page header */}
      <h1 className="text-2xl font-bold text-foreground">Plans & pricing</h1>
      <p className="mt-1 text-sm text-muted-foreground">Manage your workspace plan and credit usage.</p>

      {/* Credit overview — member & admin */}
      {view !== "new" && (
        <CreditOverview
          workspace={workspace}
          dailyBurnRate={dailyBurnRate}
          daysRemaining={daysRemaining}
          creditPct={creditPct}
          isLowCredit={isLowCredit}
          isAdmin={view === "admin"}
          onBuyCredits={scrollToTopUp}
        />
      )}

      {/* Nudge banner — admin + low credit */}
      {view === "admin" && isLowCredit && <NudgeBanner daysRemaining={daysRemaining} suggestedTopUp={suggestedTopUp} />}

      {/* Plan cards */}
      <PlanCards view={view} currentPlan={workspace.plan} />

      {/* Top-up section */}
      {view === "new" && <TopUpStatic />}
      {view === "admin" && (
        <TopUpInteractive
          ref={topUpRef}
          isLowCredit={isLowCredit}
          creditPct={creditPct}
          suggestedTopUp={suggestedTopUp}
        />
      )}

      {/* What uses credits */}
      <WhatUsesCredits />

      {/* Referral */}
      <ReferralSection />
    </div>
  );
}

/* ─── Credit overview stats ─── */

function CreditOverview({
  workspace,
  dailyBurnRate,
  daysRemaining,
  creditPct,
  isLowCredit,
  isAdmin,
  onBuyCredits,
}: {
  workspace: typeof MOCK_WORKSPACE;
  dailyBurnRate: number;
  daysRemaining: number;
  creditPct: number;
  isLowCredit: boolean;
  isAdmin: boolean;
  onBuyCredits: () => void;
}) {
  const warn = isLowCredit;
  const cardBase = warn
    ? "flex flex-col rounded-lg border border-[#FDE68A] bg-[#FEF3C7] px-4 py-3.5 dark:border-white/[0.08] dark:bg-[#1D1B04]"
    : "flex flex-col rounded-lg border border-border bg-card px-4 py-3.5";
  const labelCls = warn
    ? "font-mono text-[10px] font-medium uppercase tracking-[.08em] text-warning"
    : "font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground";
  const numCls = warn
    ? "mt-2 text-2xl font-bold leading-none tracking-tight text-warning"
    : "mt-2 text-2xl font-bold leading-none tracking-tight text-foreground";
  const subCls = warn ? "mt-1 text-[11px] text-warning/70" : "mt-1 text-[11px] text-muted-foreground";

  return (
    <div className="mt-6 grid grid-cols-3 gap-2.5">
      {/* Credits remaining */}
      <div className={cardBase}>
        <p className={labelCls}>Credits remaining</p>
        <p className={numCls}>{workspace.credits.remaining.toLocaleString()}</p>
        <p className={subCls}>of {workspace.credits.total.toLocaleString()} this month</p>
        <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-muted dark:bg-border">
          <div
            className={`h-full rounded-full transition-all duration-400 ${warn ? "bg-warning" : "bg-foreground"}`}
            style={{ width: `${Math.max(creditPct * 100, 2)}%` }}
          />
        </div>
      </div>

      {/* Daily burn rate */}
      <div className={cardBase}>
        <p className={labelCls}>Daily burn rate</p>
        <p className={numCls}>{dailyBurnRate}</p>
        <p className={subCls}>credits per day avg.</p>
      </div>

      {/* Days remaining */}
      <div className={cardBase}>
        <p className={labelCls}>Days remaining</p>
        <p className={numCls}>{daysRemaining}</p>
        <p className={subCls}>at current pace · resets {workspace.renewalDate}</p>
        {isAdmin && (
          <button
            type="button"
            onClick={onBuyCredits}
            className={`mt-3 h-8 w-full rounded-md text-[12px] font-medium transition-opacity hover:opacity-90 ${
              warn ? "bg-warning text-white" : "bg-foreground text-background"
            }`}
          >
            Buy credits
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Nudge banner ─── */

function NudgeBanner({
  daysRemaining,
  suggestedTopUp,
}: {
  daysRemaining: number;
  suggestedTopUp: number;
}) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-[10px] border border-[#FDE68A] bg-[#FEF3C7] px-4 py-3 dark:border-white/[0.08] dark:bg-[#1D1B04]">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#FDE68A] dark:bg-[rgba(251,146,60,0.15)]">
        <WarningIcon size={13} weight="fill" className="text-warning" />
      </div>
      <div>
        <p className="text-[13px] font-semibold text-warning">
          Running low — {daysRemaining} day{daysRemaining !== 1 ? "s" : ""} left at current pace
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Top up {suggestedTopUp.toLocaleString()} credits to last the month, or upgrade to Business for 15,000 monthly
          credits.
        </p>
      </div>
    </div>
  );
}

/* ─── Plan cards ─── */

function PlanCards({ view, currentPlan }: { view: PricingView; currentPlan: string | null }) {
  return (
    <div className="mt-8 grid grid-cols-2 gap-3">
      <TeamCard view={view} isCurrent={currentPlan === "team"} />
      <BusinessCard view={view} isCurrent={currentPlan === "business"} />
    </div>
  );
}

function TeamCard({ view, isCurrent }: { view: PricingView; isCurrent: boolean }) {
  const showBadge = isCurrent && view !== "new";
  const [selectedTier, setSelectedTier] = useState(0);
  const tier = TEAM_TIERS[selectedTier];

  return (
    <div className="flex flex-col rounded-[10px] border border-border bg-card p-[22px]">
      {/* Row 1: Badge — fixed 24px height */}
      <div className="h-3">{showBadge && <CurrentPlanBadge />}</div>

      {/* Row 2: Name + tagline */}
      <h3 className="mt-1 text-base font-semibold text-foreground">Team</h3>
      <div className="mt-0.5 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">For small teams getting started.</p>
        <span className="flex items-center gap-1 text-muted-foreground">
          <UsersIcon size={12} />
          <span className="font-mono text-[11px]">20</span>
        </span>
      </div>

      {/* Row 3: Price */}
      <div className="mt-5 flex items-baseline gap-1">
        <span className="text-[42px] font-bold leading-none tracking-[-2px] text-foreground">${tier.price}</span>
        <span className="text-[13px] text-muted-foreground">/ month</span>
      </div>

      {/* Row 4: Credit selector */}
      <div className="mt-4">
        <CreditTierSelect tiers={TEAM_TIERS} selectedIndex={selectedTier} onSelect={setSelectedTier} variant="light" />
      </div>

      {/* Row 5: CTA */}
      <div className="mt-4">
        {view === "new" && (
          <button
            type="button"
            className="h-10 w-full rounded-[6px] border border-border bg-transparent text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
          >
            Get started
          </button>
        )}
        {view !== "new" && isCurrent && (
          <>
            <button
              type="button"
              disabled
              className="h-10 w-full cursor-default rounded-[6px] border border-border bg-muted text-[13px] font-medium text-muted-foreground"
            >
              Current plan
            </button>
            {view === "admin" && (
              <button
                type="button"
                className="mt-2 block w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-secondary-foreground"
              >
                Downgrade options
              </button>
            )}
          </>
        )}
      </div>

      {/* Row 6: Features */}
      <div className="mt-5">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground">Includes</p>
        <div className="mt-3 space-y-3">
          {TEAM_FEATURES.map((f) => (
            <FeatureItem key={f} text={f} />
          ))}
        </div>
      </div>
    </div>
  );
}

function BusinessCard({ view, isCurrent }: { view: PricingView; isCurrent: boolean }) {
  const showBadge = isCurrent && view !== "new";
  const [selectedTier, setSelectedTier] = useState(0);
  const tier = BUSINESS_TIERS[selectedTier];

  return (
    <div className="relative flex flex-col overflow-hidden rounded-[10px] bg-[#040404] p-[22px] dark:bg-popover">
      {/* Row 1: Badge — fixed 24px height */}
      <div className="h-3">
        {!showBadge && (
          <div className="absolute left-1/2 top-0 -translate-x-1/2 rounded-b-[6px] bg-[#FEED01] px-3.5 py-[3px] font-mono text-[10px] font-bold uppercase tracking-[.09em] text-[#040404]">
            Most popular
          </div>
        )}
        {showBadge && <CurrentPlanBadge />}
      </div>

      {/* Row 2: Name + tagline */}
      <h3 className="mt-1 text-base font-semibold text-[#FAFAF8] dark:text-foreground">Business</h3>
      <div className="mt-0.5 flex items-center justify-between">
        <p className="text-xs text-[#9C9A92] dark:text-muted-foreground">For teams that need serious scale.</p>
        <span className="flex items-center gap-1 text-[#9C9A92] dark:text-muted-foreground">
          <UsersIcon size={12} />
          <span className="font-mono text-[11px]">50</span>
        </span>
      </div>

      {/* Row 3: Price */}
      <div className="mt-5 flex items-baseline gap-1">
        <span className="text-[42px] font-bold leading-none tracking-[-2px] text-[#FAFAF8] dark:text-foreground">
          ${tier.price}
        </span>
        <span className="text-[13px] text-[#9C9A92] dark:text-muted-foreground">/ month</span>
      </div>

      {/* Row 4: Credit selector */}
      <div className="mt-4">
        <CreditTierSelect
          tiers={BUSINESS_TIERS}
          selectedIndex={selectedTier}
          onSelect={setSelectedTier}
          variant="dark"
        />
      </div>

      {/* Row 5: CTA */}
      <div className="mt-4">
        {view === "new" && <YellowCta label="Get started" />}
        {view === "admin" && !isCurrent && <YellowCta label="Upgrade to Business" />}
        {view === "member" && !isCurrent && (
          <div className="group relative">
            <button
              type="button"
              disabled
              className="h-10 w-full cursor-not-allowed rounded-[6px] bg-[#FEED01] text-[13px] font-semibold text-[#040404] opacity-30"
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
          <>
            <button
              type="button"
              disabled
              className="h-10 w-full cursor-default rounded-[6px] border border-[#2C2C2A] bg-[#111110] text-[13px] font-medium text-[#5F5E5A] dark:border-white/[0.08] dark:bg-[#2C2C2A] dark:text-muted-foreground"
            >
              Current plan
            </button>
            {view === "admin" && (
              <button
                type="button"
                className="mt-2 block w-full text-center text-xs text-[#5F5E5A] underline underline-offset-2 hover:text-[#9C9A92] dark:text-muted-foreground dark:hover:text-secondary-foreground"
              >
                Downgrade options
              </button>
            )}
          </>
        )}
      </div>

      {/* Row 6: Features */}
      <div className="mt-5">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[.08em] text-[#5F5E5A] dark:text-muted-foreground">
          Everything in Team, plus
        </p>
        <div className="mt-3 space-y-3">
          {BUSINESS_FEATURES.map((f) => (
            <div key={f} className="flex items-start gap-2">
              <CheckIcon size={14} weight="bold" className="mt-0.5 shrink-0 text-[#FEED01]" />
              <span className="text-sm text-[#9C9A92] dark:text-muted-foreground">{f}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Shared plan card parts ─── */

function CurrentPlanBadge() {
  return (
    <span className="inline-flex items-center gap-[5px] rounded-full bg-[#F0FDF4] px-2 py-0.5 dark:bg-[rgba(48,209,88,0.1)]">
      <span className="size-[7px] rounded-full bg-success" />
      <span className="font-mono text-[10px] font-semibold uppercase text-success">Current plan</span>
    </span>
  );
}

function CreditTierSelect({
  tiers,
  selectedIndex,
  onSelect,
  variant,
}: {
  tiers: CreditTier[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  variant: "light" | "dark";
}) {
  const [open, setOpen] = useState(false);
  const selected = tiers[selectedIndex];
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const isDark = variant === "dark";
  const triggerClass = isDark
    ? "flex w-full cursor-pointer items-center gap-2 rounded-[6px] border border-[#2C2C2A] bg-[#111110] px-3 py-[7px] transition-colors hover:border-[#3D3530] dark:border-white/[0.08] dark:bg-[#2C2C2A] dark:hover:border-white/[0.15]"
    : "flex w-full cursor-pointer items-center gap-2 rounded-[6px] border border-border bg-muted px-3 py-[7px] transition-colors hover:border-foreground/20";
  const labelClass = isDark
    ? "shrink-0 text-[13px] font-medium text-[#FAFAF8] dark:text-foreground"
    : "shrink-0 text-[13px] font-medium text-foreground";
  const subClass = isDark
    ? "text-[11px] text-[#5F5E5A] dark:text-muted-foreground"
    : "text-[11px] text-muted-foreground";
  const caretClass = isDark ? "text-[#5F5E5A] dark:text-muted-foreground" : "text-muted-foreground";
  const dropdownClass = isDark
    ? "absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-[6px] border border-[#2C2C2A] bg-[#111110] shadow-lg dark:border-white/[0.08] dark:bg-[#2C2C2A]"
    : "absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-[6px] border border-border bg-card shadow-lg";

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className={triggerClass}>
        <span className={labelClass}>{selected.credits.toLocaleString()} credits</span>
        <span className={`ml-auto ${subClass}`}>per month</span>
        <CaretDownIcon
          size={12}
          className={`shrink-0 transition-transform ${caretClass} ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className={dropdownClass}>
          {tiers.map((t, i) => {
            const isSelected = i === selectedIndex;
            const itemHover = isDark ? "hover:bg-[#1C1C1A] dark:hover:bg-white/[0.05]" : "hover:bg-accent";
            const accentBar = isDark ? "border-l-[#FEED01]" : "border-l-foreground";
            const selectedLabel = isDark
              ? "shrink-0 text-[13px] font-medium text-[#FEED01]"
              : "shrink-0 text-[13px] font-medium text-foreground";
            const selectedPrice = isDark ? "text-[11px] text-[#FEED01]/70" : "text-[11px] text-foreground/70";
            return (
              <button
                key={t.credits}
                type="button"
                onClick={() => {
                  onSelect(i);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 border-l-2 px-3 py-2.5 text-left transition-colors ${
                  isSelected ? accentBar : "border-l-transparent"
                } ${itemHover}`}
              >
                <span className={isSelected ? selectedLabel : labelClass}>
                  {t.credits.toLocaleString()} credits/month
                </span>
                <span className={`ml-auto tabular-nums ${isSelected ? selectedPrice : subClass}`}>${t.price}/mo</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FeatureItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <CheckIcon size={14} weight="bold" className="mt-0.5 shrink-0 text-foreground" />
      <span className="text-sm text-secondary-foreground">{text}</span>
    </div>
  );
}

function YellowCta({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="h-10 w-full rounded-[6px] border-none bg-[#FEED01] text-[13px] font-semibold text-[#040404] transition-opacity hover:opacity-90"
    >
      {label}
    </button>
  );
}

/* ─── Top-up (static — View A) ─── */

function TopUpStatic() {
  return (
    <div className="mt-6 flex items-start justify-between rounded-lg border border-border bg-card px-5 py-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">Need more credits?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Top up any time. Credits never expire and require no plan change.
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-3xl font-bold tracking-[-1px] text-foreground">$15</p>
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">per 1,000 credits</p>
      </div>
    </div>
  );
}

/* ─── Top-up (interactive — View C) ─── */

const TopUpInteractive = forwardRef<
  HTMLDivElement,
  { isLowCredit: boolean; creditPct: number; suggestedTopUp: number }
>(function TopUpInteractive({ isLowCredit, creditPct, suggestedTopUp }, ref) {
  const [qty, setQty] = useState(1);
  const clamp = (n: number) => Math.max(1, Math.min(100, n));

  return (
    <div id="topup" ref={ref} className="mt-8 rounded-[10px] border border-border bg-card px-5 py-[18px]">
      {/* Header row */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Top up credits</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            No expiry. No plan change. Added to your balance immediately.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-2xl font-bold tracking-[-0.3px] text-foreground">$15</p>
          <p className="font-mono text-[11px] text-muted-foreground">per 1,000 credits</p>
        </div>
      </div>

      {/* Divider */}
      <div className="mt-3.5 border-t border-border" />

      {/* Input row */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
        {/* Qty control */}
        <div className="flex items-center overflow-hidden rounded-[6px] border border-border">
          <button
            type="button"
            onClick={() => setQty((q) => clamp(q - 1))}
            className="flex size-[34px] items-center justify-center text-lg text-muted-foreground transition-colors hover:bg-accent"
          >
            <MinusIcon size={14} />
          </button>
          <span className="h-[34px] w-px bg-border" />
          <input
            type="number"
            min={1}
            max={100}
            value={qty}
            onChange={(e) => setQty(clamp(Number.parseInt(e.target.value) || 1))}
            className="w-[54px] bg-transparent py-2 text-center text-sm font-semibold text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="h-[34px] w-px bg-border" />
          <button
            type="button"
            onClick={() => setQty((q) => clamp(q + 1))}
            className="flex size-[34px] items-center justify-center text-lg text-muted-foreground transition-colors hover:bg-accent"
          >
            <PlusIcon size={14} />
          </button>
        </div>

        {/* Summary */}
        <span className="text-[13px] text-muted-foreground">
          × 1,000 = <span className="font-semibold text-foreground">{(qty * 1000).toLocaleString()} credits</span>
        </span>

        {/* Price */}
        <span className="ml-auto text-base font-bold tracking-[-0.3px] text-foreground">${qty * 15}</span>

        {/* Buy now */}
        <button
          type="button"
          className="h-9 whitespace-nowrap rounded-[6px] bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-[.86]"
        >
          Buy now
        </button>
      </div>

      {/* Hint when low */}
      {creditPct <= 0.3 && (
        <p className="mt-2 text-[11px] text-warning">
          Tip: {suggestedTopUp.toLocaleString()} credits would cover the rest of the month.
        </p>
      )}
    </div>
  );
});

/* ─── What uses credits ─── */

function WhatUsesCredits() {
  return (
    <div className="mt-6 rounded-lg border border-border bg-card px-5 py-5">
      <p className="font-mono text-[10px] font-medium uppercase tracking-[.08em] text-muted-foreground">
        What uses credits
      </p>
      <div className="mt-3 grid grid-cols-2 gap-x-8">
        {USAGE_ITEMS.map((item, i) => (
          <div
            key={item.label}
            className={`flex items-center justify-between py-2.5 ${
              i < USAGE_ITEMS.length - 2 ? "border-b border-border" : ""
            }`}
          >
            <span className="text-sm text-muted-foreground">{item.label}</span>
            <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">
              {item.range} <span className="font-normal text-muted-foreground">cr</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Referral section ─── */

function ReferralSection() {
  return (
    <div className="mt-6 flex items-center justify-between rounded-lg border border-border bg-card px-5 py-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <GiftIcon size={18} className="text-muted-foreground" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">Refer a teammate</h2>
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-muted-foreground">
              Coming soon
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">Invite others to Sketch and earn credits together.</p>
        </div>
      </div>
      <button
        type="button"
        disabled
        className="h-10 shrink-0 whitespace-nowrap rounded-[6px] border border-border bg-transparent px-4 text-[13px] font-medium text-foreground opacity-40"
      >
        Copy link
      </button>
    </div>
  );
}
