/**
 * Chat message bubbles + streaming caret — §4.17.
 *
 * User messages are right-aligned bubbles. Sketch messages are left-aligned with
 * a 24×24 yellow logo avatar and no bubble background — the avatar carries the
 * identity and the text reads as a quiet response.
 */
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[78%] inline-flex items-center gap-[8px] rounded-[12px] border border-border",
          "bg-[#ebebea] dark:bg-white/[0.06]",
          "px-[16px] py-[10px] text-[14px] text-foreground",
        )}
        style={{ lineHeight: 1.5 }}
      >
        {children}
      </div>
    </div>
  );
}

export function SketchMessage({ children, streaming }: { children: ReactNode; streaming?: boolean }) {
  return (
    <div className="flex max-w-[78%] items-start gap-[12px]">
      <img
        src="/logos/sketch-icon-lightmode.png"
        alt=""
        aria-label="Sketch"
        className="mt-[2px] block h-[24px] w-[24px] shrink-0"
      />
      <div className="min-w-0 flex-1 text-[14px] text-foreground" style={{ lineHeight: 1.7 }}>
        {children}
        {streaming && <StreamingIndicator />}
      </div>
    </div>
  );
}

/**
 * Streaming indicator — "Sketch is still typing" / "more text coming."
 *
 * Three small dots pulsing in sequence is the chat-native idiom for this
 * (iMessage, Slack, Messenger all converge on it). It reads as a true
 * indicator rather than as continuation marker, which the earlier block
 * cursor implementation conflated. The dots inherit `sketch-caret-pulse`
 * (opacity-only loop) with staggered delays so they wave, not blink.
 *
 * aria-label sits on the wrapper so screen readers announce the streaming
 * state once, not three times for three dots.
 */
function StreamingIndicator() {
  return (
    <output className="ml-[6px] inline-flex items-center gap-[3px] align-[2px]" aria-label="Sketch is still typing">
      {[0, 0.18, 0.36].map((delay, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: positional dots, never reorder
          key={i}
          className="block h-[4px] w-[4px] rounded-full bg-foreground/55"
          style={{ animation: `sketch-caret-pulse 1.2s ease-in-out ${delay}s infinite` }}
          aria-hidden
        />
      ))}
    </output>
  );
}
