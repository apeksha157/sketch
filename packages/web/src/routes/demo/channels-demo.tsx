import type { ChannelStatus } from "@/lib/api";
import { ChannelsPage } from "@/routes/channels";
import { createRoute } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";
import { MockQueryProvider, hideTrialBanner, setMemberRole } from "./mock-query-provider";

const DEMO_DATA: { channels: ChannelStatus[] } = {
  channels: [
    { platform: "slack", configured: true, connected: true },
    { platform: "whatsapp", configured: true, connected: true, phoneNumber: "+1 (555) 123-4567" },
    { platform: "email", configured: true, connected: true, fromAddress: "sketch@acme.com", outboundOnly: false },
  ],
};

const EMPTY_DATA: { channels: ChannelStatus[] } = {
  channels: [
    { platform: "slack", configured: false, connected: null },
    { platform: "whatsapp", configured: false, connected: null },
    { platform: "email", configured: false, connected: null },
  ],
};

export const channelsPreviewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/channels",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["channels", "status"], data: DEMO_DATA }]}>
      <ChannelsPage />
    </MockQueryProvider>
  ),
});

export const channelsEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/channels/empty",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["channels", "status"], data: EMPTY_DATA }]}>
      <ChannelsPage />
    </MockQueryProvider>
  ),
});

export const channelsMemberRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/channels/member",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["channels", "status"], data: DEMO_DATA }]}>
      <ChannelsPage />
    </MockQueryProvider>
  ),
});

export const channelsMemberEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/channels/member-empty",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["channels", "status"], data: EMPTY_DATA }]}>
      <ChannelsPage />
    </MockQueryProvider>
  ),
});
