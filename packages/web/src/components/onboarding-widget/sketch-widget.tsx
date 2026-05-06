import { ArrowSquareOutIcon, ArrowUpIcon, PlayIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WALKTHROUGH_STEPS } from "./steps";
import type { WidgetState } from "./types";
import { useWalkthroughState } from "./use-walkthrough-state";
import { Walkthrough } from "./walkthrough";

const WIDGET_Z = 200;
/** Buffer before the greeting opens, after we know the page is "ready". */
const READY_BUFFER_MS = 250;
/** Hard cap so we never block forever waiting for selectors. */
const READY_TIMEOUT_MS = 3000;

/**
 * Module-level flag: the panel-header avatar wave plays on the first panel open
 * per browser session, and never again until reload. Tooltip mini-avatars and
 * the closing-view avatar are separate "speaking" beats and keep waving on each
 * mount.
 */
let panelOpenedThisSession = false;

/**
 * Wait for every coachmark target to be present in the DOM before showing the
 * greeting. Adds a 250 ms buffer for visual settling, and a 3 s safety net so
 * we never block the greeting indefinitely if a selector ever stops matching.
 */
function waitForReady(callback: () => void) {
  const targets = WALKTHROUGH_STEPS.map((s) => s.selector);
  const start = performance.now();

  const check = () => {
    const allPresent = targets.every((sel) => document.querySelector(sel));
    if (allPresent) {
      window.setTimeout(callback, READY_BUFFER_MS);
      return;
    }
    if (performance.now() - start > READY_TIMEOUT_MS) {
      callback();
      return;
    }
    window.requestAnimationFrame(check);
  };

  check();
}

export function SketchWidget({ firstName }: { firstName: string }) {
  const { state: stored, update } = useWalkthroughState();
  const [ui, setUi] = useState<WidgetState>({ kind: "collapsed" });
  const [mounted, setMounted] = useState(false);
  const [postCompletePulse, setPostCompletePulse] = useState(false);

  // First-open avatar wave control. Captured in a ref so re-renders don't toggle it.
  const panelHasOpened = useRef(panelOpenedThisSession);

  // Decide initial UI state once stored state has been read on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  useEffect(() => {
    setMounted(true);
    if (stored.has_completed_walkthrough) {
      setUi({ kind: "collapsed" });
      return;
    }
    if (stored.walkthrough_paused && stored.current_walkthrough_step != null) {
      const step = stored.current_walkthrough_step;
      if (step >= 1 && step <= 4) {
        setUi({ kind: "paused", step: step as 1 | 2 | 3 | 4 });
        return;
      }
    }
    if (stored.current_walkthrough_step != null) {
      const step = stored.current_walkthrough_step;
      if (step >= 1 && step <= 4) {
        setUi({ kind: "walkthrough", step: step as 1 | 2 | 3 | 4 });
        return;
      }
    }
    let cancelled = false;
    waitForReady(() => {
      if (cancelled) return;
      setUi({ kind: "greeting" });
      update({ has_seen_greeting: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!mounted) return null;

  // Track when a panel state has actually rendered for the first time so the
  // avatar wave only runs on its very first appearance.
  const isPanelState = ui.kind === "greeting" || ui.kind === "closing" || ui.kind === "post-tour";
  if (isPanelState && !panelHasOpened.current) {
    panelHasOpened.current = true;
    panelOpenedThisSession = true;
  }
  const animatePanelAvatar = isPanelState && !panelOpenedThisSession;

  const startTour = () => {
    setUi({ kind: "walkthrough", step: 1 });
    update({ current_walkthrough_step: 1, walkthrough_paused: false });
  };

  const advanceTour = () => {
    if (ui.kind !== "walkthrough") return;
    if (ui.step === 4) {
      setUi({ kind: "closing" });
      update({ current_walkthrough_step: null });
    } else {
      const next = (ui.step + 1) as 1 | 2 | 3 | 4;
      setUi({ kind: "walkthrough", step: next });
      update({ current_walkthrough_step: next });
    }
  };

  /** Pause mid-tour (click outside the tooltip). Step is preserved; a Resume
   *  pill appears next to the bubble. Does NOT mark complete. */
  const pauseTour = () => {
    if (ui.kind !== "walkthrough") return;
    setUi({ kind: "paused", step: ui.step });
    update({ walkthrough_paused: true });
  };

  const resumeTour = () => {
    if (ui.kind !== "paused") return;
    setUi({ kind: "walkthrough", step: ui.step });
    update({ walkthrough_paused: false });
  };

  /** Dismiss the Resume pill — user no longer wants to continue, but doesn't
   *  count as completing the tour. They can still replay from post-tour later
   *  (post-tour requires `has_completed_walkthrough` though, so we mark `_dismissed`
   *  count instead and clear the paused/step state). */
  const dismissPill = () => {
    setUi({ kind: "collapsed" });
    update({
      walkthrough_paused: false,
      current_walkthrough_step: null,
      walkthrough_dismissed_count: stored.walkthrough_dismissed_count + 1,
    });
  };

  const dismissGreeting = () => {
    setUi({ kind: "collapsed" });
    update({ walkthrough_dismissed_count: stored.walkthrough_dismissed_count + 1 });
  };

  const completeTour = () => {
    setUi({ kind: "collapsed" });
    update({ has_completed_walkthrough: true, current_walkthrough_step: null, walkthrough_paused: false });
    setPostCompletePulse(true);
    window.setTimeout(() => setPostCompletePulse(false), 700);
  };

  const skipTour = () => {
    setUi({ kind: "collapsed" });
    update({ has_completed_walkthrough: true, current_walkthrough_step: null, walkthrough_paused: false });
  };

  const replayTour = () => {
    setUi({ kind: "walkthrough", step: 1 });
    update({ current_walkthrough_step: 1, has_completed_walkthrough: false, walkthrough_paused: false });
  };

  const openWidget = () => {
    if (stored.has_completed_walkthrough) {
      setUi({ kind: "post-tour" });
    } else {
      setUi({ kind: "greeting" });
    }
  };

  const collapse = () => setUi({ kind: "collapsed" });

  const showBubble = ui.kind === "collapsed" || ui.kind === "paused";
  const showPill = ui.kind === "paused";
  const showPanel = isPanelState;
  const pulseBubble = showBubble && (!stored.has_seen_greeting || postCompletePulse);

  return createPortal(
    <>
      {ui.kind === "walkthrough" ? (
        <Walkthrough stepIndex={ui.step} onNext={advanceTour} onPause={pauseTour} onSkip={skipTour} />
      ) : null}

      {showPanel ? (
        <Panel onClose={collapse}>
          {ui.kind === "greeting" ? (
            <GreetingView firstName={firstName} onStart={startTour} onDismiss={dismissGreeting} />
          ) : null}
          {ui.kind === "closing" ? <ClosingView onReplay={replayTour} onDone={completeTour} /> : null}
          {ui.kind === "post-tour" ? <PostTourView onReplay={replayTour} animateAvatar={animatePanelAvatar} /> : null}
        </Panel>
      ) : null}

      {showPill && ui.kind === "paused" ? (
        <ResumePill step={ui.step} total={4} onResume={resumeTour} onDismiss={dismissPill} />
      ) : null}

      {showBubble ? <Bubble pulse={pulseBubble} onClick={ui.kind === "paused" ? resumeTour : openWidget} /> : null}

      <WidgetStyles />
    </>,
    document.body,
  );
}

// ── Bubble ───────────────────────────────────────────────────────────────────

function Bubble({ pulse, onClick }: { pulse: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open Sketch assistant"
      className={cn(
        "group fixed bottom-6 right-6 flex size-14 items-center justify-center rounded-full bg-[#FEED01] transition-transform duration-200 ease-out hover:scale-110 active:scale-95",
        "shadow-[0_4px_18px_rgba(254,237,1,0.45),0_2px_8px_rgba(0,0,0,0.18)] sketch-bubble-halo",
        pulse && "sketch-bubble-pulse",
      )}
      style={{ zIndex: WIDGET_Z }}
    >
      <img
        src="/logos/sketch-icon-lightmode.png"
        alt=""
        className="size-9 transition-transform duration-300 ease-out group-hover:rotate-[-8deg]"
      />
    </button>
  );
}

// ── Resume pill ──────────────────────────────────────────────────────────────

/**
 * Yellow pill that surfaces above the bubble when the tour is paused. Clicking
 * the pill body resumes; clicking the × dismisses without marking complete.
 *
 * Sits at bottom-24 right-6 — clear of the bubble (which is at bottom-6).
 */
function ResumePill({
  step,
  total,
  onResume,
  onDismiss,
}: {
  step: number;
  total: number;
  onResume: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="sketch-pill-enter fixed bottom-24 right-6 flex items-center gap-1 rounded-full bg-[#FEED01] py-1.5 pl-3 pr-1.5 text-xs font-medium text-[#1a1a18] shadow-[0_4px_14px_rgba(254,237,1,0.45),0_2px_6px_rgba(0,0,0,0.18)]"
      style={{ zIndex: WIDGET_Z }}
    >
      <button
        type="button"
        onClick={onResume}
        className="flex items-center gap-1.5 transition-opacity hover:opacity-80"
      >
        <PlayIcon size={12} weight="fill" />
        <span>
          Resume ({step}/{total})
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss tour"
        className="flex size-5 items-center justify-center rounded-full text-[#1a1a18]/60 transition-colors hover:bg-[#1a1a18]/10 hover:text-[#1a1a18]"
      >
        <XIcon size={11} weight="bold" />
      </button>
    </div>
  );
}

// ── Panel shell ──────────────────────────────────────────────────────────────

function Panel({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      aria-label="Sketch assistant"
      className={cn(
        "sketch-panel-enter fixed bottom-6 right-6 flex w-[300px] flex-col overflow-hidden rounded-[14px] bg-background",
        // Yellow accent rail at the top — single highest-impact visibility cue,
        // ties the panel back to the bubble's brand color.
        "border-t-[2.5px] border-t-[#FEED01] border-x border-b border-border/60",
        // Light shadow + dark-mode equivalent with a subtle 1px outline for edge definition.
        "shadow-[0_4px_20px_rgba(0,0,0,0.08)]",
        "dark:bg-[#252522] dark:shadow-[0_8px_32px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.08)]",
      )}
      style={{ zIndex: WIDGET_Z, maxHeight: 420 }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-3">
        <div className="flex items-center gap-2">
          {/* Avatar's wave is controlled by the parent — only first open per session. */}
          <SketchAvatar animate={false} />
          <span className="text-sm font-medium">Sketch</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <XIcon size={14} />
        </button>
      </header>
      <div className="flex min-h-0 flex-col">{children}</div>
    </div>
  );
}

function SketchAvatar({ size = "sm", animate = true }: { size?: "sm" | "md"; animate?: boolean }) {
  const dim = size === "md" ? "size-7" : "size-6";
  const icon = size === "md" ? "size-5" : "size-4";
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-[#FEED01]",
        animate && "sketch-avatar-wave",
        dim,
      )}
    >
      <img src="/logos/sketch-icon-lightmode.png" alt="" className={icon} />
    </div>
  );
}

// ── Panel views ──────────────────────────────────────────────────────────────

function GreetingView({
  firstName,
  onStart,
  onDismiss,
}: {
  firstName: string;
  onStart: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
        Hey {firstName}! I'm Sketch — your AI assistant. I work from Slack, but this dashboard is your control center.
        Want me to show you around?
      </p>

      <div className="mt-1 flex flex-col gap-2.5">
        <button
          type="button"
          onClick={onStart}
          className="w-full rounded-md bg-[#1a1a18] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2a2a26]"
        >
          Show me around
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}

function ClosingView({ onReplay, onDone }: { onReplay: () => void; onDone: () => void }) {
  const [celebrating, setCelebrating] = useState(false);

  const handleDone = () => {
    setCelebrating(true);
    window.setTimeout(onDone, 600);
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Closing reads as a chat-style message from Sketch — same bubble shape
          as the assistant messages in chat mode. Header avatar already provides
          the sender identity, no inline avatar needed. */}
      <p className="rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
        That's the tour! The checklist on your right is a great place to start — or just say hi on Slack. I'm here
        whenever you need me.
      </p>
      <div className="mt-1 flex flex-col gap-2.5">
        <button
          type="button"
          onClick={handleDone}
          disabled={celebrating}
          className="w-full rounded-md bg-[#1a1a18] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2a2a26] disabled:opacity-70"
        >
          {celebrating ? "✓" : "Got it ✓"}
        </button>
        <button
          type="button"
          onClick={onReplay}
          disabled={celebrating}
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Replay tour
        </button>
      </div>
    </div>
  );
}

// ── Post-tour: compact greeting + functional chat ───────────────────────────

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  cta?: { label: string; href: string };
}

/** Canned fallback response — used until real chat plumbing lands. */
const FALLBACK_RESPONSE: Omit<ChatMessage, "id"> = {
  role: "assistant",
  text: "I'm not available here yet — message me on Slack and I'll get right back to you!",
  cta: { label: "Open Slack →", href: "slack://open" },
};

function PostTourView({ onReplay, animateAvatar }: { onReplay: () => void; animateAvatar: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const messageIdRef = useRef(0);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest message whenever messages or typing change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive when to re-scroll
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, typing]);

  const sendMessage = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const userMsg: ChatMessage = { id: ++messageIdRef.current, role: "user", text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setTyping(true);
    window.setTimeout(() => {
      setMessages((prev) => [...prev, { id: ++messageIdRef.current, ...FALLBACK_RESPONSE }]);
      setTyping(false);
    }, 900);
  };

  const inChatMode = messages.length > 0;

  return (
    <div className="flex min-h-0 flex-col">
      {!inChatMode ? (
        <>
          <div className="px-4 pt-4 pb-3.5">
            <p className="text-sm leading-relaxed text-muted-foreground">Ask me anything here, or try one of these:</p>
          </div>

          <div className="border-t border-border/40 px-4 pt-3 pb-3.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Quick actions</p>
            <ul className="mt-2 flex flex-col gap-1.5 pl-0.5">
              <li>
                <button
                  type="button"
                  onClick={onReplay}
                  className="flex items-center gap-2 text-left text-xs font-medium text-[#8B7A00] transition-colors hover:underline dark:text-[#FEED01]"
                >
                  <PlayIcon size={12} weight="fill" />
                  <span>Replay walkthrough</span>
                </button>
              </li>
              <li>
                <a
                  href="slack://open"
                  className="flex items-center gap-2 text-left text-xs font-medium text-[#8B7A00] transition-colors hover:underline dark:text-[#FEED01]"
                >
                  <ArrowSquareOutIcon size={12} />
                  <span>Open Slack</span>
                </a>
              </li>
            </ul>
          </div>
        </>
      ) : (
        <ChatHistory ref={scrollerRef} messages={messages} typing={typing} animateAvatar={animateAvatar} />
      )}

      <div className={cn("border-t border-border/40 px-3 pt-3.5 pb-3", inChatMode && "pt-3")}>
        <ChatInput inChatMode={inChatMode} onSend={sendMessage} />
      </div>
    </div>
  );
}

const ChatHistory = ({
  ref,
  messages,
  typing,
  animateAvatar,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  messages: ChatMessage[];
  typing: boolean;
  animateAvatar: boolean;
}) => (
  <div
    ref={ref}
    className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto border-t border-border/40 px-3 pt-3 pb-1"
    style={{ maxHeight: 280 }}
  >
    {messages.map((m, i) => (
      <ChatBubble key={m.id} message={m} animateAvatar={animateAvatar && i === 0} />
    ))}
    {typing ? <TypingIndicator /> : null}
  </div>
);

function ChatBubble({ message, animateAvatar }: { message: ChatMessage; animateAvatar: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[78%] rounded-2xl rounded-tr-sm bg-[#1a1a18] px-3 py-2 text-xs leading-snug text-white">
          {message.text}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#FEED01]",
          animateAvatar && "sketch-avatar-wave",
        )}
      >
        <img src="/logos/sketch-icon-lightmode.png" alt="" className="size-3" />
      </div>
      <div className="flex max-w-[80%] flex-col gap-1">
        <p className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-xs leading-snug text-foreground">
          {message.text}
        </p>
        {message.cta ? (
          <a
            href={message.cta.href}
            className="self-start text-xs font-medium text-[#8B7A00] transition-colors hover:underline dark:text-[#FEED01]"
          >
            {message.cta.label}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#FEED01]">
        <img src="/logos/sketch-icon-lightmode.png" alt="" className="size-3" />
      </div>
      <div className="flex h-7 items-center gap-1 rounded-2xl rounded-tl-sm bg-muted px-3">
        <span className="size-1.5 animate-typing-dot rounded-full bg-foreground/40 [animation-delay:0ms]" />
        <span className="size-1.5 animate-typing-dot rounded-full bg-foreground/40 [animation-delay:150ms]" />
        <span className="size-1.5 animate-typing-dot rounded-full bg-foreground/40 [animation-delay:300ms]" />
      </div>
    </div>
  );
}

const PLACEHOLDERS = [
  "Ask Sketch anything…",
  "Try: summarize my last meeting",
  "Try: what skills can I use?",
  "Try: set up a daily report",
  "Try: who's on my team?",
];

function ChatInput({ inChatMode, onSend }: { inChatMode: boolean; onSend: (text: string) => void }) {
  const [value, setValue] = useState("");
  const [phIndex, setPhIndex] = useState(0);
  const [phFading, setPhFading] = useState(false);
  const [focused, setFocused] = useState(false);

  // Rotate placeholders only on the initial post-tour view (not in chat mode).
  useEffect(() => {
    if (focused || value.length > 0 || inChatMode) return;
    const interval = window.setInterval(() => {
      setPhFading(true);
      window.setTimeout(() => {
        setPhIndex((i) => (i + 1) % PLACEHOLDERS.length);
        setPhFading(false);
      }, 280);
    }, 3300);
    return () => window.clearInterval(interval);
  }, [focused, value, inChatMode]);

  const placeholder = inChatMode ? "Type a message…" : PLACEHOLDERS[phIndex];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend(value);
        setValue("");
      }}
      className="relative"
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={{ ["--ph-opacity" as string]: phFading && !inChatMode ? 0 : 1 }}
        className={cn(
          "h-9 w-full rounded-lg bg-background px-3 pr-9 text-xs outline-none",
          // Border + dark-mode contrast pass.
          "border border-border focus:border-foreground/30",
          "dark:border-white/15 dark:bg-white/[0.04] dark:placeholder:text-white/45",
          "placeholder:text-muted-foreground placeholder:transition-opacity placeholder:duration-300",
          "[&::placeholder]:opacity-[var(--ph-opacity)]",
        )}
      />
      <button
        type="submit"
        aria-label="Send"
        className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowUpIcon size={12} weight="bold" />
      </button>
    </form>
  );
}

// ── Animations ───────────────────────────────────────────────────────────────

function WidgetStyles() {
  return (
    <style>{`
      /* First-load attention: single pulse so the bubble announces itself once. */
      @keyframes sketch-bubble-pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.08); }
        100% { transform: scale(1); }
      }
      .sketch-bubble-pulse { animation: sketch-bubble-pulse 600ms ease-in-out 1; }

      /* Continuous, slow halo breathing on the bubble. */
      @keyframes sketch-bubble-halo {
        0%, 100% { box-shadow: 0 4px 18px rgba(254, 237, 1, 0.45), 0 2px 8px rgba(0, 0, 0, 0.18); }
        50% { box-shadow: 0 6px 24px rgba(254, 237, 1, 0.65), 0 2px 8px rgba(0, 0, 0, 0.18); }
      }
      .sketch-bubble-halo { animation: sketch-bubble-halo 3.6s ease-in-out infinite; }

      @keyframes sketch-panel-enter {
        from { opacity: 0; transform: scale(0.92) translateY(8px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .sketch-panel-enter { animation: sketch-panel-enter 240ms cubic-bezier(0.34, 1.56, 0.64, 1); transform-origin: bottom right; }

      @keyframes sketch-pill-enter {
        from { opacity: 0; transform: translateY(-6px) scale(0.95); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .sketch-pill-enter { animation: sketch-pill-enter 200ms cubic-bezier(0.34, 1.56, 0.64, 1); transform-origin: bottom right; }

      @keyframes walkthrough-overlay-fade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .walkthrough-overlay-fade { animation: walkthrough-overlay-fade 300ms ease-out; }

      @keyframes walkthrough-tooltip-enter {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .walkthrough-tooltip-enter { animation: walkthrough-tooltip-enter 250ms cubic-bezier(0.4, 0, 0.2, 1); }

      @keyframes sketch-avatar-wave {
        0%, 100% { transform: rotate(0deg); }
        25% { transform: rotate(-8deg); }
        75% { transform: rotate(8deg); }
      }
      .sketch-avatar-wave { animation: sketch-avatar-wave 700ms ease-in-out 1; transform-origin: center; }

      @keyframes walkthrough-step-exit {
        from { opacity: 1; transform: translateY(0); }
        to   { opacity: 0; transform: translateY(-6px); }
      }
      .walkthrough-step-exit { animation: walkthrough-step-exit 160ms ease-in forwards; }

      @keyframes walkthrough-highlight-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.55; }
      }
      .walkthrough-highlight-pulse { animation: walkthrough-highlight-pulse 2s ease-in-out infinite; }

      @keyframes tour-complete-spin {
        0%   { transform: rotate(0deg) scale(1); }
        40%  { transform: rotate(180deg) scale(1.15); }
        70%  { transform: rotate(360deg) scale(1.05); }
        100% { transform: rotate(360deg) scale(1); }
      }
      .tour-complete-spin { animation: tour-complete-spin 600ms cubic-bezier(0.4, 0, 0.2, 1) 1; transform-origin: center; }

      /* Typing indicator dots — three bounce in sequence. */
      @keyframes typing-dot {
        0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
        40%           { opacity: 0.9; transform: translateY(-2px); }
      }
      .animate-typing-dot { animation: typing-dot 1.2s ease-in-out infinite; }

      /* Reduced-motion: kill non-essential animations. Entry/exit fades stay. */
      @media (prefers-reduced-motion: reduce) {
        .sketch-bubble-halo,
        .sketch-bubble-pulse,
        .sketch-avatar-wave,
        .tour-complete-spin,
        .walkthrough-highlight-pulse,
        .animate-typing-dot {
          animation: none !important;
        }
      }
    `}</style>
  );
}
