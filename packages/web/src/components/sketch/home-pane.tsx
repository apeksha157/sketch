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
import { Greeting } from "@/components/sketch/greeting";
import { TileGrid, getDefaultTiles } from "@/components/sketch/tile-grid";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

export interface HomePaneProps {
  firstName: string;
  /** User role — feeds the Greeting variety pool (admin/member designations). */
  role?: "admin" | "member";
  /** Total people on the workspace. <=1 means solo — surfaces "Invite a
   * teammate" in the tile grid; >=2 swaps that slot for an integration prompt. */
  teamSize?: number;
  /** Recent conversations, capped to 5 in the recents section (§5.2). */
  recents: ConversationRowProps[];
  /** Disables input + chips + tiles for paused states (§5.7). */
  disabled?: boolean;
  /** Renders the celebration card between chip row and tile grid (§5.10). */
  celebration?: { onDismiss: () => void };
  /** Override the chat submit — used to navigate to /chat/:new. */
  onSubmit?: ChatInputProps["onSubmit"];
  /** Override the "Show me what's possible" tile. */
  onShowPossibilities?: () => void;
}

/**
 * Wrapper sizing copied verbatim from /old/home/member's container so the new
 * and old surfaces share the same content rhythm:
 *   mx-auto max-w-4xl px-10 py-5  ── 896px max, 40px gutters, 20px top/bottom.
 *
 * Vertical rhythm: hero (greeting + input + chips) flows naturally from the top
 * with a `pt-14` runway, then a single `mt-8` step into the below-fold rail.
 * No `min-h-[Nvh]` + `justify-center` — that pattern leaves the chat input
 * floating in dead space on tall viewports.
 */
export function HomePane({ firstName, role, teamSize, recents, disabled, celebration, onSubmit }: HomePaneProps) {
  const tiles = getDefaultTiles(teamSize);
  const inputRef = useRef<HTMLInputElement>(null);
  const [prefill, setPrefill] = useState<string>("");

  function handleChip(chip: ChipSuggestion) {
    setPrefill(chip.prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-10 pt-14 pb-10">
      {/* Hero — greeting + chat input + chip row. Flows from the top of the
       * content column; the pt-14 above gives it a comfortable runway without
       * pushing tiles below the fold. */}
      <section className="flex flex-col">
        <Greeting firstName={firstName} role={role} />
        <div className="mt-7 flex flex-col gap-3">
          <ChatInput ref={inputRef} key={prefill} initialValue={prefill} disabled={disabled} onSubmit={onSubmit} />
          <ChipRow onPick={handleChip} disabled={disabled} />
        </div>
      </section>

      {/* Below-the-fold rail — labeled sections under the hero. Sits 48px below
       * the chip row so the section headings get a clear runway and the page
       * resolves into hero → Quick actions → Recents instead of pill-soup. */}
      <div className="mt-12 flex flex-col gap-7">
        {celebration && <CelebrationCard onDismiss={celebration.onDismiss} />}
        <QuickActions tiles={tiles} disabled={disabled} />
        <Recents conversations={recents} />
      </div>
    </div>
  );
}

interface QuickActionsProps {
  tiles: ReturnType<typeof getDefaultTiles>;
  disabled?: boolean;
  className?: string;
}

function QuickActions({ tiles, disabled, className }: QuickActionsProps) {
  return (
    <section className={cn("flex flex-col", className)}>
      <div className="mb-[10px] flex items-baseline justify-between px-[6px]">
        <h2 className="font-mono text-xs uppercase text-foreground" style={{ letterSpacing: "0.08em" }}>
          Quick actions
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
