import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import type { IntegrationConnection } from "@sketch/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsSection } from "./integrations-section";

const defaultConnection = {
  providerId: "provider-1",
  appId: "github",
  appName: "GitHub",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
} satisfies Partial<IntegrationConnection>;

function renderSection(connections: IntegrationConnection[], onDisconnect = vi.fn()) {
  return renderWithProviders(
    <IntegrationsSection
      connections={connections}
      isLoadingConnections={false}
      providerId="provider-1"
      orgName="Acme"
      onAdd={vi.fn()}
      onDisconnect={onDisconnect}
    />,
  );
}

async function chooseAccess(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("combobox", { name: "Who has access" }));
  await user.click(await screen.findByRole("option", { name: (label) => label.startsWith(name) }));
}

async function addMember(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("textbox", { name: "Add members" }));
  await user.click(await screen.findByRole("button", { name: `Add ${name}` }));
}

describe.each(["github", "linear"] as const)("IntegrationsSection %s", (appId) => {
  const appName = appId === "github" ? "GitHub" : "Linear";
  const baseConnection = { ...defaultConnection, appId, appName };
  it("renders Canvas access metadata and gates destructive controls", () => {
    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:github:github",
        source: "canvas_user_secrets",
        accountName: "Engineering GitHub",
        authType: "oauth",
        accessLevel: "organization",
        ownerName: "Tara",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
        connectedAt: "2026-01-02T00:00:00Z",
      },
      {
        ...baseConnection,
        id: "secrets:viewer-1:notion:notion",
        source: "canvas_user_secrets",
        appId: "notion",
        appName: "Notion",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
      {
        ...baseConnection,
        id: "pd-1",
        source: "pipedream",
        appId: "slack",
        appName: "Slack",
        accountName: "Team Slack",
        canManageAccess: false,
        canDelete: true,
      },
    ]);

    expect(screen.getByText("Org shared")).toBeInTheDocument();
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
    expect(screen.getByText("Owned by Tara")).toBeInTheDocument();
    expect(screen.queryByText("Engineering GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("OAuth")).not.toBeInTheDocument();
    expect(screen.queryByText(/Connected by:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Owner: Tara")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Disconnect ${appName}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect Notion" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings for Notion" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Settings unavailable for Slack" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open settings for Slack" })).not.toBeInTheDocument();
  });

  it("keeps integration row metadata clean and hides API-key labels", () => {
    renderSection([
      {
        ...baseConnection,
        id: "secrets:viewer-1:meta-ads:meta-ads",
        source: "canvas_user_secrets",
        appId: "meta-ads",
        appName: "Meta Ads",
        accountName: "Business Manager",
        authType: "oauth",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
      {
        ...baseConnection,
        id: "secrets:viewer-1:app-store-connect:app-store-connect",
        source: "canvas_user_secrets",
        appId: "app-store-connect",
        appName: "App Store Connect",
        accountName: "KEY CSSFS",
        authType: "api-key",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
      {
        ...baseConnection,
        id: "secrets:viewer-1:aimfox:aimfox",
        source: "canvas_user_secrets",
        appId: "aimfox",
        appName: "Aimfox",
        accountName: ".",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
      {
        ...baseConnection,
        id: "secrets:viewer-1:fireflies:fireflies",
        source: "canvas_user_secrets",
        appId: "fireflies",
        appName: "Fireflies",
        accountName: "9KQ7S2A1D4",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
    ]);

    expect(screen.getByText("Business Manager")).toBeInTheDocument();
    expect(screen.queryByText("OAuth")).not.toBeInTheDocument();
    expect(screen.queryByText("API key")).not.toBeInTheDocument();
    expect(screen.queryByText("KEY CSSFS")).not.toBeInTheDocument();
    expect(screen.queryByText("9KQ7S2A1D4")).not.toBeInTheDocument();
    expect(screen.queryByText(".")).not.toBeInTheDocument();
    expect(screen.getAllByText("·")).toHaveLength(1);
  });

  it("uses owner display names instead of provider-generated account labels for shared accounts", () => {
    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:aimfox:aimfox",
        source: "canvas_user_secrets",
        appId: "aimfox",
        appName: "Aimfox",
        accountName: "tanushyadav87@gmail.com's Aimfox Connection",
        accessLevel: "organization",
        ownerName: "Tanush Yadav",
        ownerUserId: "tanushyadav87@gmail.com",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
        connectedAt: "2026-05-27T00:00:00Z",
      },
    ]);

    expect(screen.getByText("Owned by Tanush Yadav")).toBeInTheDocument();
    expect(screen.getByText("Connected May 27")).toBeInTheDocument();
    expect(screen.queryByText(/gmail\.com/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Aimfox Connection/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect Aimfox" })).toBeDisabled();
  });

  it("keeps shared accounts non-destructive when Canvas omits canDelete", () => {
    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:github:github",
        source: "canvas_user_secrets",
        accessLevel: "organization",
        ownerName: "Tara",
        isOwnedByViewer: false,
        canManageAccess: false,
      },
    ]);

    expect(screen.getByRole("button", { name: `Disconnect ${appName}` })).toBeDisabled();
  });

  it("saves selected members only for manageable Canvas-owned accounts", async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn();
    let requestBody: unknown;

    server.use(
      http.get("/api/mcp-servers/provider-1/members", () =>
        HttpResponse.json({ members: [{ id: "member-1", name: "Alex" }] }),
      ),
      http.patch("/api/mcp-servers/provider-1/connections/:connectionId/access", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ success: true, connection: null });
      }),
    );

    renderSection(
      [
        {
          ...baseConnection,
          id: "secrets:viewer-1:github:github",
          source: "canvas_user_secrets",
          accountName: "Engineering GitHub",
          authType: "oauth",
          accessLevel: "personal",
          isOwnedByViewer: true,
          canManageAccess: true,
          canDelete: true,
          accessRevision: 2,
          memberUserIds: [],
        },
      ],
      onDisconnect,
    );

    await user.click(screen.getByRole("button", { name: `Open settings for ${appName}` }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Who has access" })).toBeInTheDocument();
    await chooseAccess(user, "Selected members");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();

    await addMember(user, "Alex");
    await user.click(screen.getByRole("button", { name: "Save access" }));

    await waitFor(() => {
      expect(requestBody).toEqual({
        accessLevel: "personal",
        expectedRevision: 2,
        visibility: "selected_members",
        granteeUserIds: ["member-1"],
      });
      expect(onDisconnect).toHaveBeenCalled();
    });
  });

  it.each([
    ["Entire organization", "personal", [], "organization"],
    ["Private", "organization", [], "personal"],
    ["Private", "personal", ["member-1"], "personal"],
  ] as const)(
    "saves %s and clears stale individual grants",
    async (label, previousLevel, previousMembers, accessLevel) => {
      const user = userEvent.setup();
      let requestBody: unknown;
      server.use(
        http.patch("/api/mcp-servers/provider-1/connections/:connectionId/access", async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({ success: true, connection: null });
        }),
        http.get("/api/mcp-servers/provider-1/members", () =>
          HttpResponse.json({ members: [{ id: "member-1", name: "Alex", email: "alex@example.test" }] }),
        ),
      );
      renderSection([
        {
          ...baseConnection,
          id: "secrets:viewer-1:github:github",
          source: "canvas_user_secrets",
          isOwnedByViewer: true,
          canManageAccess: true,
          accessLevel: previousLevel,
          memberUserIds: [...previousMembers],
          accessRevision: 4,
        },
      ]);
      await user.click(screen.getByRole("button", { name: `Open settings for ${appName}` }));
      await chooseAccess(user, label);
      await user.click(screen.getByRole("button", { name: "Save access" }));
      await waitFor(() =>
        expect(requestBody).toEqual({
          accessLevel,
          expectedRevision: 4,
          visibility: accessLevel === "organization" ? "organization" : "private",
          granteeUserIds: [],
        }),
      );
    },
  );

  it("requires a member in selected mode and keeps the selection on a failed save", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/mcp-servers/provider-1/members", () =>
        HttpResponse.json({ members: [{ id: "member-1", name: "Alex", email: "alex@example.test" }] }),
      ),
      http.patch("/api/mcp-servers/provider-1/connections/:connectionId/access", () =>
        HttpResponse.json(
          { error: { code: "CONFLICT", message: "Account sharing changed; reload and try again" } },
          { status: 409 },
        ),
      ),
    );
    renderSection([
      {
        ...baseConnection,
        id: "secrets:viewer-1:github:github",
        source: "canvas_user_secrets",
        isOwnedByViewer: true,
        canManageAccess: true,
        accessLevel: "personal",
        memberUserIds: [],
        accessRevision: 4,
      },
    ]);
    await user.click(screen.getByRole("button", { name: `Open settings for ${appName}` }));
    await chooseAccess(user, "Selected members");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    await addMember(user, "Alex");
    expect(screen.getByText("alex@example.test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Account sharing changed");
    expect(screen.getByRole("button", { name: "Remove Alex" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("allows explicitly saving an already-private account with no member grants", async () => {
    const user = userEvent.setup();
    let requestBody: unknown;
    server.use(
      http.patch("/api/mcp-servers/provider-1/connections/:connectionId/access", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ success: true, connection: null });
      }),
    );
    renderSection([
      {
        ...baseConnection,
        source: "canvas_user_secrets",
        isOwnedByViewer: true,
        canManageAccess: true,
        accessLevel: "personal",
        visibility: "private",
        memberUserIds: [],
        accessRevision: 4,
      },
    ]);
    await user.click(screen.getByRole("button", { name: `Open settings for ${appName}` }));
    const saveButton = screen.getByRole("button", { name: "Save access" });
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);
    await waitFor(() => {
      expect(requestBody).toEqual({
        accessLevel: "personal",
        expectedRevision: 4,
        visibility: "private",
        granteeUserIds: [],
      });
    });
  });

  it("loads saved selections, searches by email, and distinguishes empty search results", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/mcp-servers/provider-1/members", () =>
        HttpResponse.json({
          members: [
            { id: "member-1", name: "Alex", email: "alex@example.test" },
            { id: "member-2", name: "Blair", email: "blair@example.test" },
          ],
        }),
      ),
    );
    renderSection([
      {
        ...baseConnection,
        id: "secrets:viewer-1:github:github",
        source: "canvas_user_secrets",
        isOwnedByViewer: true,
        canManageAccess: true,
        accessLevel: "personal",
        memberUserIds: ["member-1"],
        memberGrants: [],
        accessRevision: 4,
      },
    ]);
    await user.click(screen.getByRole("button", { name: `Open settings for ${appName}` }));
    expect(screen.getByRole("combobox", { name: "Who has access" })).toHaveTextContent("Selected members");
    expect(await screen.findByRole("button", { name: "Remove Alex" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Add members" }), "blair@example");
    expect(screen.getByRole("button", { name: "Add Blair" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Alex" })).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Add members" }));
    await user.type(screen.getByRole("textbox", { name: "Add members" }), "no-match");
    expect(screen.getByText("No members match your search.")).toBeInTheDocument();
    expect(screen.getByText("1 member selected")).toBeInTheDocument();
  });

  it("shows non-owner shared Canvas accounts as usable but not manageable", async () => {
    const user = userEvent.setup();

    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:github:github",
        source: "canvas_user_secrets",
        accessLevel: "organization",
        ownerName: "Tara",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
      },
    ]);

    await user.click(screen.getByRole("button", { name: `Open settings for ${appName}` }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Tara shared this account with you/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Owner: Tara")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("Tara shared this account with you. Only the owner can manage access."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save access" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  });

  it("suppresses email-derived shared account labels in the settings dialog", async () => {
    const user = userEvent.setup();

    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:aimfox:aimfox",
        source: "canvas_user_secrets",
        appId: "aimfox",
        appName: "Aimfox",
        accountName: "tanushyadav87@gmail.com's Aimfox Connection",
        accessLevel: "organization",
        ownerName: "Tanush Yadav",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
      },
    ]);

    await user.click(screen.getByRole("button", { name: "Open settings for Aimfox" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Tanush Yadav shared this account with you/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/gmail\.com/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Aimfox Connection/)).not.toBeInTheDocument();
  });

  it("does not render separator-only owner names from Canvas", async () => {
    const user = userEvent.setup();

    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:github:github",
        source: "canvas_user_secrets",
        accessLevel: "organization",
        ownerName: ".",
        ownerUserId: "owner-1",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
      },
    ]);

    expect(screen.queryByText(/Owned by:/)).not.toBeInTheDocument();
    expect(screen.queryByText("teammate")).not.toBeInTheDocument();
    expect(screen.queryByText("Owner: .")).not.toBeInTheDocument();
    expect(screen.queryByText(".")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: `Open settings for ${appName}` }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/teammate shared this account with you/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Owner: .")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("teammate shared this account with you. Only the owner can manage access."),
    ).toBeInTheDocument();
  });
});
