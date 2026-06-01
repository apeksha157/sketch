/**
 * /home/payment-lapsed — §5.8. Same paused shape as trial-expired with a
 * payment-method-specific message and button.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { DangerBanner } from "@/components/sketch/top-banner";
import { MOCK_FILES, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomePaymentLapsedPage() {
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
          message="Payment failed — update your card to keep automations running."
          action={{ label: "Update payment", onClick: () => void navigate({ to: "/plans" }) }}
        />
      }
    >
      <HomePane firstName={firstNameOf(auth)} recents={MOCK_RECENTS} disabled />
    </SketchShell>
  );
}

export const homePaymentLapsedRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/payment-lapsed",
  component: HomePaymentLapsedPage,
});
