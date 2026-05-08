import { api } from "@/lib/api";
import { type NavItem, getDashboardNav } from "@/lib/dashboard-nav";
/**
 * App sidebar — navigation, branding, and user actions.
 * Follows the designer's sidebar structure with Phosphor icons.
 */
import {
  ArrowRightIcon,
  ArrowSquareOutIcon,
  CaretUpDownIcon,
  DesktopIcon,
  GearIcon,
  LinkSimpleIcon,
  MoonIcon,
  SignOutIcon,
  SunIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@sketch/ui/components/sidebar";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { getInitials } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const experimentalNavLabels = new Set(["Files"]);

const allPrimaryNav: NavItem[] = getDashboardNav(18);

const adminNav: NavItem[] = [
  { label: "Integrations", icon: <LinkSimpleIcon size={18} />, href: "/integrations" },
  { label: "Settings", icon: <GearIcon size={18} />, href: "/settings", disabled: true },
];

export function AppSidebar({
  displayName,
  displayIdentifier,
  role,
}: {
  displayName: string;
  displayIdentifier: string;
  role: "admin" | "member";
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, resolvedTheme, setTheme, logoSrc } = useTheme();
  const queryClient = useQueryClient();

  const { data: identity } = useQuery({
    queryKey: ["settings", "identity"],
    queryFn: () => api.settings.identity(),
  });

  const { data: setupStatus } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api.setup.status(),
  });

  const primaryNav = setupStatus?.experimentalFlag
    ? allPrimaryNav
    : allPrimaryNav.filter((item) => !experimentalNavLabels.has(item.label));

  const logoutMutation = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => {
      queryClient.clear();
      navigate({ to: "/login" });
    },
  });

  const initials = getInitials(displayIdentifier);

  return (
    <Sidebar collapsible="icon" data-walkthrough-target="sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none hover:bg-transparent active:bg-transparent">
              <div className="flex size-9 shrink-0 items-center justify-center">
                <img src={logoSrc} alt="Sketch" className="size-9 dark:invert" />
              </div>
              <div className="flex min-w-0 flex-col text-left">
                <span className="truncate text-base font-semibold tracking-tight">{identity?.botName ?? "Sketch"}</span>
                {identity?.orgName ? (
                  <span className="truncate text-xs text-muted-foreground">{identity.orgName}</span>
                ) : null}
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {primaryNav.map((item) => (
                <SidebarMenuItem
                  key={item.href}
                  data-walkthrough-target={item.href === "/skills" ? "sidebar-skills" : undefined}
                >
                  <SidebarMenuButton
                    isActive={location.pathname === item.href}
                    onClick={() => !item.disabled && navigate({ to: item.href })}
                    disabled={item.disabled}
                    tooltip={item.label}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {setupStatus?.managedUrl ? (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Account">
                    <a href={setupStatus.managedUrl} target="_blank" rel="noopener noreferrer">
                      <ArrowSquareOutIcon size={18} />
                      <span>Account</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SetupStepper />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-12 w-full items-center gap-2 overflow-hidden rounded-md text-left text-sm outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground"
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
                {initials}
              </div>
              <div className="flex min-w-0 flex-1 flex-col text-left text-xs leading-tight">
                <span className="truncate font-medium">{displayName}</span>
                <span className="truncate text-muted-foreground">{displayIdentifier}</span>
              </div>
              <CaretUpDownIcon size={16} className="shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {resolvedTheme === "dark" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as "dark" | "light" | "system")}>
                  <DropdownMenuRadioItem value="light">
                    <SunIcon size={16} /> Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <MoonIcon size={16} /> Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <DesktopIcon size={16} /> System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logoutMutation.mutate()}>
              <SignOutIcon size={16} className="mr-2" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

// ── Setup stepper ─────────────────────────────────────────────────────────────

const SETUP_STEPPER_DISMISSED_KEY = "sketch.setupStepper.dismissed";

interface StepperEntry {
  key: "inviteTeammate" | "integration" | "firstSkill" | "scheduledTask";
  label: string;
  href: "/team" | "/integrations" | "/skills" | "/scheduled-tasks";
}

const STEPPER_STEPS: StepperEntry[] = [
  { key: "inviteTeammate", label: "Invite a teammate", href: "/team" },
  { key: "integration", label: "Connect an integration", href: "/integrations" },
  { key: "firstSkill", label: "Create or import a skill", href: "/skills" },
  { key: "scheduledTask", label: "Schedule a task", href: "/scheduled-tasks" },
];

/**
 * Compact 4-step setup card. Lives at the bottom of the sidebar, above the user
 * profile, and disappears once setup is complete (one-way flag in localStorage —
 * removing items later won't bring it back).
 *
 * Hidden when the sidebar is collapsed to icon mode, since the card needs
 * horizontal space to be useful.
 */
function SetupStepper() {
  const { state } = useSidebar();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SETUP_STEPPER_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Each step reads the live data source that determines completion. React Query
  // dedupes these against the same calls used by /team, /integrations, etc.
  const usersQuery = useQuery({
    queryKey: ["users", "list"],
    queryFn: () => api.users.list(),
  });
  const integrationsQuery = useQuery({
    queryKey: ["integrations", "list"],
    queryFn: () => api.integrations.list(),
  });
  const skillsQuery = useQuery({
    queryKey: ["skills", "list"],
    queryFn: () => api.skills.list(),
  });
  const tasksQuery = useQuery({
    queryKey: ["scheduledTasks", "list"],
    queryFn: () => api.scheduledTasks.list(),
  });

  const stepDone: Record<StepperEntry["key"], boolean> = {
    inviteTeammate: (usersQuery.data?.users.length ?? 0) > 1,
    integration: (integrationsQuery.data?.connectors.length ?? 0) > 0,
    firstSkill: (skillsQuery.data?.skills.length ?? 0) > 0,
    scheduledTask: (tasksQuery.data?.length ?? 0) > 0,
  };

  const completedCount = Object.values(stepDone).filter(Boolean).length;
  const total = STEPPER_STEPS.length;
  const isComplete = completedCount === total;

  // Persist dismissal once setup hits 4/4 — one-way flag so removing items later
  // doesn't resurrect the card.
  useEffect(() => {
    if (!isComplete || dismissed) return;
    try {
      window.localStorage.setItem(SETUP_STEPPER_DISMISSED_KEY, "1");
    } catch {
      // localStorage unavailable; render-time `isComplete` check still hides the card.
    }
    setDismissed(true);
  }, [isComplete, dismissed]);

  if (state === "collapsed") return null;
  if (dismissed || isComplete) return null;
  // Don't render until at least one query has resolved — prevents the stepper
  // from briefly showing "0/4" while data loads.
  const allLoaded =
    usersQuery.isFetched && integrationsQuery.isFetched && skillsQuery.isFetched && tasksQuery.isFetched;
  if (!allLoaded) return null;

  const next = STEPPER_STEPS.find((step) => !stepDone[step.key]);
  if (!next) return null;

  const progressPct = (completedCount / total) * 100;

  return (
    <Link
      to={next.href}
      className="block rounded-md border border-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-medium text-foreground">Setting up Sketch</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {completedCount}/{total}
        </span>
      </div>
      <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-[#FEED01] transition-all" style={{ width: `${progressPct}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[10.5px] text-muted-foreground">{next.label}</span>
        <ArrowRightIcon size={11} className="shrink-0 text-muted-foreground" />
      </div>
    </Link>
  );
}
