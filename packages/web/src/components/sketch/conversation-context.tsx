/**
 * ConversationContext — shown at the top of Variant A v3 of the builder.
 *
 * Pain points solved through iteration:
 *   - v1: chat vanished when builder opened → disconnection.
 *   - v2: chat was excerpted as a static card → felt like a breadcrumb, no
 *     way to actually continue chatting without leaving the builder.
 *   - v3: card is a fully live mini-chat. History scrolls inside; a chat
 *     input sits pinned at the bottom of the card. User can keep talking to
 *     Sketch without leaving the builder context. Builder canvas sits below.
 *
 * Different from Variant B (sidecar) because:
 *   - Sidecar = horizontal split, chat occupies the right rail permanently.
 *   - Inline = vertical narrative, chat is the page's top section, builder
 *     gets full canvas width below.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { ArrowSquareOutIcon, ChatsCircleIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

export interface ConversationContextProps {
  /** The chat thread title — same string used as the chat header title. */
  threadTitle: string;
  /** Total message count in the source conversation. */
  messageCount: number;
  /** Affordance to expand the conversation into the full chat surface. */
  onView: () => void;
}

export function ConversationContext({ threadTitle, messageCount, onView }: ConversationContextProps) {
  return (
    <section
      className={cn("flex flex-col overflow-hidden rounded-[12px] border bg-card", "border-border")}
      style={{ borderWidth: "0.5px" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-[12px] px-[20px] pt-[18px]">
        <div className="flex items-center gap-[8px]">
          <ChatsCircleIcon size={13} className="text-muted-foreground" aria-hidden />
          <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.08em" }}>
            From conversation · {messageCount} messages
          </span>
        </div>
        <button
          type="button"
          onClick={onView}
          className={cn(
            "inline-flex items-center gap-[6px] rounded-[6px] px-[8px] py-[4px]",
            "font-mono text-[10px] uppercase text-muted-foreground transition-colors duration-100 ease-out cursor-pointer",
            "hover:text-foreground hover:bg-foreground/[0.04]",
          )}
          style={{ letterSpacing: "0.08em" }}
        >
          Open in full chat
          <ArrowSquareOutIcon size={11} aria-hidden />
        </button>
      </div>

      {/* Thread title */}
      <h3 className="mt-[8px] px-[20px] text-[14px] font-medium text-foreground/85 leading-tight">{threadTitle}</h3>

      {/* Message history — scrollable, capped */}
      <div className="mt-[14px] max-h-[260px] overflow-y-auto px-[20px] pb-[16px]">
        <div className="flex flex-col gap-[14px]">
          <MiniUserMessage>
            Whenever we get a five-star Trustpilot review mentioning design, share it in #design-wins.
          </MiniUserMessage>
          <MiniSketchMessage>On it — let me sketch that out.</MiniSketchMessage>
          <MiniUserMessage>Also DM me when one fires, don't want to miss the moment.</MiniUserMessage>
          <MiniSketchMessage>All set — here's the draft. Tweak anything before I save it.</MiniSketchMessage>
        </div>
      </div>

      {/* Inline chat input — pinned to bottom of card */}
      <div
        className="border-t border-border bg-background/40 px-[14px] pt-[12px] pb-[14px]"
        style={{ borderTopWidth: "0.5px" }}
      >
        <ChatInput placeholder="Tell Sketch what to change…" />
      </div>
    </section>
  );
}

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
    <div className="flex max-w-[78%] items-start gap-[10px]">
      <img
        src="/logos/sketch-icon-light.png"
        alt=""
        aria-label="Sketch"
        className="mt-[1px] block h-[18px] w-[18px] shrink-0"
      />
      <div className="min-w-0 text-[13px] text-foreground" style={{ lineHeight: 1.55 }}>
        {children}
      </div>
    </div>
  );
}
