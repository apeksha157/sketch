/**
 * /scheduled-tasks/builder-sidecar — chat-driven automation builder.
 *
 * User got here by clicking "Open builder" on the artifact in
 * /chat/automation-sidecar. The chat continues in a left rail next to the
 * canvas — same conversation, still live. Power users can collapse the
 * rail down to the ComposerCard via the Tab pull-handle on its right edge.
 *
 * Chat is the lead surface (left), canvas is the working surface (right)
 * so the canvas has room for its own right-edge details panel — populated
 * separately, not scaffolded here.
 */
import { BuilderCanvas } from "@/components/sketch/builder-canvas";
import { BuilderSidecar } from "@/components/sketch/builder-sidecar";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function BuilderSidecarPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();

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
      <div className="flex h-full min-h-0">
        <BuilderSidecar threadTitle="Sharing five-star Trustpilot reviews" />
        <div className="flex min-w-0 flex-1 flex-col">
          <BuilderCanvas placeholder onSave={() => navigate({ to: "/chat/automation-sidecar" })} />
        </div>
      </div>
    </SketchShell>
  );
}

export const builderSidecarRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/builder-sidecar",
  component: BuilderSidecarPage,
});
