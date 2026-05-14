/**
 * Sketch v1 sidebar — §4.1 of the design spec.
 *
 * Width 212px expanded, 52px collapsed. Anchored full-height of the viewport.
 * Holds the brand row, search trigger, primary nav, secondary nav, credits card
 * (when setup is complete), and profile chip.
 *
 * Active-route logic: Home is active across /home/*, /chat/*, and /conversations
 * — they're all conceptually parts of the same chat surface.
 */
import { CreditsCard, type CreditsCardProps } from "@/components/sketch/credits-card";
import {
  CalendarTimeIcon,
  ChannelsIcon,
  FilesIcon,
  HomeIcon,
  type IconProps,
  PuzzleIcon,
  SearchIcon,
  SparklesIcon,
  UsersIcon,
} from "@/components/sketch/icons";
import { ProfileChip, type ProfileChipProps } from "@/components/sketch/profile-chip";
import { useSidebarState } from "@/components/sketch/sidebar-context";
import { NavBadge, RunningPulse } from "@/components/sketch/status-indicators";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { cn } from "@sketch/ui/lib/utils";
import { Link, useLocation } from "@tanstack/react-router";
import { type ComponentType, type KeyboardEvent, useCallback } from "react";

interface SidebarNavBadge {
  count: number;
}

interface NavItemDef {
  label: string;
  href: string;
  icon: ComponentType<IconProps>;
  badge?: SidebarNavBadge;
  pulse?: boolean;
}

const MIDDLE_NAV: NavItemDef[] = [
  { label: "Channels", icon: ChannelsIcon, href: "/channels" },
  { label: "Integrations", icon: PuzzleIcon, href: "/integrations" },
  { label: "Skills", icon: SparklesIcon, href: "/skills" },
  { label: "Scheduled tasks", icon: CalendarTimeIcon, href: "/scheduled-tasks" },
];

const BOTTOM_NAV: NavItemDef[] = [
  { label: "Team", icon: UsersIcon, href: "/team" },
  { label: "Files", icon: FilesIcon, href: "/files" },
];

export interface SketchSidebarProps {
  profile: ProfileChipProps;
  /** Workspace / org name shown under "Sketch" in the brand row. */
  orgName: string;
  /**
   * Per-nav-item attention state. Keyed by href so callers can spell the
   * mapping out declaratively without juggling positional arrays.
   */
  navState?: Record<string, { badgeCount?: number; pulse?: boolean }>;
  /** When provided, renders the credits card between Files and the profile chip. */
  credits?: CreditsCardProps;
  /** When true, the credits card slot is replaced with a "Account paused" line (§5.7). */
  paused?: boolean;
  /** Triggered when the user clicks the search affordance or presses ⌘K. */
  onOpenSearchPalette?: () => void;
}

export function SketchSidebar({
  profile,
  orgName,
  navState,
  credits,
  paused,
  onOpenSearchPalette,
}: SketchSidebarProps) {
  const { collapsed, toggle } = useSidebarState();
  const location = useLocation();
  const pathname = location.pathname;

  /**
   * Home is the canonical chat surface. The spec (§4.1) says it's active across
   * /home/*, /chat/*, and /conversations — that's why this isn't a simple equality.
   */
  const homeActive =
    pathname === "/home" ||
    pathname.startsWith("/home/") ||
    pathname.startsWith("/chat/") ||
    pathname === "/conversations";

  const middleNav = applyNavState(MIDDLE_NAV, navState);
  const bottomNav = applyNavState(BOTTOM_NAV, navState);

  const handleSearchKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpenSearchPalette?.();
      }
    },
    [onOpenSearchPalette],
  );

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "flex h-screen flex-col bg-sidebar border-r border-border",
        collapsed ? "w-[52px] py-[14px] px-0" : "w-[256px] px-[12px] py-[14px]",
        "shrink-0 select-none",
      )}
    >
      {/* Brand row — Sketch logo + product/org stack + collapse toggle */}
      <BrandRow collapsed={collapsed} onToggle={toggle} orgName={orgName} />

      {/* Search trigger */}
      <SearchTrigger collapsed={collapsed} onClick={onOpenSearchPalette} onKeyDown={handleSearchKey} />

      {/* Primary nav — Home + middle group rendered as one cohesive list. The
       * spec separated Home from the others; the existing dashboard reads
       * better as a single nav, so we tighten the gap to match. */}
      <div className="flex flex-col gap-px">
        <NavItem item={{ label: "Home", icon: HomeIcon, href: "/home/default" }} isActive={homeActive} />
        {middleNav.map((item) => (
          <NavItem key={item.href} item={item} isActive={pathname.startsWith(item.href)} />
        ))}
      </div>

      {/* Bottom block — §4.1 step 5 */}
      <div className="mt-auto flex flex-col">
        <div className="flex flex-col gap-px">
          {bottomNav.map((item) => (
            <NavItem key={item.href} item={item} isActive={pathname.startsWith(item.href)} />
          ))}
        </div>

        {/* Credits card (only when setup complete, hidden when collapsed or paused) */}
        {!paused && credits && !collapsed && (
          <div className="mt-[10px]">
            <CreditsCard {...credits} />
          </div>
        )}

        {/* Paused-state replacement for the credits card (§5.7) */}
        {paused && !collapsed && (
          <div className="mt-[10px] px-[12px] text-[11px] font-medium text-destructive">Account paused</div>
        )}

        {/* Profile chip — sits below credits card */}
        <ProfileChip
          {...profile}
          collapsed={collapsed}
          className={!collapsed && (credits || paused) ? "mt-2" : "mt-[10px]"}
        />
      </div>
    </aside>
  );
}

/**
 * Brand row — real Sketch logo, two-line product/org stack, collapse toggle.
 * The logo image switches between light and dark variants based on the resolved
 * theme so the mark always has the right contrast against the sidebar surface.
 */
function BrandRow({
  collapsed,
  onToggle,
  orgName,
}: {
  collapsed: boolean;
  onToggle: () => void;
  orgName: string;
}) {
  const { resolvedTheme } = useTheme();
  const logoSrc = resolvedTheme === "dark" ? "/logos/sketch-icon-darkmode.png" : "/logos/sketch-icon-lightmode.png";

  return (
    <div className={cn("mb-3 flex items-center", collapsed ? "flex-col gap-3 px-0" : "gap-[10px] px-[6px] py-[4px]")}>
      <img src={logoSrc} alt="Sketch" className="h-[28px] w-[28px] shrink-0 select-none" draggable={false} />
      {!collapsed && (
        <div className="flex min-w-0 flex-1 flex-col leading-none">
          <span className="text-[13px] font-semibold text-foreground tracking-tight">Sketch</span>
          <span className="mt-[3px] truncate text-[11px] text-muted-foreground">{orgName}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={cn(
          "shrink-0 rounded-[6px] p-[4px] text-muted-foreground transition-colors duration-100 ease-out cursor-pointer",
          "hover:text-foreground hover:bg-accent",
        )}
      >
        <SidebarSimpleIcon size={16} aria-hidden weight="regular" />
      </button>
    </div>
  );
}

function SearchTrigger({
  collapsed,
  onClick,
  onKeyDown,
}: {
  collapsed: boolean;
  onClick?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Tooltip label="Search (⌘K)" disabled={!collapsed}>
      <button
        type="button"
        onClick={onClick}
        onKeyDown={onKeyDown}
        aria-label="Open search palette"
        className={cn(
          "mb-[18px] flex items-center rounded-[6px] bg-card border border-border text-muted-foreground/65",
          "transition-colors duration-100 ease-out cursor-pointer",
          collapsed ? "h-[30px] w-[30px] mx-auto justify-center" : "px-[10px] py-[7px] gap-[8px]",
        )}
      >
        <SearchIcon size={13} aria-hidden />
        {!collapsed && (
          <>
            <span className="text-[12px]">Search</span>
            <span className="ml-auto text-[10px] text-muted-foreground/50 tracking-[0.02em]">⌘ K</span>
          </>
        )}
      </button>
    </Tooltip>
  );
}

function NavItem({ item, isActive }: { item: NavItemDef; isActive: boolean }) {
  const { collapsed } = useSidebarState();
  const Icon = item.icon;
  const badgeCount = item.badge?.count;
  const pulse = item.pulse;

  return (
    <Tooltip label={item.label} disabled={!collapsed}>
      <Link
        to={item.href}
        className={cn(
          "group relative flex items-center rounded-[6px] transition-colors duration-100 ease-out cursor-pointer",
          isActive ? "text-foreground font-medium" : "text-muted-foreground font-normal",
          isActive ? "bg-sidebar-accent" : "hover:bg-accent hover:text-foreground",
          collapsed ? "h-[30px] w-[30px] mx-auto justify-center" : "px-[8px] py-[7px] gap-[10px] text-[13px]",
        )}
        aria-current={isActive ? "page" : undefined}
      >
        <span className="relative inline-flex items-center justify-center">
          <Icon size={16} aria-hidden />
          {pulse && collapsed && <RunningPulse className="absolute -top-1 -right-1" />}
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 truncate">{item.label}</span>
            {pulse && <RunningPulse />}
            {!pulse && typeof badgeCount === "number" && badgeCount > 0 && <NavBadge count={badgeCount} />}
          </>
        )}
      </Link>
    </Tooltip>
  );
}

/**
 * Inverted-palette tooltip used only when the sidebar is collapsed (§4.1). Pure
 * CSS hover with a 120ms fade — no JS positioning needed since the trigger is a
 * fixed-width icon button.
 */
function Tooltip({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  if (disabled) return <>{children}</>;
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-[8px] z-50",
          "whitespace-nowrap rounded-[6px] px-[9px] py-[4px] text-[11px] font-medium",
          "bg-foreground text-background",
          "opacity-0 transition-opacity duration-[120ms] ease-out",
          "group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
        )}
      >
        {label}
      </span>
    </span>
  );
}

function applyNavState(
  items: NavItemDef[],
  state: Record<string, { badgeCount?: number; pulse?: boolean }> | undefined,
): NavItemDef[] {
  if (!state) return items;
  return items.map((item) => {
    const entry = state[item.href];
    if (!entry) return item;
    return {
      ...item,
      badge: typeof entry.badgeCount === "number" && entry.badgeCount > 0 ? { count: entry.badgeCount } : undefined,
      pulse: entry.pulse,
    };
  });
}
