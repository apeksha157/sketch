/**
 * /scheduled-tasks/builder-inline — Variant A.
 *
 * Full-page builder. User got here by clicking "Open builder" on the inline
 * artifact in /chat/automation-inline. The chat is *not* visible on this
 * page; the user has left the conversation behind. They return to it via the
 * "← Back to chat" link in the header.
 *
 * Same BuilderCanvas as Variant B — the only difference is what wraps it.
 */
import { BuilderBottomChat } from "@/components/sketch/builder-bottom-chat";
import { BuilderCanvas } from "@/components/sketch/builder-canvas";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function BuilderInlinePage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const goToChat = () => navigate({ to: "/chat/automation-inline" });

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
      <BuilderCanvas
        showBackToChat
        onBack={goToChat}
        onSave={goToChat}
        placeholder
        bottomSlot={
          <BuilderBottomChat
            threadTitle="Sharing five-star Trustpilot reviews"
            lastActivity={{ actor: "Sketch", time: "just now" }}
          />
        }
      />
    </SketchShell>
  );
}

export const builderInlineRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/builder-inline",
  component: BuilderInlinePage,
});
