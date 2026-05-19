/**
 * /scheduled-tasks/builder-sidecar — Variant B.
 *
 * Split builder. User got here by clicking "Open builder + chat" on the
 * artifact in /chat/automation-sidecar. The chat continues in a right rail
 * next to the canvas — same conversation, still live. Power users can
 * collapse the rail down to a thin strip via the chevron.
 *
 * Same BuilderCanvas as Variant A — only the wrapper is different.
 */
import { BuilderCanvas } from "@/components/sketch/builder-canvas";
import { BuilderSidecar } from "@/components/sketch/builder-sidecar";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS } from "@/routes/sketch/mock-data";
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
    >
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <BuilderCanvas placeholder onSave={() => navigate({ to: "/chat/automation-sidecar" })} />
        </div>
        <BuilderSidecar threadTitle="Sharing five-star Trustpilot reviews" />
      </div>
    </SketchShell>
  );
}

export const builderSidecarRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/builder-sidecar",
  component: BuilderSidecarPage,
});
