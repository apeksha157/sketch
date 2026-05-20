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
import { ExpandToggle } from "@/components/sketch/expand-toggle";
import {
  CalendarTimeIcon,
  ChannelsIcon,
  HomeIcon,
  type IconProps,
  PauseCircleIcon,
  PuzzleIcon,
  SearchIcon,
  SparklesIcon,
  UsersIcon,
} from "@/components/sketch/icons";
import { ProfileChip, type ProfileChipProps } from "@/components/sketch/profile-chip";
import { useSidebarState } from "@/components/sketch/sidebar-context";
import { SidebarFilesCard, type SidebarFilesCardProps } from "@/components/sketch/sidebar-files-card";
import { SidebarSetupNudge, type SidebarSetupNudgeProps } from "@/components/sketch/sidebar-setup-nudge";
import { NavBadge, RunningPulse } from "@/components/sketch/status-indicators";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { cn } from "@sketch/ui/lib/utils";
import { Link, useLocation } from "@tanstack/react-router";
import { type ComponentType, type KeyboardEvent, type MouseEvent, useCallback } from "react";

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

const BOTTOM_NAV: NavItemDef[] = [{ label: "Team", icon: UsersIcon, href: "/team" }];

/** Helper for the rail click-to-expand: was the click on an existing button/link? */
function isOnInteractiveElement(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, a, [role="button"]'));
}

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
  /**
   * Files — promoted out of the nav into its own card-styled slot (above
   * setup-nudge / credits / profile). Renders the "brain of the org" surface
   * with live count + breakdown. When omitted, the Files affordance is hidden
   * entirely — callers must opt in.
   */
  files?: SidebarFilesCardProps;
  /** When true, the credits card slot is replaced with a "Account paused" line (§5.7). */
  paused?: boolean;
  /**
   * Optional setup-progress nudge. Shown above the credits/profile area while
   * setup is in progress so the affordance persists across every route — even
   * after the user dismisses the top banner / inline home card. Mutually
   * exclusive with `credits`: setup completion is what makes credits visible.
   */
  setupNudge?: SidebarSetupNudgeProps;
  /** Triggered when the user clicks the search affordance or presses ⌘K. */
  onOpenSearchPalette?: () => void;
}

export function SketchSidebar({
  profile,
  orgName,
  navState,
  credits,
  files,
  paused,
  setupNudge,
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

  /**
   * Click/Enter/Space anywhere on empty rail space expands (collapsed only).
   * Bails out if the target landed on a real button/link so nav items still
   * navigate and the search trigger still opens its palette without also
   * expanding. The keyboard branch is required so the mouse-convenience
   * behaviour has parity for assistive tech, even though the aside itself
   * isn't tab-focusable (the ExpandToggle and nav buttons are).
   */
  const handleRailClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!collapsed) return;
      if (isOnInteractiveElement(event.target)) return;
      toggle();
    },
    [collapsed, toggle],
  );
  const handleRailKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!collapsed) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      if (isOnInteractiveElement(event.target)) return;
      event.preventDefault();
      toggle();
    },
    [collapsed, toggle],
  );

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      onClick={collapsed ? handleRailClick : undefined}
      onKeyDown={collapsed ? handleRailKeyDown : undefined}
      className={cn(
        // `group/rail` lets the ExpandToggle react to hovers on the whole rail.
        "group/rail relative flex h-screen flex-col bg-sidebar border-r border-border",
        collapsed ? "w-[52px] py-[14px] px-0 cursor-pointer" : "w-[256px] px-[12px] py-[14px]",
        "shrink-0 select-none",
      )}
    >
      {/* Brand row — Sketch logo + org name. The collapse/expand toggle is
       * NOT here; it lives as a single floating <ExpandToggle /> at the
       * right-edge midpoint in BOTH states, just flipping chevron direction.
       * That keeps the affordance in one predictable location regardless of
       * state. */}
      <BrandRow collapsed={collapsed} orgName={orgName} />

      {/* Expand/collapse toggle — same Tab pull-handle in both states. Right
       * edge, vertical midpoint, half-protruding. Chevron flips: left when
       * the rail is open (click to close), right when closed (click to open). */}
      <ExpandToggle
        onClick={toggle}
        ariaLabel={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        direction={collapsed ? "right" : "left"}
      />

      {/* Search trigger */}
      <SearchTrigger collapsed={collapsed} onClick={onOpenSearchPalette} onKeyDown={handleSearchKey} />

      {/* Primary nav — Home + middle group rendered as one cohesive list. */}
      <div className="flex flex-col gap-[2px]">
        <NavItem item={{ label: "Home", icon: HomeIcon, href: "/home/default" }} isActive={homeActive} />
        {middleNav.map((item) => (
          <NavItem key={item.href} item={item} isActive={pathname.startsWith(item.href)} />
        ))}
      </div>

      {/* Bottom block — Team + Files separated from the primary nav by a thin
       * divider so the workspace vs. account groups read as distinct families.
       * Files lives in its own card-styled slot (the "brain of the org"
       * affordance), below Team and above the account zone. */}
      <div className={cn("mt-auto flex flex-col", collapsed ? "" : "border-t border-border pt-[10px]")}>
        <div className="flex flex-col gap-[2px]">
          {bottomNav.map((item) => (
            <NavItem key={item.href} item={item} isActive={pathname.startsWith(item.href)} />
          ))}
        </div>

        {files && (
          <div className={collapsed ? "mt-[6px] flex justify-center" : "mt-[8px]"}>
            <SidebarFilesCard {...files} />
          </div>
        )}

        {/* Account zone — setup-nudge / credits / paused-line + profile chip
         * share the same vertical slot. Precedence: setupNudge wins while
         * setup is in progress (the affordance only disappears when setup
         * completes), then credits, then paused. */}
        {setupNudge && (
          <div className={collapsed ? "mt-[14px] flex justify-center" : "mt-[18px]"}>
            <SidebarSetupNudge {...setupNudge} />
          </div>
        )}

        {!setupNudge && !paused && credits && !collapsed && (
          <div className="mt-[18px]">
            <CreditsCard {...credits} />
          </div>
        )}

        {/* Paused-state replacement for the credits card (§5.7).
         * Mirrors CreditsCard's container exactly so the sidebar silhouette
         * stays the same when the account flips active ↔ paused — same
         * rounded box, same padding, same two-row layout. Top row: pause
         * icon + label. Bottom row: solid destructive bar in place of the
         * progress bar's "credits remaining" affordance. */}
        {!setupNudge && paused && !collapsed && <PausedCard />}

        <ProfileChip
          {...profile}
          collapsed={collapsed}
          className={!collapsed && (setupNudge || credits || paused) ? "mt-[6px]" : "mt-[18px]"}
        />
      </div>
    </aside>
  );
}

/**
 * Brand row — logo carries the brand; the wordmark gets dropped so the org
 * name can read at proper presence beside the icon instead of as a footnote.
 *
 * No collapse button in here: the collapse/expand affordance lives as a
 * single <ExpandToggle /> on the rail's right edge in BOTH states (one
 * predictable location), so the brand row stays purely identity.
 */
function BrandRow({
  collapsed,
  orgName,
}: {
  collapsed: boolean;
  orgName: string;
}) {
  const { resolvedTheme } = useTheme();
  const logoSrc = resolvedTheme === "dark" ? "/logos/sketch-icon-darkmode.png" : "/logos/sketch-icon-lightmode.png";

  return (
    <div className={cn("mb-3 flex items-center", collapsed ? "justify-center px-0" : "gap-[10px] px-[8px] py-[4px]")}>
      <img src={logoSrc} alt="Sketch" className="h-[28px] w-[28px] shrink-0 select-none" draggable={false} />
      {!collapsed && (
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground tracking-tight">
          {orgName}
        </span>
      )}
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
          "mb-[10px] flex items-center rounded-[6px] bg-foreground/[0.04] text-muted-foreground/75",
          "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.08] hover:text-foreground",
          collapsed ? "h-[30px] w-[30px] mx-auto justify-center" : "px-[8px] py-[7px] gap-[10px]",
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
          isActive
            ? "text-foreground font-medium bg-foreground/[0.07]"
            : "text-muted-foreground font-normal hover:bg-foreground/[0.04] hover:text-foreground",
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

/**
 * Paused-state indicator that mirrors CreditsCard's container shape so the
 * sidebar's silhouette doesn't change between active and paused states.
 *
 * Same outer container (rounded-[6px] px-[8px] py-[8px], two-row layout) as
 * CreditsCard. Top row: pause icon + label. Bottom row: a solid destructive
 * bar in place of the CreditsCard's progress affordance — a deliberate visual
 * "no available capacity" cue without pretending to be a real meter.
 */
function PausedCard() {
  return (
    <output aria-label="Account paused" className="flex w-full flex-col gap-[6px] rounded-[6px] px-[8px] py-[8px]">
      <span className="flex items-center gap-[6px] text-[12px] leading-none">
        <PauseCircleIcon size={14} weight="fill" aria-hidden className="shrink-0 text-destructive" />
        <span className="font-medium text-destructive">Account paused</span>
      </span>
      <span className="h-[2px] w-full rounded-full bg-destructive/25" aria-hidden>
        <span className="block h-full w-full rounded-full bg-destructive/70" />
      </span>
    </output>
  );
}
