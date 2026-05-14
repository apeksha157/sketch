/**
 * /home/automation-failed — §5.4.
 *
 * Main pane is identical to /home/default — the failure doesn't show in recents
 * (recents is conversations only, per §7 of the spec). The sidebar Scheduled
 * tasks nav gets a red badge, and a fresh-failure toast appears in the top-right
 * of the main pane.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { AlertTriangleIcon } from "@/components/sketch/icons";
import { SketchShell } from "@/components/sketch/shell";
import { Toast, ToastStack } from "@/components/sketch/toast";
import { MOCK_CREDITS, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

function HomeAutomationFailedPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const [toastOpen, setToastOpen] = useState(true);

  function handleSubmit(_message: string) {
    void navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } });
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
      navState={{ "/scheduled-tasks": { badgeCount: 2 } }}
    >
      <HomePane firstName={firstNameOf(auth)} role={auth.role} recents={MOCK_RECENTS} onSubmit={handleSubmit} />
      {toastOpen && (
        <ToastStack>
          <Toast
            item={{
              id: "automation-failed-1",
              icon: AlertTriangleIcon,
              iconColorClass: "text-destructive",
              title: "Weekly standup digest failed",
              detail: "Connection to Slack expired during run.",
              onDismiss: () => setToastOpen(false),
              onActivate: () => {
                setToastOpen(false);
                void navigate({ to: "/scheduled-tasks" });
              },
            }}
          />
        </ToastStack>
      )}
    </SketchShell>
  );
}

export const homeAutomationFailedRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/automation-failed",
  component: HomeAutomationFailedPage,
});
