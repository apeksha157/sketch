/**
 * BuilderSidecar — the chat rail that sits to the left of the builder canvas.
 * Same conversation that started on /chat/:id, continued inside the builder.
 *
 * Chat is the lead surface; the canvas (right of this rail) owns the working
 * area and its own future right-edge details panel.
 *
 * Sized at 400px — wide enough for messages to breathe (Slack thread sidebar
 * ~420, Linear rail similar) without crowding the canvas next to it.
 *
 * Messages render without per-message avatars — the sidecar header already
 * carries the Sketch icon + thread title, so repeating the avatar on every
 * reply in a narrow rail becomes noise. Same reasoning as the dock; both
 * compact-chat contexts share the no-avatar pattern. The main chat page
 * (full surface) keeps per-message avatars because it has the vertical space
 * to make the rhythm work.
 *
 * Collapsed state renders a 88px ComposerCard with a Tab pull-handle for
 * expanding — see ComposerCard + ExpandToggle.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { ExpandToggle } from "@/components/sketch/expand-toggle";
import { ChatIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { type ReactNode, useState } from "react";

/** Helper for the rail click-to-expand: was the click on an existing button/link? */
function isOnInteractiveElement(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, a, [role="button"]'));
}

export interface BuilderSidecarProps {
  threadTitle: string;
  initiallyCollapsed?: boolean;
}

export function BuilderSidecar({ threadTitle, initiallyCollapsed = false }: BuilderSidecarProps) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);

  if (collapsed) {
    return <ComposerCard onExpand={() => setCollapsed(false)} />;
  }

  return (
    <aside
      className="group/rail relative flex h-full w-[400px] shrink-0 flex-col border-r border-border bg-background"
      style={{ borderRightWidth: "0.5px" }}
    >
      {/* Collapse toggle — same right-edge midpoint position as the
       * collapsed-state Tab. Only the chevron direction flips. */}
      <ExpandToggle onClick={() => setCollapsed(true)} ariaLabel="Collapse chat" direction="left" />
      <SidecarHeader threadTitle={threadTitle} />
      <div className="relative min-h-0 flex-1">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[24px] bg-gradient-to-b from-background to-transparent"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[24px] bg-gradient-to-t from-background to-transparent"
          aria-hidden
        />
        <div className="absolute inset-0 overflow-y-auto px-[16px] py-[14px]">
          <div className="flex flex-col gap-[16px]">
            <SidecarUserMessage>
              I want to do a better job celebrating customer wins inside the team. Right now they just sit in a tab no
              one's looking at.
            </SidecarUserMessage>
            <SidecarSketchMessage>
              Which source has the most signal — Trustpilot, the App Store, Intercom, somewhere else?
            </SidecarSketchMessage>
            <SidecarUserMessage>
              Trustpilot. The five-star ones especially — those land hardest internally.
            </SidecarUserMessage>
            <SidecarSketchMessage>
              Got it. And where should they show up — a Slack channel, a weekly digest, somewhere quieter?
            </SidecarSketchMessage>
            <SidecarUserMessage>
              Slack. There's already a #design-wins channel that's basically tumbleweeds — want to bring it back to
              life.
            </SidecarUserMessage>
            <SidecarSketchMessage>
              Makes sense. Want every five-star review routed there, or only the ones that actually mention design?
            </SidecarSketchMessage>
            <SidecarUserMessage>
              Whenever we get a five-star Trustpilot review mentioning design, share it in #design-wins.
            </SidecarUserMessage>
            <SidecarSketchMessage>On it — let me sketch that out.</SidecarSketchMessage>
            <SidecarUserMessage>Also DM me when one fires, don't want to miss the moment.</SidecarUserMessage>
            <SidecarSketchMessage>All set — here's the draft. Tweak anything before I save it.</SidecarSketchMessage>
            <SidecarUserMessage>
              Actually — only reviews longer than two sentences. Don't want to flood it with one-liners.
            </SidecarUserMessage>
            <SidecarSketchMessage>Smart. Added a min-length filter on the trigger. Anything else?</SidecarSketchMessage>
            <SidecarUserMessage>And run it daily at 9am instead of instantly.</SidecarUserMessage>
            <SidecarSketchMessage>
              Batched it to a 9am daily run. Take another look at the canvas — you'll see both changes.
            </SidecarSketchMessage>
          </div>
        </div>
      </div>
      <div className="shrink-0 bg-background px-[14px] pt-[10px] pb-[14px]">
        <ChatInput placeholder="Reply to Sketch…" />
      </div>
    </aside>
  );
}

function SidecarUserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[82%] rounded-[12px] border border-border",
          "bg-[#ebebea] dark:bg-white/[0.06]",
          "px-[14px] py-[8px] text-[13.5px] text-foreground",
        )}
        style={{ lineHeight: 1.55 }}
      >
        {children}
      </div>
    </div>
  );
}

function SidecarSketchMessage({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[90%] text-[13.5px] text-foreground" style={{ lineHeight: 1.6 }}>
      {children}
    </div>
  );
}

/**
 * Sidecar header — icon + thread title only. The collapse affordance is
 * NOT here; it lives as the floating <ExpandToggle /> on the rail's right
 * edge in both expanded and collapsed states (one predictable location).
 */
function SidecarHeader({ threadTitle }: { threadTitle: string }) {
  return (
    <div className="flex shrink-0 items-center gap-[10px] bg-foreground/[0.025] px-[14px] py-[9px]">
      <img src="/logos/sketch-icon-lightmode.png" alt="" aria-hidden className="block h-[16px] w-[16px] shrink-0" />
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/85 leading-tight">
        {threadTitle}
      </h2>
    </div>
  );
}

/**
 * ComposerCard — the chat rail in its contracted state.
 *
 * 88px wide. Inspired by Cursor's Composer-as-panel and shadcn's
 * collapsed-rail (48–64px) pattern. Reads as a *participant*, not a nav
 * rail: bg-card chrome with subtle elevation, a Tab pull-handle on the
 * right edge, a persistent "Reply" capsule at the bottom (mirrors the
 * chat input's vertical slot in the expanded state).
 *
 * The whole rail is click-to-expand on empty space — bails out if the
 * click landed on an existing button/link so the Reply / Tab keep their
 * own handlers without double-firing.
 */
function ComposerCard({ onExpand }: { onExpand: () => void }) {
  /**
   * Click/Enter/Space anywhere on empty rail space expands. Bails out if the
   * target landed on a real button/link so nested affordances keep their own
   * handlers without double-firing. The keyboard branch is required so the
   * mouse-convenience behaviour has a parity for assistive tech, even though
   * the aside itself isn't tab-focusable (the ExpandToggle button is).
   */
  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (isOnInteractiveElement(event.target)) return;
    onExpand();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isOnInteractiveElement(event.target)) return;
    event.preventDefault();
    onExpand();
  };
  return (
    <aside
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        // `group/rail` lets the ExpandToggle react to hovers on the whole rail.
        "group/rail relative flex h-full w-[88px] shrink-0 flex-col items-center cursor-pointer",
        "border-r border-border bg-card px-[10px] py-[18px]",
      )}
      style={{ borderRightWidth: "0.5px", boxShadow: "1px 0 0 0 rgba(0,0,0,0.02)" }}
    >
      <ExpandToggle onClick={onExpand} ariaLabel="Expand chat" />

      {/* Top slot — passive status. Mirrors the expanded SidecarHeader's
       * vertical position (top of panel = "what state is this thread in").
       * Mock state for the demo: "READY" with the emerald dot. In production
       * this is driven by live agent state — idle/working/attention.
       *
       * No Sketch logo / "SKETCH" eyebrow on top: the workspace sidebar
       * immediately to the left already carries the org brand. Status pill
       * does the identity work via shape + colour, not via the brand mark. */}
      <div className="flex flex-col items-center gap-[6px]">
        <div className="flex items-center gap-[6px] rounded-full bg-background px-[8px] py-[3px] ring-1 ring-border">
          <span className="block h-[6px] w-[6px] rounded-full bg-emerald-500" aria-hidden />
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-foreground/80">Ready</span>
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70">2m</span>
      </div>

      {/* "Reply" composer capsule — anchored to the bottom so it mirrors the
       * chat input's position in the expanded state. `mt-auto` pushes it down
       * past the breathing room in the middle. */}
      <button
        type="button"
        onClick={onExpand}
        aria-label="Continue chat"
        className={cn(
          "group mt-auto flex w-full flex-col items-center gap-[6px] rounded-[10px]",
          "border border-border bg-background px-[6px] py-[10px] cursor-pointer",
          "transition-colors duration-100 ease-out hover:bg-foreground/[0.04]",
        )}
      >
        <ChatIcon
          size={14}
          weight="regular"
          aria-hidden
          className="text-muted-foreground/80 group-hover:text-foreground"
        />
        <span className="text-[10px] text-muted-foreground/75 group-hover:text-foreground">Reply</span>
      </button>
    </aside>
  );
}
