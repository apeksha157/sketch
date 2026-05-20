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
      {/* Bare icon — no surface, no brand-color container. Quick-action
       * tiles aren't primary CTAs (yellow is reserved for those), so the
       * brand handhold is dropped. The icon brightens on hover instead,
       * which is the same chromatic-moment-on-hover idiom the DangerBanner
       * CTA uses. mt-[2px] aligns the icon's optical center with the
       * title's x-height instead of the full text-block midpoint. */}
      <Icon
        size={18}
        weight="regular"
        aria-hidden
        className="mt-[2px] shrink-0 text-muted-foreground transition-colors duration-150 ease-out group-hover:text-foreground"
      />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[13.5px] font-medium text-foreground leading-[1.3]">{tile.title}</span>
        <span className="text-[12px] text-muted-foreground leading-[1.4]">{tile.description}</span>
      </div>
    </>
  );

  /**
   * Card chrome — neutral surface + border at rest, subtle bg darken +
   * border emphasis + 0.5px lift on hover. No brand color anywhere in
   * the tile at rest; the icon's hover brighten is the only chromatic
   * accent in the entire affordance.
   */
  const baseClass = cn(
    "group flex items-start gap-[14px] rounded-[10px] bg-card border border-border",
    "transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out cursor-pointer text-left",
    "hover:bg-muted/60 hover:border-foreground/20",
    "hover:-translate-y-[0.5px] hover:shadow-[0_2px_6px_-2px_rgba(0,0,0,0.06)]",
    "active:translate-y-0 active:shadow-none",
    "px-[14px] py-[11px]",
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
