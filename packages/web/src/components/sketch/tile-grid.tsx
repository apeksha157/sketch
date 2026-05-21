/**
 * Workspace status cards — the four Sketch primitives, surfaced as live
 * state rather than abstract "create" buttons.
 *
 * Each tile carries:
 *   - icon + primitive name (top row, label-style)
 *   - primary metric (big number/headline — the at-a-glance signal)
 *   - secondary context (one line, supporting detail)
 *
 * Lifecycle-aware: the *shape* is constant across new / familiar / power
 * users, but the *content* in each card adapts to workspace state. A new
 * user sees "Nothing scheduled yet · Set one up →"; a power user sees
 * "5 running · Next at 8:00 AM tomorrow". Same component, three states.
 *
 * Whole tile is clickable and routes to that primitive's list page; the
 * "create new" affordance lives there, not duplicated on the home page.
 */
import { CalendarTimeIcon, type IconProps, PuzzleIcon, SparklesIcon, UsersIcon } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";

export interface TileDef {
  title: string;
  /** Headline metric — the big number/state. */
  primary: string;
  /** Supporting context line. */
  secondary: string;
  icon: ComponentType<IconProps>;
  /** Provide either an href (Link) or onClick (button). */
  href?: string;
  onClick?: () => void;
  /**
   * Empty-state hint — when true, the tile renders the primary/secondary
   * with a softer, encouragement-oriented treatment (used for new-user
   * variants where the metric is 0). Visual remains identical otherwise.
   */
  empty?: boolean;
}

/** Power-user state — workspace with substantial activity (default). */
export const POWER_USER_TILES: TileDef[] = [
  {
    title: "Automations",
    primary: "5 running",
    secondary: "Next at 8:00 AM tomorrow",
    icon: CalendarTimeIcon,
    href: "/scheduled-tasks",
  },
  {
    title: "Skills",
    primary: "12 in library",
    secondary: "4 yours · 8 shared",
    icon: SparklesIcon,
    href: "/skills",
  },
  {
    title: "Integrations",
    primary: "8 connected",
    secondary: "Gmail, Slack, Linear +5",
    icon: PuzzleIcon,
    href: "/integrations",
  },
  {
    title: "Team",
    primary: "7 people",
    secondary: "You + 6 others",
    icon: UsersIcon,
    href: "/team",
  },
];

/** Familiar-user state — workspace with early activity. */
export const FAMILIAR_USER_TILES: TileDef[] = [
  {
    title: "Automations",
    primary: "2 running",
    secondary: "Next at 4:00 PM today",
    icon: CalendarTimeIcon,
    href: "/scheduled-tasks",
  },
  {
    title: "Skills",
    primary: "1 in library",
    secondary: "Yours · used 3 times",
    icon: SparklesIcon,
    href: "/skills",
  },
  {
    title: "Integrations",
    primary: "3 connected",
    secondary: "Gmail, Slack, Notion",
    icon: PuzzleIcon,
    href: "/integrations",
  },
  {
    title: "Team",
    primary: "2 people",
    secondary: "You + 1 other",
    icon: UsersIcon,
    href: "/team",
  },
];

/** New-user state — workspace empty, encouragement copy. */
export const NEW_USER_TILES: TileDef[] = [
  {
    title: "Automations",
    primary: "Nothing scheduled yet",
    secondary: "Set one up →",
    icon: CalendarTimeIcon,
    href: "/scheduled-tasks/new",
    empty: true,
  },
  {
    title: "Skills",
    primary: "Browse the library",
    secondary: "1,000+ ready-made →",
    icon: SparklesIcon,
    href: "/skills",
    empty: true,
  },
  {
    title: "Integrations",
    primary: "Get started",
    secondary: "Connect Gmail →",
    icon: PuzzleIcon,
    href: "/integrations",
    empty: true,
  },
  {
    title: "Team",
    primary: "Working solo",
    secondary: "Invite a teammate →",
    icon: UsersIcon,
    href: "/team/invite",
    empty: true,
  },
];

/**
 * Default tile set returns the power-user variant. New / familiar callers
 * pass the appropriate exported set directly.
 */
export function getDefaultTiles(_teamSize?: number): TileDef[] {
  return POWER_USER_TILES;
}

export const DEFAULT_TILES: TileDef[] = POWER_USER_TILES;

export interface TileGridProps {
  tiles?: TileDef[];
  disabled?: boolean;
  className?: string;
}

/**
 * 2x2 status-card grid. Each tile carries real workspace state, not an
 * abstract button label. The pattern: small icon + label across the top,
 * big primary metric below, supporting context line under that.
 */
export function TileGrid({ tiles = DEFAULT_TILES, disabled, className }: TileGridProps) {
  return (
    <div
      className={cn("grid w-full gap-[12px]", disabled && "pointer-events-none opacity-60", className)}
      style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
    >
      {tiles.map((tile) => (
        <TileItem key={tile.title} tile={tile} />
      ))}
    </div>
  );
}

function TileItem({ tile }: { tile: TileDef }) {
  const Icon = tile.icon;
  const Inner = (
    <>
      {/* Label row — icon + primitive name. Quiet (muted-foreground)
       * because it's a header for the state below, not the focal point. */}
      <div className="flex items-center gap-[8px]">
        <Icon size={16} weight="regular" aria-hidden className="shrink-0 text-[#412402] dark:text-[#FEED01]" />
        <span className="text-[12px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{tile.title}</span>
      </div>
      {/* State block — primary metric is the focal point, secondary line
       * gives context. Empty-state variant softens the primary tone so it
       * doesn't shout when there's nothing to announce. */}
      <div className="mt-[12px] flex flex-col">
        <span
          className={cn(
            "text-[20px] font-semibold leading-[1.2]",
            tile.empty ? "text-foreground/85" : "text-foreground",
          )}
        >
          {tile.primary}
        </span>
        <span className="mt-[4px] text-[12px] leading-[1.4] text-muted-foreground">{tile.secondary}</span>
      </div>
    </>
  );

  const baseClass = cn(
    "group flex flex-col rounded-[12px] bg-card border border-border",
    "transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out cursor-pointer text-left",
    "hover:bg-muted/40 hover:border-foreground/20",
    "hover:-translate-y-[0.5px] hover:shadow-[0_2px_6px_-2px_rgba(0,0,0,0.06)]",
    "active:translate-y-0 active:shadow-none",
    "px-[16px] pt-[14px] pb-[16px]",
  );

  if (tile.href) {
    return (
      <Link to={tile.href} className={baseClass}>
        {Inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={tile.onClick} className={baseClass}>
      {Inner}
    </button>
  );
}
