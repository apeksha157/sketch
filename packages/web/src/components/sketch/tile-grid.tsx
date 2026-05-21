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

/**
 * Per-tile accent palette. Each accent renders as a soft pastel surface
 * behind the icon, paired with a deeper saturated glyph color. Tiles vary
 * accents so the grid reads as four distinct affordances at a glance,
 * not "four yellow blocks." Brand yellow is reserved for the primary
 * scheduling action; the other three pull from a complementary muted set
 * (lavender / sage / peach) so the page feels designed, not monotonous,
 * without breaking the no-yellow-on-non-CTA rule.
 */
export type TileAccent = "yellow" | "lavender" | "sage" | "peach";

const ACCENT_CLASSES: Record<TileAccent, string> = {
  yellow: "bg-[#FAF3BD] text-[#8B7A00] dark:bg-[#322B0C] dark:text-[#FEED01]",
  lavender: "bg-[#ECE6F8] text-[#6B4FBB] dark:bg-[#241D38] dark:text-[#B9A6F0]",
  sage: "bg-[#E3EFE4] text-[#3F7B4A] dark:bg-[#1B2A1D] dark:text-[#9BC6A0]",
  peach: "bg-[#F8E4D6] text-[#A85A2D] dark:bg-[#2D1F1A] dark:text-[#D9A39E]",
};

export interface TileDef {
  title: string;
  description: string;
  icon: ComponentType<IconProps>;
  /** Color identity — anchors the tile visually so the grid isn't monotone. */
  accent: TileAccent;
  /** Provide either an href (Link) or onClick (button). */
  href?: string;
  onClick?: () => void;
}

const TILE_AUTOMATION: TileDef = {
  title: "Set up an automation",
  description: "Schedule a recurring task that runs on its own.",
  icon: CalendarTimeIcon,
  accent: "yellow",
  href: "/scheduled-tasks/new",
};
const TILE_SKILL: TileDef = {
  title: "Create a skill",
  description: "Teach Sketch a new capability your team can re-use.",
  icon: SparklesIcon,
  accent: "lavender",
  href: "/skills/new",
};
const TILE_INVITE: TileDef = {
  title: "Invite a teammate",
  description: "Bring someone else into your workspace.",
  icon: UserPlusIcon,
  accent: "sage",
  href: "/team/invite",
};
const TILE_INTEGRATION: TileDef = {
  title: "Connect an integration",
  description: "Wire up Gmail, Notion, Linear, and 300+ more.",
  icon: PuzzleIcon,
  accent: "sage",
  href: "/integrations",
};
const TILE_POSSIBLE: TileDef = {
  title: "Show me what's possible",
  description: "Browse examples from other teams.",
  icon: BulbIcon,
  accent: "peach",
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
      {/* Colored icon surface — per-tile accent (see ACCENT_CLASSES). Each
       * tile carries a distinct muted palette so the grid reads as four
       * affordances with their own identity, not a row of indistinguishable
       * cards. The icon nudges up 8% on hover (sketch-tile-icon-hover), a
       * small character moment that confirms the row is alive without
       * relying on the underlying card chrome to do it. */}
      <span
        aria-hidden
        className={cn(
          "flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px]",
          "transition-transform duration-200 ease-out group-hover:scale-[1.08]",
          ACCENT_CLASSES[tile.accent],
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

  /**
   * Card chrome — neutral surface + border at rest, subtle bg darken +
   * border emphasis + 0.5px lift on hover. The chromatic personality lives
   * inside the icon container (per-tile accent + hover scale); the card
   * itself stays restrained so the four accents read clearly side by side.
   */
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
