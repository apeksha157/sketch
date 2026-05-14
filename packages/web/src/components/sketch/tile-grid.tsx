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
       * Icon slot — soft warm wash on hover (not a saturated yellow square).
       * The dark-icon-on-brand-yellow combo read tacky; this version keeps
       * the icon the same neutral color and only warms its container with a
       * faint cream tint so the brand peeks through without shouting.
       */}
      <span
        className={cn(
          "flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px]",
          "bg-muted text-muted-foreground",
          "transition-all duration-200 ease-out",
          "group-hover:bg-[color-mix(in_oklch,#FEED01_28%,var(--muted))]",
          "group-hover:text-foreground",
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
   * Bento card — horizontal layout (icon left, text right) so each tile reads
   * as a compact action row instead of a sparse 112px block.
   *
   * Hover warms the whole card: a faint cream wash on the background, a
   * border that shifts toward yellow, and the icon container picks up the
   * same warmth. That puts brand color across the surface — card + border +
   * icon — instead of cramming all the yellow into one shouty icon square.
   */
  const baseClass = cn(
    "group flex items-center gap-[12px] rounded-[10px] bg-card border border-border",
    "transition-all duration-200 ease-out cursor-pointer text-left",
    "hover:-translate-y-[1px]",
    "hover:bg-[color-mix(in_oklch,#FEED01_4%,var(--card))]",
    "hover:border-[color-mix(in_oklch,#FEED01_50%,var(--border))]",
    "hover:shadow-[0_4px_14px_-6px_color-mix(in_oklch,#FEED01_35%,transparent)]",
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
