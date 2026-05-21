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
  title: "Schedule a task",
  description: "Set up something that runs on its own.",
  icon: CalendarTimeIcon,
  href: "/scheduled-tasks/new",
};
const TILE_SKILL: TileDef = {
  title: "Teach Sketch a skill",
  description: "Add a reusable capability for the team.",
  icon: SparklesIcon,
  href: "/skills/new",
};
const TILE_INTEGRATION: TileDef = {
  title: "Plug in a tool",
  description: "Wire up Gmail, Notion, Linear, and 300+ more.",
  icon: PuzzleIcon,
  href: "/integrations",
};
const TILE_INVITE: TileDef = {
  title: "Pull in a teammate",
  description: "Bring someone else into the workspace.",
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
 * Single horizontal row of four — icon stacked on top, title centered
 * below. This vertical arrangement is what earns the row-of-4 visually:
 * it reads as "destinations" (icon as anchor, label as caption) rather
 * than "buttons" (icon as bullet, label as text), and the orientation
 * deliberately diverges from the chip row's horizontal pill shape so
 * the two surfaces don't compete.
 *
 * All four tiles share a single brand-yellow icon container (no two-tone
 * split); the visual rhythm comes from the vertical-stack layout itself,
 * not from chromatic variation between cards.
 */
export function TileGrid({ tiles = DEFAULT_TILES, disabled, className }: TileGridProps) {
  return (
    <div
      className={cn("grid w-full gap-[10px]", disabled && "pointer-events-none opacity-60", className)}
      style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
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
      {/* Bare brown phosphor — no container, no fill. Brand stays implicit
       * through the brown tone (matches the logo); card chrome carries the
       * rest. Subtle 1.08 scale on hover gives a tiny moment of personality
       * without needing chromatic weight on the row at rest. */}
      <Icon
        size={22}
        weight="regular"
        aria-hidden
        className="text-[#412402] transition-transform duration-200 ease-out group-hover:scale-[1.08] dark:text-[#FEED01]"
      />
      <span className="text-left text-[13px] font-medium text-foreground leading-[1.3]">{tile.title}</span>
    </>
  );

  const baseClass = cn(
    "group flex flex-col items-start justify-start gap-[16px] rounded-[12px] bg-card border border-border",
    "transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out cursor-pointer text-left",
    "hover:bg-muted/60 hover:border-foreground/20",
    "hover:-translate-y-[0.5px] hover:shadow-[0_2px_6px_-2px_rgba(0,0,0,0.06)]",
    "active:translate-y-0 active:shadow-none",
    "px-[14px] pt-[14px] pb-[14px]",
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
