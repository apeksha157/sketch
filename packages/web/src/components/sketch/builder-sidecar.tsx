/**
 * BuilderSidecar — the chat rail that sits to the left of the builder canvas.
 * Same conversation that started on /chat/:id, continued inside the builder.
 *
 * Chat is the lead surface and is always present: in Sketch automations are only
 * authored through chat (no manual canvas creation), so unlike Canvas there is no
 * reason to collapse the rail. It stays persistent.
 *
 * Sized at 400px — wide enough for messages to breathe (Slack thread sidebar
 * ~420, Linear rail similar) without crowding the canvas next to it.
 *
 * Messages render without per-message avatars — the sidecar header already
 * carries the Sketch icon + thread title, so repeating the avatar on every
 * reply in a narrow rail becomes noise.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

export interface BuilderSidecarProps {
  threadTitle: string;
}

export function BuilderSidecar({ threadTitle }: BuilderSidecarProps) {
  return (
    <aside
      className="relative flex h-full w-[400px] shrink-0 flex-col border-r border-border bg-background"
      style={{ borderRightWidth: "0.5px" }}
    >
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

/** Sidecar header — icon + thread title only. */
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
