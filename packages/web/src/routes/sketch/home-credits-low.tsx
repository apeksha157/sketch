/**
 * /home/credits-low — §5.5. Red banner up top, low-credits variant of the
 * sidebar credits card. Both surface the same Top-up modal entry point.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { DangerBanner } from "@/components/sketch/top-banner";
import { MOCK_CREDITS_LOW, MOCK_FILES, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomeCreditsLowPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();

  function handleSubmit(_message: string) {
    void navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } });
  }

  function handleTopUp() {
    // Top-up modal entry point (§4.15). Modal is a separate work item.
    void navigate({ to: "/plans" });
  }

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      credits={{ ...MOCK_CREDITS_LOW, onClick: handleTopUp }}
      files={MOCK_FILES}
      banner={
        <DangerBanner
          message={`Only ${MOCK_CREDITS_LOW.count} credits left — top up to keep automations running.`}
          action={{ label: "Top up", onClick: handleTopUp }}
        />
      }
    >
      <HomePane firstName={firstNameOf(auth)} recents={MOCK_RECENTS} onSubmit={handleSubmit} />
    </SketchShell>
  );
}

export const homeCreditsLowRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/credits-low",
  component: HomeCreditsLowPage,
});
