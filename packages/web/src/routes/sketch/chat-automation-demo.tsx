/**
 * /chat/automation-sidecar — chat conversation that produces an automation
 * artifact, with an "Open builder" CTA that takes the user into the split
 * builder at /scheduled-tasks/builder-sidecar. The chat continues live in a
 * left rail next to the canvas.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { SketchMessage, UserMessage } from "@/components/sketch/chat-message";
import { ArrowLeftIcon, CalendarTimeIcon, DotsIcon } from "@/components/sketch/icons";
import { InlineArtifact } from "@/components/sketch/inline-artifact";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute, useNavigate } from "@tanstack/react-router";

function AutomationChatPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();

  function handleSubmit(_message: string) {
    // No-op for the demo — reply is canned below.
  }

  function openBuilder() {
    void navigate({ to: "/scheduled-tasks/builder-sidecar" });
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
    >
      <div className="flex h-full min-h-0 flex-col">
        <ChatHeader title="Sharing five-star Trustpilot reviews" onBack={() => navigate({ to: "/home/default" })} />
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
              <UserMessage>
                I want to do a better job celebrating customer wins inside the team. Right now they just sit in a tab no
                one's looking at.
              </UserMessage>

              <SketchMessage>
                Which source has the most signal — Trustpilot, the App Store, Intercom, somewhere else?
              </SketchMessage>

              <UserMessage>Trustpilot. The five-star ones especially — those land hardest internally.</UserMessage>

              <SketchMessage>
                Got it. And where should they show up — a Slack channel, a weekly digest, somewhere quieter?
              </SketchMessage>

              <UserMessage>
                Slack. There's already a #design-wins channel that's basically tumbleweeds — want to bring it back to
                life.
              </UserMessage>

              <SketchMessage>
                Makes sense. Want every five-star review routed there, or only the ones that actually mention design?
              </SketchMessage>

              <UserMessage>
                Whenever we get a five-star Trustpilot review mentioning design, share it in #design-wins.
              </UserMessage>

              <SketchMessage>On it — let me sketch that out.</SketchMessage>

              <UserMessage>Also DM me when one fires, don't want to miss the moment.</UserMessage>

              <SketchMessage>
                All set — here's the draft. Tweak anything before I save it.
                <InlineArtifact
                  kind="New automation"
                  title="Surface design wins from Trustpilot"
                  description="Every five-star Trustpilot review mentioning design lands in #design-wins. I'll DM you the moment it goes out."
                  icon={CalendarTimeIcon}
                  tags={["Trustpilot", "Slack", "Always-on"]}
                  primaryAction={{
                    label: "Open builder",
                    onClick: openBuilder,
                  }}
                  secondaryAction={{
                    label: "Save as-is",
                    onClick: openBuilder,
                  }}
                />
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

function ChatHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mx-auto flex h-[48px] w-full max-w-4xl shrink-0 items-center gap-[12px] px-10">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to home"
        className="shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
      >
        <ArrowLeftIcon size={16} aria-hidden />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/85">{title}</h1>
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

export const chatAutomationSidecarRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/chat/automation-sidecar",
  component: AutomationChatPage,
});
