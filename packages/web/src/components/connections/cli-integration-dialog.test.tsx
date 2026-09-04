import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import type { CliIntegrationAppId, CliIntegrationConnection, CliIntegrationShareTarget } from "@sketch/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CliConnectionSharingDialog, CliIntegrationDialog } from "./cli-integration-dialog";

function connection(appId: CliIntegrationAppId, shares: CliIntegrationShareTarget[] = []): CliIntegrationConnection {
  return {
    id: `${appId}-1`,
    appId,
    appName: appId === "github" ? "GitHub" : "Linear",
    executionMode: appId === "github" ? "cli" : "api",
    ownerUserId: "owner",
    accountExternalId: "123",
    accountLogin: "test-account",
    status: "active",
    verifiedAt: "2026-01-01",
    lastVerificationError: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    canManage: true,
    isOwnedByViewer: true,
    shares,
  };
}

const members = [
  { id: "owner", name: "Owner", email: "owner@example.test", type: "human" },
  { id: "selected", name: "Selected Member", email: "selected@example.test", type: "human" },
  { id: "excluded", name: "Other Member", email: "other@example.test", type: "human" },
  { id: "external", name: "External", email: "external@example.test", type: "external" },
];

function Setup({
  appId,
  onSuccess,
}: { appId: CliIntegrationAppId; onSuccess: (connection: CliIntegrationConnection) => void }) {
  const [open, setOpen] = useState(true);
  return <CliIntegrationDialog appId={appId} open={open} onOpenChange={setOpen} isAdmin onSuccess={onSuccess} />;
}

async function chooseAccess(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("combobox", { name: "Who has access" }));
  await user.click(await screen.findByRole("option", { name: (label) => label.startsWith(name) }));
}

async function addMember(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("textbox", { name: "Add members" }));
  await user.click(await screen.findByRole("button", { name: `Add ${name}` }));
}

describe.each(["github", "linear"] as const)("%s sharing", (appId) => {
  const appName = appId === "github" ? "GitHub" : "Linear";
  const label = appId === "github" ? "Personal access token" : "Personal API key";
  const sharesUrl = `/api/integration-apps/${appId}/connections/${appId}-1/shares`;

  it("connects privately, automatically opens sharing, and keeps the connection when dismissed", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const onSuccess = vi.fn();
    server.use(
      http.post(`/api/integration-apps/${appId}/connections`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ connection: connection(appId) });
      }),
    );
    renderWithProviders(<Setup appId={appId} onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText(label), "test-credential");
    await user.click(screen.getByRole("button", { name: `Connect ${appName}` }));
    expect(await screen.findByRole("dialog", { name: /^Share / })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Who has access" })).toHaveTextContent("Private");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    expect(screen.queryByDisplayValue("test-credential")).not.toBeInTheDocument();
    expect(bodies).toEqual([{ token: "test-credential", targets: [] }]);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(connection(appId));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps failed credentials in the form and opens sharing only after verification succeeds", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    server.use(
      http.post(`/api/integration-apps/${appId}/connections`, () =>
        HttpResponse.json({ error: { message: "Credential is invalid" } }, { status: 400 }),
      ),
    );
    renderWithProviders(<Setup appId={appId} onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText(label), "invalid-test-credential");
    await user.click(screen.getByRole("button", { name: `Connect ${appName}` }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Credential is invalid");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /^Share / })).not.toBeInTheDocument();
  });

  it("saves only selected members and retries a failed share without reconnecting or replaying success", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const shares: unknown[] = [];
    server.use(
      http.get("/api/users", () => HttpResponse.json({ users: members })),
      http.post(`/api/integration-apps/${appId}/connections`, () =>
        HttpResponse.json({ connection: connection(appId) }),
      ),
      http.put(sharesUrl, async ({ request }) => {
        shares.push(await request.json());
        return shares.length === 1
          ? HttpResponse.json({ error: { message: "Try saving again" } }, { status: 500 })
          : HttpResponse.json({ connection: connection(appId, [{ type: "user", id: "selected" }]) });
      }),
    );
    renderWithProviders(<Setup appId={appId} onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText(label), "test-credential");
    await user.click(screen.getByRole("button", { name: `Connect ${appName}` }));
    await chooseAccess(user, "Selected members");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("textbox", { name: "Add members" }));
    expect(await screen.findByRole("button", { name: "Add Selected Member" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Owner" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add External" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Add members" }), "selected@example.test");
    expect(screen.queryByRole("button", { name: "Add Other Member" })).not.toBeInTheDocument();
    await addMember(user, "Selected Member");
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try saving again");
    expect(screen.getByRole("button", { name: "Remove Selected Member" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(shares).toEqual([
      { targets: [{ type: "user", id: "selected" }] },
      { targets: [{ type: "user", id: "selected" }] },
    ]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "Entire organization",
      shares: [{ type: "user", id: "selected" }],
      expected: [{ type: "org", id: "default" }],
    },
    {
      label: "Private",
      shares: [
        { type: "org", id: "default" },
        { type: "user", id: "selected" },
      ],
      expected: [],
    },
  ] satisfies { label: string; shares: CliIntegrationShareTarget[]; expected: CliIntegrationShareTarget[] }[])(
    "switches existing access to $label",
    async ({ label, shares, expected }) => {
      const user = userEvent.setup();
      const bodies: unknown[] = [];
      const close = vi.fn();
      server.use(
        http.get("/api/users", () => HttpResponse.json({ users: members })),
        http.put(sharesUrl, async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({ connection: connection(appId, expected) });
        }),
      );
      renderWithProviders(
        <CliConnectionSharingDialog connection={connection(appId, shares)} open onOpenChange={close} isAdmin />,
      );
      expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
      await chooseAccess(user, label);
      await user.click(screen.getByRole("button", { name: "Save access" }));
      await waitFor(() => expect(bodies).toEqual([{ targets: expected }]));
      await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    },
  );

  it("shows member loading failures and retries without allowing an empty or unverified member save", async () => {
    const user = userEvent.setup();
    server.use(http.get("/api/users", () => HttpResponse.json({}, { status: 500 })));
    renderWithProviders(
      <CliConnectionSharingDialog connection={connection(appId)} open onOpenChange={vi.fn()} isAdmin />,
    );
    await chooseAccess(user, "Selected members");
    expect(await screen.findByRole("alert")).toHaveTextContent("Members could not be loaded");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    server.use(http.get("/api/users", () => HttpResponse.json({ users: members })));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await addMember(user, "Selected Member");
    expect(screen.getByRole("button", { name: "Save access" })).toBeEnabled();
  });

  it("preserves mixed grants until an explicit choice, then saves organization access alone", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.put(sharesUrl, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ connection: connection(appId, [{ type: "org", id: "default" }]) });
      }),
    );
    renderWithProviders(
      <CliConnectionSharingDialog
        connection={connection(appId, [
          { type: "org", id: "default" },
          { type: "user", id: "selected" },
        ])}
        open
        onOpenChange={vi.fn()}
        isAdmin
      />,
    );
    expect(screen.getByRole("combobox", { name: "Who has access" })).toHaveTextContent("Entire organization");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    expect(bodies).toEqual([]);
    await chooseAccess(user, "Private");
    await chooseAccess(user, "Entire organization");
    await user.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(bodies).toEqual([{ targets: [{ type: "org", id: "default" }] }]));
  });

  it("lets non-admin owners select members but disables organization sharing", async () => {
    const user = userEvent.setup();
    server.use(http.get("/api/users", () => HttpResponse.json({ users: members })));
    renderWithProviders(
      <CliConnectionSharingDialog connection={connection(appId)} open onOpenChange={vi.fn()} isAdmin={false} />,
    );
    await user.click(screen.getByRole("combobox", { name: "Who has access" }));
    expect(screen.getByRole("option", { name: /^Entire organization/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: /^Selected members/ }));
    await addMember(user, "Selected Member");
    expect(screen.getByRole("button", { name: "Save access" })).toBeEnabled();
  });

  it("does not offer sharing or credential controls to recipients", () => {
    renderWithProviders(
      <CliConnectionSharingDialog
        connection={{ ...connection(appId), canManage: false, isOwnedByViewer: false }}
        open
        onOpenChange={vi.fn()}
        isAdmin
      />,
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save access" })).not.toBeInTheDocument();
    expect(screen.queryByText("Connection settings")).not.toBeInTheDocument();
  });

  it("shows member controls only for selected members and retains unsaved selections across modes", async () => {
    const user = userEvent.setup();
    server.use(http.get("/api/users", () => HttpResponse.json({ users: members })));
    renderWithProviders(
      <CliConnectionSharingDialog connection={connection(appId)} open onOpenChange={vi.fn()} isAdmin />,
    );
    expect(screen.getByText("Sharing lets others run actions in Sketch using this account.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Add members" })).not.toBeInTheDocument();

    await chooseAccess(user, "Selected members");
    await addMember(user, "Selected Member");
    expect(screen.getByRole("button", { name: "Remove Selected Member" })).toBeInTheDocument();

    for (const mode of ["Private", "Entire organization"]) {
      await chooseAccess(user, mode);
      expect(screen.queryByRole("textbox", { name: "Add members" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove Selected Member" })).not.toBeInTheDocument();
    }

    await chooseAccess(user, "Selected members");
    expect(await screen.findByRole("button", { name: "Remove Selected Member" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Selected Member" }));
    expect(screen.queryByRole("button", { name: "Remove Selected Member" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
  });
});
