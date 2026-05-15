/**
 * /home/setup-v2 — proposed redesign of /home/setup.
 *
 * Differences vs /home/setup (current):
 *   - SetupBanner at top is replaced by an inline SetupChecklist card that
 *     sits inside the page content, between the chat input and the rest of
 *     the home rail.
 *   - Greeting copy is setup-specific (fixed welcome line, no rotating nudge).
 *   - Chip row + Quick actions are hidden during setup (chip prompts reference
 *     integrations the user doesn't have; quick-action tiles overlap with the
 *     setup steps).
 *   - Recents stays — visible whenever there are conversations, hidden when
 *     empty. Same behavior as today.
 *
 * This route exists so the redesign can be reviewed alongside the current
 * /home/setup without committing to the change. If approved, /home/setup will
 * be rewritten to match this and this route will go away.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { ConversationRow } from "@/components/sketch/conversation-row";
import { SetupChecklist } from "@/components/sketch/setup-checklist";
import { SketchShell } from "@/components/sketch/shell";
import type { SetupStep } from "@/components/sketch/top-banner";
import { MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { Link, createRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

function HomeSetupV2Page() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<SetupStep>(2);
  const inputRef = useRef<HTMLInputElement>(null);

  function advance() {
    setStep((current) => (current === 5 ? 1 : ((current + 1) as SetupStep)));
  }

  function handleSubmit(_message: string) {
    void navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } });
  }

  // Recents come online once the user has chatted — simulated here by showing
  // a couple after step 3 (the same logic as /home/setup today, kept so the
  // recents-during-setup transition is visible in the preview).
  const recents = step >= 3 ? MOCK_RECENTS.slice(0, 2) : [];

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
    >
      <div className="mx-auto w-full max-w-4xl px-10 py-8">
        {/* Hero — setup-specific greeting + chat input. The chip row is
         * intentionally suppressed during setup (chip prompts reference
         * integrations the user doesn't have yet). */}
        <section className="flex flex-col">
          <SetupGreeting firstName={firstNameOf(auth)} />
          <div className="mt-7">
            <ChatInput ref={inputRef} onSubmit={handleSubmit} />
          </div>
        </section>

        {/* Setup checklist — the primary affordance. Sits between the chat
         * input and the rest of the home rail so the page structure stays
         * stable as the user transitions from new → mid-setup → complete. */}
        <div className="mt-7">
          <SetupChecklist currentStep={step} onAdvance={advance} />
        </div>

        {/* Recents — appears once the user has any conversations. Hidden
         * entirely when empty (no "your conversations will appear here"
         * placeholder; the setup card carries the page's call-to-action). */}
        {recents.length > 0 && (
          <section className="mt-7 flex flex-col">
            <div className="mb-[10px] flex items-baseline justify-between px-[6px]">
              <h2 className="font-mono text-xs uppercase text-foreground" style={{ letterSpacing: "0.08em" }}>
                Recent conversations
              </h2>
              <Link
                to="/conversations"
                className="font-mono text-[10px] uppercase text-muted-foreground hover:text-foreground transition-colors duration-100 ease-out"
                style={{ letterSpacing: "0.07em" }}
              >
                View all →
              </Link>
            </div>
            <div className="flex flex-col gap-[1px]">
              {recents.map((item) => (
                <ConversationRow key={item.id} {...item} />
              ))}
            </div>
          </section>
        )}
      </div>
    </SketchShell>
  );
}

function SetupGreeting({ firstName }: { firstName: string }) {
  return (
    <div className="min-w-0">
      <h1 className="text-xl font-semibold text-foreground">Welcome to Sketch, {firstName}.</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Let's get your workspace working — should take about 5 minutes.
      </p>
    </div>
  );
}

export const homeSetupV2Route = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/setup-v2",
  component: HomeSetupV2Page,
});
