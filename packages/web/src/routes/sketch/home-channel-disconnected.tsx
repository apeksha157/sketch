/**
 * /home/channel-disconnected — §5.3.
 *
 * Mature workspace with a connected channel (Slack here) needing re-auth.
 * The yellow ErrorBanner sits above the home pane; the sidebar Channels nav
 * gets a red badge (count of disconnected channels).
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { ErrorBanner } from "@/components/sketch/top-banner";
import { MOCK_CREDITS, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomeChannelDisconnectedPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();

  function handleSubmit(_message: string) {
    void navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } });
  }

  function handleReconnect() {
    // Reconnect modal entry point (§4.15). Live OAuth wiring lives in /channels.
    void navigate({ to: "/channels" });
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
      navState={{ "/channels": { badgeCount: 1 } }}
      banner={
        <ErrorBanner
          message="Slack connection expired — reconnect to keep automations running."
          buttonLabel="Reconnect"
          onAction={handleReconnect}
        />
      }
    >
      <HomePane firstName={firstNameOf(auth)} recents={MOCK_RECENTS} onSubmit={handleSubmit} />
    </SketchShell>
  );
}

export const homeChannelDisconnectedRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/channel-disconnected",
  component: HomeChannelDisconnectedPage,
});
