import { CaretDownIcon, CaretUpIcon, PaperPlaneTiltIcon, PaperclipIcon } from "@phosphor-icons/react";
/**
 * BuilderBottomChat — bottom-docked chat panel for Variant A.
 *
 * Sits between the builder's scrollable body and its footer chrome. Edge-to-
 * edge horizontally within the main content area (so it respects the sidebar
 * — collapsed sidebar = wider dock, open sidebar = narrower).
 *
 * Three zones, top-to-bottom — no internal dividers; the shared bg-card and
 * the section's own top border keep it reading as a single panel:
 *   1. Header: avatar + thread title + collapse caret. No metadata clutter —
 *      when the dock is open the messages are right there, so message counts
 *      or timestamps would just be noise.
 *   2. Message history: scrollable, full-width within max-w-6xl. No avatar
 *      on Sketch messages — the dock header's icon does attribution, and
 *      alignment (right pill = user, left text = Sketch) carries the rest.
 *   3. Compact input: single dock-sized input row with inline send button
 *
 * Two states:
 *   - Expanded: ~340px tall.
 *   - Collapsed: ~48px thin strip. Title + freshness chip (e.g. "Sketch · just
 *     now") + small activity dot + expand caret. The chip is a *signal* — who
 *     acted, how recently — which is what a user peeking at a folded panel
 *     actually wants to know. Raw counts ("4 messages") are vanity metrics.
 *
 * Design rationale: there is intentionally no "open in full chat" affordance
 * here. The dock IS the chat — the whole point is that the user can keep
 * talking without leaving the builder. The single way back to the standalone
 * chat surface is the back arrow in the builder header, which is the
 * conventional "leave this page" action.
 *
 * Drag-resize and persistent state across sessions are out of scope for v1.
 */
import { cn } from "@sketch/ui/lib/utils";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface BuilderBottomChatProps {
  threadTitle: string;
  /** Last-activity marker shown in the collapsed strip — e.g. "Sketch · just
   * now", "You · 2m ago". A freshness signal beats a raw message count: the
   * user wants to know whether anything new is waiting for them, not how many
   * total messages exist. */
  lastActivity?: { actor: string; time: string };
}

const MIN_DOCK_HEIGHT = 180;
const MAX_DOCK_HEIGHT = 600;
const DEFAULT_DOCK_HEIGHT = 320;

export function BuilderBottomChat({ threadTitle, lastActivity }: BuilderBottomChatProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_DOCK_HEIGHT);
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null);

  const handleDragMove = useCallback((event: MouseEvent) => {
    if (!dragStateRef.current) return;
    const delta = dragStateRef.current.startY - event.clientY;
    const next = Math.min(MAX_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, dragStateRef.current.startH + delta));
    setHeight(next);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragStateRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", handleDragMove);
    window.removeEventListener("mouseup", handleDragEnd);
  }, [handleDragMove]);

  const handleDragStart = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      dragStateRef.current = { startY: event.clientY, startH: height };
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", handleDragMove);
      window.addEventListener("mouseup", handleDragEnd);
    },
    [height, handleDragMove, handleDragEnd],
  );

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleDragMove);
      window.removeEventListener("mouseup", handleDragEnd);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [handleDragMove, handleDragEnd]);

  if (collapsed) {
    return <CollapsedDock threadTitle={threadTitle} lastActivity={lastActivity} onExpand={() => setCollapsed(false)} />;
  }

  return (
    <section
      className="relative flex shrink-0 flex-col border-t border-border bg-card"
      style={{
        borderTopWidth: "0.5px",
        height,
        boxShadow: "0 -8px 24px -16px rgba(0, 0, 0, 0.08)",
      }}
      aria-label="Chat with Sketch"
    >
      <DragHandle onDragStart={handleDragStart} />
      <DockHeader threadTitle={threadTitle} onCollapse={() => setCollapsed(true)} />
      <MessageList />
      <DockInputZone />
    </section>
  );
}

/**
 * Slim resize affordance pinned to the dock's top edge. Sits just above the
 * header strip so the user can grab and drag without overlapping anything
 * interactive. The visible handle bar only appears on hover — at rest the
 * cursor change is the only signal, which keeps chrome quiet.
 */
function DragHandle({ onDragStart }: { onDragStart: (event: ReactMouseEvent) => void }) {
  return (
    <div
      onMouseDown={onDragStart}
      aria-label="Drag to resize chat"
      className={cn(
        "group absolute inset-x-0 top-0 z-20 flex h-[8px] -translate-y-[4px] cursor-ns-resize items-center justify-center",
      )}
    >
      <span className="h-[3px] w-[36px] rounded-full bg-foreground/10 transition-colors duration-150 ease-out group-hover:bg-foreground/25" />
    </div>
  );
}

// ── Collapsed state ─────────────────────────────────────────────────────────

function CollapsedDock({
  threadTitle,
  lastActivity,
  onExpand,
}: {
  threadTitle: string;
  lastActivity?: { actor: string; time: string };
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className={cn(
        "group flex w-full shrink-0 items-center border-t border-border bg-foreground/[0.025]",
        "text-left transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.04]",
      )}
      style={{ borderTopWidth: "0.5px" }}
      aria-expanded={false}
      aria-label="Expand chat with Sketch"
    >
      <div className="mx-auto flex w-full max-w-6xl items-center gap-[10px] px-[20px] py-[9px]">
        <img src="/logos/sketch-icon-lightmode.png" alt="" aria-hidden className="block h-[16px] w-[16px] shrink-0" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground/85">{threadTitle}</span>
        {lastActivity && (
          <span
            className="ml-auto flex shrink-0 items-center gap-[6px] font-mono text-[10px] uppercase text-muted-foreground/70"
            style={{ letterSpacing: "0.08em" }}
          >
            <span className="block h-[5px] w-[5px] rounded-full bg-brand-yellow/80" aria-hidden />
            {lastActivity.actor} · {lastActivity.time}
          </span>
        )}
        <CaretUpIcon
          size={11}
          weight="bold"
          aria-hidden
          className={cn(
            "shrink-0 text-muted-foreground/60 group-hover:text-foreground transition-colors duration-100 ease-out",
            !lastActivity && "ml-auto",
          )}
        />
      </div>
    </button>
  );
}

// ── Expanded zones ──────────────────────────────────────────────────────────

function DockHeader({ threadTitle, onCollapse }: { threadTitle: string; onCollapse: () => void }) {
  return (
    <div className="shrink-0 bg-foreground/[0.025]">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-[10px] px-[20px] py-[9px]">
        <img src="/logos/sketch-icon-lightmode.png" alt="" aria-hidden className="block h-[18px] w-[18px] shrink-0" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/85 leading-tight">
          {threadTitle}
        </h2>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse chat"
          className={cn(
            "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]",
            "text-muted-foreground/70 hover:text-foreground hover:bg-foreground/[0.05] transition-colors duration-100 ease-out cursor-pointer",
          )}
        >
          <CaretDownIcon size={11} weight="bold" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function MessageList() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-[20px] py-[8px]">
        <div className="flex flex-col gap-[14px]">
          <MiniUserMessage>
            I want to do a better job celebrating customer wins inside the team. Right now they just sit in a tab no
            one's looking at.
          </MiniUserMessage>
          <MiniSketchMessage>
            Which source has the most signal — Trustpilot, the App Store, Intercom, somewhere else?
          </MiniSketchMessage>
          <MiniUserMessage>Trustpilot. The five-star ones especially — those land hardest internally.</MiniUserMessage>
          <MiniSketchMessage>
            Got it. And where should they show up — a Slack channel, a weekly digest, somewhere quieter?
          </MiniSketchMessage>
          <MiniUserMessage>
            Slack. There's already a #design-wins channel that's basically tumbleweeds — want to bring it back to life.
          </MiniUserMessage>
          <MiniSketchMessage>
            Makes sense. Want every five-star review routed there, or only the ones that actually mention design?
          </MiniSketchMessage>
          <MiniUserMessage>
            Whenever we get a five-star Trustpilot review mentioning design, share it in #design-wins.
          </MiniUserMessage>
          <MiniSketchMessage>On it — let me sketch that out.</MiniSketchMessage>
          <MiniUserMessage>Also DM me when one fires, don't want to miss the moment.</MiniUserMessage>
          <MiniSketchMessage>All set — here's the draft. Tweak anything before I save it.</MiniSketchMessage>
          <MiniUserMessage>
            Actually — only reviews longer than two sentences. Don't want to flood it with one-liners.
          </MiniUserMessage>
          <MiniSketchMessage>Smart. Added a min-length filter on the trigger. Anything else?</MiniSketchMessage>
          <MiniUserMessage>And run it daily at 9am instead of instantly.</MiniUserMessage>
          <MiniSketchMessage>
            Batched it to a 9am daily run. Take another look at the canvas — you'll see both changes.
          </MiniSketchMessage>
        </div>
      </div>
    </div>
  );
}

function DockInputZone() {
  return (
    <div className="shrink-0">
      <div className="mx-auto w-full max-w-6xl px-[20px] pt-[6px] pb-[12px]">
        <CompactDockInput placeholder="Reply to Sketch…" />
      </div>
    </div>
  );
}

// ── Compact docked input ────────────────────────────────────────────────────

function CompactDockInput({ placeholder }: { placeholder: string }) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const MIN_H = 26;
  const MAX_H = 120;

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "0px";
    const next = Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight));
    el.style.height = `${next}px`;
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    autosize(e.target);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      setValue("");
      if (taRef.current) autosize(taRef.current);
    }
  }

  const empty = value.trim().length === 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setValue("");
        if (taRef.current) autosize(taRef.current);
      }}
      className={cn(
        "flex items-end gap-[6px] rounded-[12px] border bg-background px-[8px] py-[6px]",
        "border-border focus-within:border-foreground/30 transition-colors duration-150 ease-out",
      )}
      style={{ borderWidth: "0.5px" }}
    >
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          "flex-1 resize-none bg-transparent outline-none py-[3px]",
          "text-[14px] leading-[1.4] text-foreground placeholder:text-muted-foreground",
        )}
        style={{ height: MIN_H, maxHeight: MAX_H }}
        aria-label="Message Sketch"
      />
      <button
        type="button"
        aria-label="Attach file"
        className={cn(
          "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px]",
          "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground transition-colors duration-100 ease-out cursor-pointer",
        )}
      >
        <PaperclipIcon size={14} weight="regular" aria-hidden />
      </button>
      <SendButton disabled={empty} />
    </form>
  );
}

function SendButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label="Send message"
      className={cn(
        "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px]",
        "transition-colors duration-150 ease-out",
        disabled
          ? "text-muted-foreground/40 cursor-not-allowed"
          : "text-foreground hover:bg-foreground/[0.05] cursor-pointer",
      )}
    >
      <PaperPlaneTiltIcon size={14} weight="fill" aria-hidden />
    </button>
  );
}

// ── Mini messages ───────────────────────────────────────────────────────────

function MiniUserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[78%] rounded-[10px] border border-border",
          "bg-[#ebebea] dark:bg-white/[0.06]",
          "px-[13px] py-[7px] text-[13px] text-foreground",
        )}
        style={{ lineHeight: 1.5 }}
      >
        {children}
      </div>
    </div>
  );
}

function MiniSketchMessage({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[78%] text-[13px] text-foreground" style={{ lineHeight: 1.55 }}>
      {children}
    </div>
  );
}
