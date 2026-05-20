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
import type { ComponentType, ReactNode } from "react";

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
              <UserMessage>Can you triage my inbox from the last 24 hours?</UserMessage>

              <SketchMessage>Pulling Gmail now. Anything to prioritise, or just a standard pass?</SketchMessage>

              <UserMessage>Standard. Just flag anything from customers.</UserMessage>

              <SketchMessage>
                Done — 23 emails since yesterday at 3pm. Six internal updates and three marketing are already
                auto-archived. Four from customers worth a look, plus seven others worth a quick scan.
                <br />
                <br />
                One needs your attention today: <strong>Tom Cooper at Hubspot</strong> is asking about extending his
                trial — looks time-sensitive.
              </SketchMessage>

              <UserMessage>Show me Tom's.</UserMessage>

              <SketchMessage>
                Landed at 3:14pm today, no reply yet:
                <EmailQuote
                  from="Tom Cooper"
                  fromContext="Hubspot · tom@hubspot.com"
                  subject="Re: Trial extension"
                  body={
                    <>
                      <p>
                        Hey — we've got 2 days left on the trial and the team is still evaluating. Any chance we could
                        get another week? Otherwise we'll just have to wind down on Friday, which would be a shame given
                        how close we are.
                      </p>
                      <p>Let me know either way.</p>
                      <p>Best, Tom</p>
                    </>
                  }
                />
              </SketchMessage>

              <UserMessage>Draft a reply offering 7 more days.</UserMessage>

              <SketchMessage>
                How's this read?
                <DraftReply
                  body={
                    <>
                      <p>Hi Tom,</p>
                      <p>
                        Happy to extend by another 7 days — no need to rush. If there's anything specific the team is
                        still evaluating, let me know and I can help unblock it on our side.
                      </p>
                      <p>— Apeksha</p>
                    </>
                  }
                />
              </SketchMessage>

              <UserMessage>Looks good — send it.</UserMessage>

              <SketchMessage>
                Sent. Tom should see it in the next minute or two.
                <br />
                <br />
                Want me to set up a recurring morning triage so urgent things like this catch earlier next time?
              </SketchMessage>

              <UserMessage>Yes — daily at 8am.</UserMessage>

              <SketchMessage>
                Here's a draft. You can edit before installing.
                <InlineArtifact
                  kind="New skill"
                  title="Morning inbox triage"
                  description="Runs every weekday at 8am. Categorises overnight email, surfaces the top items needing reply, and drops a summary in your preferred Slack channel."
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

/**
 * Inline preview of an email Sketch pulled from the user's inbox. Lightweight
 * card chrome (border + card bg) so it reads as a quoted artifact inside the
 * Sketch message, not as a separate message. From/subject sit on top, body
 * paragraphs render with normal prose spacing.
 */
function EmailQuote({
  from,
  fromContext,
  subject,
  body,
}: {
  from: string;
  fromContext?: string;
  subject: string;
  body: ReactNode;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[13px] font-medium text-foreground">
          {from}
          {fromContext && <span className="ml-[6px] font-normal text-muted-foreground">· {fromContext}</span>}
        </div>
        <div className="mt-[2px] text-[12px] text-muted-foreground">{subject}</div>
      </div>
      <div className="space-y-3 px-4 py-3 text-[13px] leading-[1.6] text-foreground/85">{body}</div>
    </div>
  );
}

/**
 * Inline preview of a reply Sketch drafted on the user's behalf. Same family
 * as EmailQuote but uses a soft accent left rule (instead of full border) to
 * signal "this is from you, not from them" — keeps the visual distinction
 * between quoted-incoming and drafted-outgoing readable at a glance.
 */
function DraftReply({ body }: { body: ReactNode }) {
  return (
    <div className="mt-3 rounded-r-[8px] border-l-[3px] border-foreground/40 bg-foreground/[0.03] py-3 pl-4 pr-4">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Draft reply</div>
      <div className="mt-2 space-y-3 text-[13px] leading-[1.6] text-foreground/85">{body}</div>
    </div>
  );
}

export const chatRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/chat/$conversationId",
  component: ChatPage,
});
