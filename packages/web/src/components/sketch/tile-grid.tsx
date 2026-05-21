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

/**
 * Bento layout: one featured tile on top (the primary, brand-anchored action)
 * spans full width; three supporting tiles sit below in a 3-column row.
 *
 * The size difference creates the visual hierarchy that color-variety
 * couldn't honestly carry — brand yellow lives only on the featured tile
 * (where it earns its placement), and the supporting tiles stay neutral.
 * Page reads as "one primary, three supporting," not "four equal blocks."
 */
export function TileGrid({ tiles = DEFAULT_TILES, disabled, className }: TileGridProps) {
  const [featured, ...supporting] = tiles;
  return (
    <div className={cn("flex w-full flex-col gap-[12px]", disabled && "pointer-events-none opacity-60", className)}>
      {featured && <FeaturedTile tile={featured} />}
      {supporting.length > 0 && (
        <div
          className="grid w-full gap-[12px]"
          style={{ gridTemplateColumns: `repeat(${supporting.length}, minmax(0, 1fr))` }}
        >
          {supporting.map((tile) => (
            <SupportingTile key={tile.title} tile={tile} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Card chrome shared between the featured and supporting tiles. The featured
 * variant adds extra padding + the brand SparkleIcon watermark; supporting
 * tiles keep it tight. Hover identical across both so the grid feels like
 * one coordinated affordance, not two design languages.
 */
const TILE_BASE = cn(
  "group relative flex items-center gap-[12px] overflow-hidden rounded-[10px] bg-card border border-border",
  "transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out cursor-pointer text-left",
  "hover:bg-muted/60 hover:border-foreground/20",
  "hover:-translate-y-[0.5px] hover:shadow-[0_2px_6px_-2px_rgba(0,0,0,0.06)]",
  "active:translate-y-0 active:shadow-none",
);

function FeaturedTile({ tile }: { tile: TileDef }) {
  const Icon = tile.icon;
  const className = cn(TILE_BASE, "px-[16px] py-[14px]");
  const Inner = (
    <>
      {/* Brand-yellow icon container — earns its placement here because
       * Featured represents the most consequential action on the page.
       * The hover scale (1.08) is the small character moment users get
       * when their cursor lands on the row. */}
      <span
        aria-hidden
        className={cn(
          "flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[8px]",
          "bg-[#FAF3BD] text-[#8B7A00] dark:bg-[#322B0C] dark:text-[#FEED01]",
          "transition-transform duration-200 ease-out group-hover:scale-[1.08]",
        )}
      >
        <Icon size={18} weight="regular" />
      </span>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[14px] font-medium text-foreground leading-[1.3]">{tile.title}</span>
        <span className="text-[12px] text-muted-foreground leading-[1.4]">{tile.description}</span>
      </div>
      {/* Brand sparkle watermark — same character ray that haloes the "S"
       * in the Sketch logo, used here as a signature decorative motif so
       * the featured tile feels like a Sketch tile, not a generic SaaS card.
       * Low opacity (~10%) keeps it as background texture, not a primary
       * visual; brightens slightly on hover. */}
      <SparklesIcon
        aria-hidden
        size={56}
        weight="duotone"
        className={cn(
          "pointer-events-none absolute -right-[6px] -top-[6px] text-[#FEED01]",
          "opacity-[0.18] transition-opacity duration-200 ease-out group-hover:opacity-[0.3]",
        )}
      />
    </>
  );
  if (tile.href) {
    return (
      <Link to={tile.href} className={className}>
        {Inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={tile.onClick} className={className}>
      {Inner}
    </button>
  );
}

function SupportingTile({ tile }: { tile: TileDef }) {
  const Icon = tile.icon;
  const className = cn(TILE_BASE, "px-[12px] py-[11px]");
  const Inner = (
    <>
      <Icon
        size={16}
        weight="regular"
        aria-hidden
        className="shrink-0 text-muted-foreground transition-colors duration-150 ease-out group-hover:text-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground leading-[1.3]">
        {tile.title}
      </span>
    </>
  );
  if (tile.href) {
    return (
      <Link to={tile.href} className={className}>
        {Inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={tile.onClick} className={className}>
      {Inner}
    </button>
  );
}
