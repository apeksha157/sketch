/**
 * /home/trial-expired — §5.7. Paused state: chat input + chips + tiles all
 * disabled, recents still browsable in read-only mode, sidebar credits card
 * replaced with a small "Account paused" line.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { DangerBanner } from "@/components/sketch/top-banner";
import { MOCK_FILES, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomeTrialExpiredPage() {
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
      files={MOCK_FILES}
      paused
      banner={
        <DangerBanner
          message="Trial ended May 12 — upgrade to keep using Sketch."
          action={{ label: "Upgrade", onClick: () => void navigate({ to: "/plans" }) }}
        />
      }
    >
      <HomePane firstName={firstNameOf(auth)} recents={MOCK_RECENTS} disabled />
    </SketchShell>
  );
}

export const homeTrialExpiredRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/trial-expired",
  component: HomeTrialExpiredPage,
});
