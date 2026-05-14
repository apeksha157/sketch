/**
 * Tile grid — quick-action shortcuts on the home pane.
 *
 * Each tile carries title + one-line description so the card earns its 112px
 * of vertical space (an empty labelled card is dead weight). The 2×2 grid stays
 * stable across workspace states — the set rotates rather than reshuffles:
 *   - Solo workspace surfaces "Invite a teammate".
 *   - Once the team grows, that slot rotates to "Connect an integration"
 *     so we never ship a 3-tile orphan.
 */
import {
  BulbIcon,
  CalendarTimeIcon,
  type IconProps,
  PuzzleIcon,
  SparklesIcon,
  UserPlusIcon,
} from "@/components/sketch/icons";
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
const TILE_INVITE: TileDef = {
  title: "Invite a teammate",
  description: "Bring someone else into your workspace.",
  icon: UserPlusIcon,
  href: "/team/invite",
};
const TILE_INTEGRATION: TileDef = {
  title: "Connect an integration",
  description: "Wire up Gmail, Notion, Linear, and 300+ more.",
  icon: PuzzleIcon,
  href: "/integrations",
};
const TILE_POSSIBLE: TileDef = {
  title: "Show me what's possible",
  description: "Browse examples from other teams.",
  icon: BulbIcon,
};

/**
 * Default tile set adapts to workspace state to keep the grid full.
 *   - teamSize ≤ 1 → show Invite.
 *   - teamSize ≥ 2 → swap Invite for an Integration prompt.
 */
export function getDefaultTiles(teamSize: number | undefined = 1): TileDef[] {
  const inviteSlot = (teamSize ?? 1) <= 1 ? TILE_INVITE : TILE_INTEGRATION;
  return [TILE_AUTOMATION, TILE_SKILL, inviteSlot, TILE_POSSIBLE];
}

export const DEFAULT_TILES: TileDef[] = getDefaultTiles();

export interface TileGridProps {
  tiles?: TileDef[];
  disabled?: boolean;
  className?: string;
}

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
      {/*
       * Icon slot — static SKETCH_TILE treatment carried over from the prior
       * member home: low-opacity brand-yellow wash with a muted-gold glyph in
       * light mode (full-yellow glyph in dark). Brand stays present at rest;
       * hover is neutral on the row, not on the icon.
       */}
      <span
        className={cn(
          "flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px]",
          "bg-[#FEED01]/15 dark:bg-[#FEED01]/[0.06] text-[#8B7A00] dark:text-[#FEED01]",
        )}
        aria-hidden
      >
        <Icon size={16} weight="regular" />
      </span>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[13.5px] font-medium text-foreground leading-[1.3]">{tile.title}</span>
        <span className="text-[12px] text-muted-foreground leading-[1.4]">{tile.description}</span>
      </div>
    </>
  );

  /**
   * Bento card — horizontal layout (icon left, text right). Hover is a neutral
   * muted wash on the row (matches /old/home/member's row-hover convention),
   * not a branded yellow takeover. Brand colour stays anchored in the icon
   * tile so it reads as part of the resting state, never the alarm.
   */
  const baseClass = cn(
    "group flex items-center gap-[12px] rounded-[10px] bg-card border border-border",
    "transition-colors duration-150 ease-out cursor-pointer text-left",
    "hover:bg-muted/40 hover:border-border",
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
