/**
 * HomePane — the composed content for /home/* routes.
 *
 * Greeting → chat input → chip row → (optional celebration card) → tile grid →
 * recents. Routes pick the variant by passing flags rather than reassembling
 * the layout; this keeps every home state pixel-aligned (a hard prereq from
 * the card-state pre-flight checklist).
 */
import { CelebrationCard } from "@/components/sketch/celebration-card";
import { ChatInput, type ChatInputProps } from "@/components/sketch/chat-input";
import { ChipRow, type ChipSuggestion } from "@/components/sketch/chip-row";
import { ConversationRow, type ConversationRowProps } from "@/components/sketch/conversation-row";
import { type TileDef, TileGrid, getDefaultTiles } from "@/components/sketch/tile-grid";
import { GreetingBar, type HomeDigest } from "@/routes/home";
import { MOCK_DIGEST } from "@/routes/sketch/mock-data";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

export interface HomePaneProps {
  firstName: string;
  /** Total people on the workspace. <=1 means solo — surfaces "Invite a
   * teammate" in the tile grid; >=2 swaps that slot for an integration prompt. */
  teamSize?: number;
  /** Recent conversations, capped to 5 in the recents section (§5.2). */
  recents: ConversationRowProps[];
  /** Drives the rotating digest-aware subtitle under the greeting. */
  digest?: HomeDigest;
  /** Disables input + chips + tiles for paused states (§5.7). */
  disabled?: boolean;
  /** Renders the celebration card between chip row and tile grid (§5.10). */
  celebration?: { onDismiss: () => void };
  /**
   * When true, the Recents section is omitted entirely (header + body) while
   * `recents` is empty. Used on /home/setup where an empty placeholder
   * competes with the setup banner for attention without adding signal;
   * the section reappears as soon as the user has any conversations.
   *
   * Default false — preserves the labelled-empty-state behavior on the
   * default home variant where Recents is always part of the page rhythm.
   */
  hideRecentsWhenEmpty?: boolean;
  /** Override the chat submit — used to navigate to /chat/:new. */
  onSubmit?: ChatInputProps["onSubmit"];
  /** Override the "Show me what's possible" tile. */
  onShowPossibilities?: () => void;
  /**
   * Override the Workspace tile set — drives the lifecycle variant (new /
   * familiar / power). When omitted, falls back to the default power-user
   * state via getDefaultTiles().
   */
  tiles?: TileDef[];
  /**
   * Override the "Workspace" section eyebrow — lets new-user variants
   * replace it with friendlier copy ("Get started", "What's here") while
   * keeping the same component.
   */
  workspaceHeading?: string;
  /** Replace the rotating nudge subtitle under the greeting (used by onboarding
   * mockups so brand-new users see a welcome line rather than a returning-user nudge). */
  subtitleOverride?: string;
}

/**
 * Wrapper sizing matches the other dashboard pages exactly (skills, plans,
 * etc.): mx-auto max-w-4xl px-10 py-8 — so the greeting sits at the same
 * vertical position as every other page's header.
 *
 * Vertical rhythm: hero (greeting + input + chips) → consistent 28px gap into
 * each labelled section. Quick actions and Recents share the same gap above
 * them so the page reads as two parallel sections, not a hero with a special
 * Quick actions break.
 */
export function HomePane({
  firstName,
  teamSize,
  recents,
  digest,
  disabled,
  celebration,
  hideRecentsWhenEmpty,
  onSubmit,
  tiles: tilesProp,
  workspaceHeading = "Workspace",
  subtitleOverride,
}: HomePaneProps) {
  const tiles = tilesProp ?? getDefaultTiles(teamSize);
  const inputRef = useRef<HTMLInputElement>(null);
  const [prefill, setPrefill] = useState<string>("");

  function handleChip(chip: ChipSuggestion) {
    setPrefill(chip.prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-10 py-8">
      {/* Hero — greeting + chat input + chip row. */}
      <section className="flex flex-col">
        <GreetingBar firstName={firstName} digest={digest ?? MOCK_DIGEST} subtitleOverride={subtitleOverride} />
        <div className="mt-7 flex flex-col gap-3">
          <ChatInput ref={inputRef} key={prefill} initialValue={prefill} disabled={disabled} onSubmit={onSubmit} />
          <ChipRow onPick={handleChip} disabled={disabled} />
        </div>
      </section>

      {/* Below-the-fold rail — labelled sections under the hero. Same 28px gap
       * above each section (Quick actions and Recents) so the rhythm is
       * uniform; the section headings themselves carry the separation. */}
      <div className="mt-7 flex flex-col gap-7">
        {celebration && <CelebrationCard onDismiss={celebration.onDismiss} />}
        <QuickActions tiles={tiles} disabled={disabled} heading={workspaceHeading} />
        {/* Recents — hidden entirely when empty during setup so the page's
         * call-to-action (the banner) isn't competing with a placeholder
         * "your conversations will appear here" footer that adds no signal. */}
        {(!hideRecentsWhenEmpty || recents.length > 0) && <Recents conversations={recents} />}
      </div>
    </div>
  );
}

interface QuickActionsProps {
  tiles: ReturnType<typeof getDefaultTiles>;
  disabled?: boolean;
  heading?: string;
  className?: string;
}

function QuickActions({ tiles, disabled, heading = "Workspace", className }: QuickActionsProps) {
  return (
    <section className={cn("flex flex-col", className)}>
      <div className="mb-[10px] flex items-baseline justify-between px-[6px]">
        <h2 className="font-mono text-xs uppercase text-foreground" style={{ letterSpacing: "0.08em" }}>
          {heading}
        </h2>
      </div>
      <TileGrid tiles={tiles} disabled={disabled} />
    </section>
  );
}

interface RecentsProps {
  conversations: ConversationRowProps[];
  /** When provided, renders a "View all →" link to /conversations (§5.2). */
  viewAll?: boolean;
  className?: string;
}

function Recents({ conversations, viewAll = true, className }: RecentsProps) {
  const items = conversations.slice(0, 5);
  return (
    <section className={cn("flex flex-col", className)}>
      <div className="mb-[10px] flex items-baseline justify-between px-[6px]">
        <h2 className="font-mono text-xs uppercase text-foreground" style={{ letterSpacing: "0.08em" }}>
          {conversations.length === 0 ? "Recents" : "Recent conversations"}
        </h2>
        {viewAll && items.length > 0 && (
          <Link
            to="/conversations"
            className="font-mono text-[10px] uppercase text-muted-foreground hover:text-foreground transition-colors duration-100 ease-out"
            style={{ letterSpacing: "0.07em" }}
          >
            View all →
          </Link>
        )}
      </div>
      {items.length === 0 ? (
        <span className="px-[6px] text-[12px] text-muted-foreground">Your conversations will appear here</span>
      ) : (
        <div className="flex flex-col gap-[1px]">
          {items.map((item) => (
            <ConversationRow key={item.id} {...item} />
          ))}
        </div>
      )}
    </section>
  );
}
