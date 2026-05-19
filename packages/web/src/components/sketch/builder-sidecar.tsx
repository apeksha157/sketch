/**
 * BuilderSidecar — the chat rail that sits to the right of the builder canvas
 * in Variant B. Same conversation that started on /chat/:id, continued inside
 * the builder. Used only by Variant B.
 *
 * Sized at 400px — wide enough for messages to breathe (Slack thread sidebar
 * ~420, Linear right rail similar) without crowding the form on the left.
 *
 * Messages render without per-message avatars — the sidecar header already
 * carries the Sketch icon + thread title, so repeating the avatar on every
 * reply in a narrow rail becomes noise. Same reasoning as the dock; both
 * compact-chat contexts share the no-avatar pattern. The main chat page
 * (full surface) keeps per-message avatars because it has the vertical space
 * to make the rhythm work.
 *
 * Includes a collapse handle so power users can hide the rail.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { cn } from "@sketch/ui/lib/utils";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";

export interface BuilderSidecarProps {
  threadTitle: string;
  initiallyCollapsed?: boolean;
}

export function BuilderSidecar({ threadTitle, initiallyCollapsed = false }: BuilderSidecarProps) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);

  if (collapsed) {
    return (
      <aside
        className="h-full w-[52px] shrink-0 border-l border-border bg-background"
        style={{ borderLeftWidth: "0.5px" }}
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand chat"
          className={cn(
            "group flex h-full w-full flex-col items-center gap-[16px] py-[14px]",
            "transition-colors duration-150 ease-out cursor-pointer hover:bg-foreground/[0.04]",
          )}
        >
          <span
            className={cn(
              "flex h-[24px] w-[24px] items-center justify-center rounded-[6px]",
              "text-muted-foreground/70 group-hover:text-foreground group-hover:bg-foreground/[0.05] transition-colors duration-100 ease-out",
            )}
            aria-hidden
          >
            <CaretLeftIcon size={11} weight="bold" aria-hidden />
          </span>
          <span className="relative" aria-hidden>
            <img
              src="/logos/sketch-icon-lightmode.png"
              alt=""
              aria-hidden
              className="block h-[22px] w-[22px]"
            />
            <span
              className="absolute -bottom-[2px] -right-[2px] block h-[8px] w-[8px] rounded-full bg-brand-yellow ring-2 ring-background"
              aria-label="New activity in chat"
            />
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-background"
      style={{ borderLeftWidth: "0.5px" }}
    >
      <SidecarHeader threadTitle={threadTitle} onCollapse={() => setCollapsed(true)} />
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
              I want to do a better job celebrating customer wins inside the team. Right now they just sit in a tab no one's looking at.
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
              Slack. There's already a #design-wins channel that's basically tumbleweeds — want to bring it back to life.
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

function SidecarHeader({ threadTitle, onCollapse }: { threadTitle: string; onCollapse: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-[10px] bg-foreground/[0.025] px-[14px] py-[9px]">
      <img src="/logos/sketch-icon-lightmode.png" alt="" aria-hidden className="block h-[16px] w-[16px] shrink-0" />
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/85 leading-tight">
        {threadTitle}
      </h2>
      <button
        type="button"
        onClick={onCollapse}
        aria-label="Collapse chat"
        className={cn(
          "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]",
          "text-muted-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground transition-colors duration-100 ease-out cursor-pointer",
        )}
      >
        <CaretRightIcon size={11} weight="bold" aria-hidden />
      </button>
    </div>
  );
}
