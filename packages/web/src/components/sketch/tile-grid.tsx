/**
 * Tile grid — the four workspace primitives Sketch lets you create.
 *
 * Section identity: "the things you can spin up in a Sketch workspace."
 * Four primitives, parallel weight — automation, skill, integration, teammate.
 * Distinct from the chip row above ("things to do *right now*") and from
 * Recents below ("what you were working on").
 *
 * Earlier iterations included a "Show me what's possible" discovery tile;
 * dropped because it doesn't share the section's frame (discovery, not
 * creation) and it duplicates a chip in the row above.
 */
import { CalendarTimeIcon, type IconProps, PuzzleIcon, SparklesIcon, UserPlusIcon } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";

export interface TileDef {
  title: string;
  description: string;
  icon: ComponentType<IconProps>;
  /** Provide either an href (Link) or onClick (button). */
  href?: string;
  onClick?: () => void;
}

const TILE_AUTOMATION: TileDef = {
  title: "Set up an automation",
  description: "Schedule a recurring task that runs on its own.",
  icon: CalendarTimeIcon,
  href: "/scheduled-tasks/new",
};
const TILE_SKILL: TileDef = {
  title: "Create a skill",
  description: "Teach Sketch a new capability your team can re-use.",
  icon: SparklesIcon,
  href: "/skills/new",
};
const TILE_INTEGRATION: TileDef = {
  title: "Connect an integration",
  description: "Wire up Gmail, Notion, Linear, and 300+ more.",
  icon: PuzzleIcon,
  href: "/integrations",
};
const TILE_INVITE: TileDef = {
  title: "Invite a teammate",
  description: "Bring someone else into your workspace.",
  icon: UserPlusIcon,
  href: "/team/invite",
};

/**
 * Default tile set — the four Sketch workspace primitives. No rotation,
 * no slot-swap based on workspace state: every workspace can create or
 * connect each of these at any time, so they all earn permanent placement.
 *
 * teamSize is accepted for API compatibility with prior signatures but
 * no longer changes the set — kept so /home/setup and other callers don't
 * need to update their call sites.
 */
export function getDefaultTiles(_teamSize?: number): TileDef[] {
  return [TILE_AUTOMATION, TILE_SKILL, TILE_INTEGRATION, TILE_INVITE];
}

export const DEFAULT_TILES: TileDef[] = getDefaultTiles();

export interface TileGridProps {
  tiles?: TileDef[];
  disabled?: boolean;
  className?: string;
}

/**
 * 2x2 equal-weight baseline. All four primitives are parallel in role —
 * none is more important than another, so the layout treats them
 * identically. This is the honest starting point for the layout
 * conversation: no fake hierarchy from size, no invented colors, just
 * four tiles that share the same chrome.
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
      <span
        aria-hidden
        className={cn(
          "flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px]",
          "bg-[#FAF3BD] text-[#8B7A00] dark:bg-[#322B0C] dark:text-[#FEED01]",
          "transition-transform duration-200 ease-out group-hover:scale-[1.08]",
        )}
      >
        <Icon size={16} weight="regular" />
      </span>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[13.5px] font-medium text-foreground leading-[1.3]">{tile.title}</span>
        <span className="text-[12px] text-muted-foreground leading-[1.4]">{tile.description}</span>
      </div>
    </>
  );

  const baseClass = cn(
    "group flex items-center gap-[12px] rounded-[10px] bg-card border border-border",
    "transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out cursor-pointer text-left",
    "hover:bg-muted/60 hover:border-foreground/20",
    "hover:-translate-y-[0.5px] hover:shadow-[0_2px_6px_-2px_rgba(0,0,0,0.06)]",
    "active:translate-y-0 active:shadow-none",
    "px-[14px] py-[12px]",
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
