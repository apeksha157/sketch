/**
 * /chat/$conversationId — §5.6. The active conversation surface.
 *
 * Wires title + channel from MOCK_ALL_CONVERSATIONS by id so every row in
 * /conversations lands on a chat with the correct header — instead of the
 * earlier hardcoded "Triage inbox each morning" / "Conversation {id}" fallback
 * that surfaced when anything but the demo id was opened.
 *
 * Header geometry matches the sister surface at /chat/automation-sidecar
 * (max-w-4xl, px-10, py-[18px], text-[14px] title) so the two chat routes
 * share one visual idiom. Channel glyph sits next to the back arrow as a
 * persistent reminder of where the thread lives (Slack / WhatsApp / Web).
 *
 * Back button goes to /conversations (the natural "up" nav from a thread)
 * rather than home — sidecar variant goes home because it's the start of a
 * builder flow, this one is a saved-thread reopen.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { SketchMessage, UserMessage } from "@/components/sketch/chat-message";
import {
  ArrowLeftIcon,
  BrowserIcon,
  DotsIcon,
  SlackBrandIcon,
  SparklesIcon,
  WhatsappBrandIcon,
} from "@/components/sketch/icons";
import { InlineArtifact } from "@/components/sketch/inline-artifact";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_ALL_CONVERSATIONS, MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import type { IconProps } from "@phosphor-icons/react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import type { ComponentType } from "react";

type Channel = "slack" | "whatsapp" | "web";

const CHANNEL_ICON: Record<Channel, ComponentType<IconProps>> = {
  slack: SlackBrandIcon,
  whatsapp: WhatsappBrandIcon,
  web: BrowserIcon,
};

const CHANNEL_LABEL: Record<Channel, string> = {
  slack: "Slack",
  whatsapp: "WhatsApp",
  web: "Web",
};

interface ResolvedThread {
  title: string;
  channel: Channel;
}

/**
 * Resolve a conversation id to its real title + channel. Falls back to the
 * first MOCK_RECENTS entry when no id matches — covers the /chat/active demo
 * URL and any orphan id without breaking the surface.
 */
function resolveThread(conversationId: string): ResolvedThread {
  const match = MOCK_ALL_CONVERSATIONS.find((row) => row.id === conversationId);
  if (match) return { title: match.title, channel: match.channel };
  // Demo fallback — first recent. Keeps /chat/active rendering something real.
  const fallback = MOCK_ALL_CONVERSATIONS[0];
  return { title: fallback.title, channel: fallback.channel };
}

function ChatPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const { conversationId } = useParams({ from: chatRoute.id });
  const thread = resolveThread(conversationId);

  function handleSubmit(_message: string) {
    // Append to thread — wired to the runtime in production.
  }

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      files={MOCK_FILES}
    >
      <div className="flex h-full min-h-0 flex-col">
        <ChatHeader thread={thread} onBack={() => navigate({ to: "/conversations" })} />
        <div className="relative min-h-0 flex-1">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[28px] bg-gradient-to-b from-background to-transparent"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[28px] bg-gradient-to-t from-background to-transparent"
            aria-hidden
          />
          <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-[24px] px-10 pt-8 pb-12">
              <UserMessage>Can you create a skill that triages my inbox each morning?</UserMessage>

              <SketchMessage>
                Sure — here's a draft. It scans your Gmail inbox at 8am, groups messages by intent, and posts a summary
                to <strong>#inbox-triage</strong>. You can edit before installing.
                <InlineArtifact
                  kind="New skill"
                  title="Morning inbox triage"
                  description="Runs every weekday at 8am. Categorises overnight email, surfaces the top 5 items needing reply, and drops a summary in your preferred Slack channel."
                  icon={SparklesIcon}
                  tags={["Gmail", "Slack", "Daily"]}
                  primaryAction={{ label: "Install skill", onClick: () => {} }}
                  secondaryAction={{ label: "Edit", onClick: () => navigate({ to: "/skills" }) }}
                />
              </SketchMessage>

              <UserMessage>Can you adjust it to also flag anything from Tom?</UserMessage>

              <SketchMessage streaming>
                On it — updating the rule to prioritise messages from <strong>tom@</strong> before the standard
                categorisation pass.
              </SketchMessage>
            </div>
          </div>
        </div>
        <div className="shrink-0 bg-background">
          <div className="mx-auto w-full max-w-4xl px-10 pt-3 pb-[18px]">
            <ChatInput onSubmit={handleSubmit} placeholder="Reply to Sketch…" />
          </div>
        </div>
      </div>
    </SketchShell>
  );
}

function ChatHeader({ thread, onBack }: { thread: ResolvedThread; onBack: () => void }) {
  const ChannelIcon = CHANNEL_ICON[thread.channel];
  return (
    <div className="mx-auto flex w-full max-w-4xl shrink-0 items-center gap-[12px] px-10 py-[18px]">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to conversations"
        className="shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
      >
        <ArrowLeftIcon size={16} aria-hidden />
      </button>
      <span
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted-foreground"
        aria-label={`From ${CHANNEL_LABEL[thread.channel]}`}
      >
        <ChannelIcon size={16} weight="regular" aria-hidden />
      </span>
      <h1 className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/85">{thread.title}</h1>
      <button
        type="button"
        aria-label="Thread options"
        className="shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
      >
        <DotsIcon size={16} aria-hidden />
      </button>
    </div>
  );
}

export const chatRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/chat/$conversationId",
  component: ChatPage,
});
