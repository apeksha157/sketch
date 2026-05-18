/**
 * /chat/$conversationId — §5.6. The active conversation surface.
 *
 * Demo route ("/chat/active") seeds a representative thread with a streaming
 * Sketch response and an inline-artifact card so the team can review §4.17
 * without firing a real Sketch run.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { SketchMessage, UserMessage } from "@/components/sketch/chat-message";
import { ArrowLeftIcon, DotsIcon, SparklesIcon } from "@/components/sketch/icons";
import { InlineArtifact } from "@/components/sketch/inline-artifact";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";

function ChatPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const { conversationId } = useParams({ from: chatRoute.id });

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
        <ChatHeader title={resolveTitle(conversationId)} onBack={() => navigate({ to: "/home/default" })} />
        <div className="flex-1 overflow-y-auto px-[20px] pt-[20px] pb-[12px]">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[16px]">
            <UserMessage>Can you create a skill that triages my inbox each morning?</UserMessage>

            <SketchMessage>
              Sure — here's a draft. It scans your Gmail inbox at 8am, groups messages by intent, and posts a summary to{" "}
              <strong>#inbox-triage</strong>. You can edit before installing.
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
        <div className={cn("shrink-0 border-t bg-background", "border-border")} style={{ borderTopWidth: "0.5px" }}>
          <div className="mx-auto w-full max-w-[720px] px-[20px] pt-[12px] pb-[18px]">
            <ChatInput onSubmit={handleSubmit} placeholder="Reply to Sketch…" />
          </div>
        </div>
      </div>
    </SketchShell>
  );
}

function ChatHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div
      className={cn("flex shrink-0 items-center gap-[12px] border-b px-[18px] py-[12px]", "border-border")}
      style={{ borderBottomWidth: "0.5px" }}
    >
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to home"
        className="text-muted-foreground/65 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
      >
        <ArrowLeftIcon size={16} aria-hidden />
      </button>
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{title}</span>
      <button
        type="button"
        aria-label="Thread options"
        className="text-muted-foreground/65 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
      >
        <DotsIcon size={16} aria-hidden />
      </button>
    </div>
  );
}

function resolveTitle(conversationId: string): string {
  if (conversationId === "active") return "Triage inbox each morning";
  return `Conversation ${conversationId}`;
}

export const chatRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/chat/$conversationId",
  component: ChatPage,
});
