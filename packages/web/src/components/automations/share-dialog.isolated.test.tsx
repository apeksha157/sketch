import { AutomationShareDialog } from "@/components/automations/share-dialog";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

function renderDialog(canShare = true) {
  return renderWithProviders(
    <AutomationShareDialog
      taskId="task-1"
      taskName="Monday revenue summary"
      ownerUserId="u1"
      canShare={canShare}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

/**
 * The share dialog shows only who HAS access at rest (owner + editors + an
 * admins note); addable teammates are surfaced by searching, not by a standing
 * roster of "add me" rows. These tests exercise that model against the default
 * MSW users (u1 Alice = owner, u2 Bob = admin, u3 Carol / u4 Dave = members).
 */
describe("AutomationShareDialog", () => {
  it("shows who has access and notes admins, without listing addable members", async () => {
    renderDialog();

    expect(await screen.findByText("Alice Smith")).toBeInTheDocument();
    expect(screen.getByText("People with access")).toBeInTheDocument();
    expect(screen.getByText(/workspace admin/)).toHaveTextContent("1 workspace admin also has full access.");
    // Addable members and the admin are not surfaced until you search.
    expect(screen.queryByText("Carol Davis")).not.toBeInTheDocument();
    expect(screen.queryByText("Dave Evans")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob Jones")).not.toBeInTheDocument();
  });

  it("reveals a matching person when you search to add", async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findByText("Alice Smith");
    await user.type(screen.getByLabelText("Add people"), "carol");

    expect(await screen.findByText("Carol Davis")).toBeInTheDocument();
    expect(screen.queryByText("Dave Evans")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob Jones")).not.toBeInTheDocument();
  });

  it("stages a grant and only writes it on Save", async () => {
    const grantedUserIds: string[] = [];
    server.use(
      http.put("/api/scheduled-tasks/:id/shares/:userId", ({ params }) => {
        grantedUserIds.push(String(params.userId));
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await screen.findByText("Alice Smith");
    await user.type(screen.getByLabelText("Add people"), "carol");
    await user.click(await screen.findByRole("button", { name: /Carol Davis/ }));

    // Picking a person stages the change (Carol shows "Adding") — nothing is
    // written until the batch is committed.
    expect(await screen.findByText("Adding")).toBeInTheDocument();
    expect(grantedUserIds).toEqual([]);

    await user.click(screen.getByRole("button", { name: /Save change/i }));

    await waitFor(() => {
      expect(grantedUserIds).toEqual(["u3"]);
    });
  });

  it("stages a removal and only writes it on Save", async () => {
    const revokedUserIds: string[] = [];
    server.use(
      http.get("/api/scheduled-tasks/:id/shares", () => {
        return HttpResponse.json({
          shares: [
            {
              userId: "u3",
              name: "Carol Davis",
              email: "carol@example.com",
              grantedByUserId: "u1",
              grantedAt: "2026-01-05T00:00:00Z",
            },
          ],
        });
      }),
      http.delete("/api/scheduled-tasks/:id/shares/:userId", ({ params }) => {
        revokedUserIds.push(String(params.userId));
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Remove Carol Davis" }));

    // The row flips to "Removing" but access is untouched until Save.
    expect(await screen.findByText("Removing")).toBeInTheDocument();
    expect(revokedUserIds).toEqual([]);

    await user.click(screen.getByRole("button", { name: /Save change/i }));

    await waitFor(() => {
      expect(revokedUserIds).toEqual(["u3"]);
    });
  });

  it("undoing a staged removal writes nothing on Save", async () => {
    const revokedUserIds: string[] = [];
    server.use(
      http.get("/api/scheduled-tasks/:id/shares", () => {
        return HttpResponse.json({
          shares: [
            {
              userId: "u3",
              name: "Carol Davis",
              email: "carol@example.com",
              grantedByUserId: "u1",
              grantedAt: "2026-01-05T00:00:00Z",
            },
          ],
        });
      }),
      http.delete("/api/scheduled-tasks/:id/shares/:userId", ({ params }) => {
        revokedUserIds.push(String(params.userId));
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Remove Carol Davis" }));
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    // With nothing staged, the commit bar is gone and no revoke ever fires.
    expect(screen.queryByRole("button", { name: /Save change/i })).not.toBeInTheDocument();
    expect(revokedUserIds).toEqual([]);
  });

  it("keeps the change staged and surfaces the error when Save fails", async () => {
    server.use(
      http.put("/api/scheduled-tasks/:id/shares/:userId", () => {
        return HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "Only the owner can share this automation" } },
          { status: 403 },
        );
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await screen.findByText("Alice Smith");
    await user.type(screen.getByLabelText("Add people"), "carol");
    await user.click(await screen.findByRole("button", { name: /Carol Davis/ }));
    await user.click(screen.getByRole("button", { name: /Save change/i }));

    expect(await screen.findByText("Only the owner can share this automation")).toBeInTheDocument();
    // A failed grant stays staged so it can be retried — Carol is still "Adding".
    expect(screen.getByText("Adding")).toBeInTheDocument();
  });

  it("hides the add control for non-owners", async () => {
    renderDialog(false);

    expect(await screen.findByText("Alice Smith")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add people")).not.toBeInTheDocument();
    expect(screen.getByText("You don't have permission to change sharing.")).toBeInTheDocument();
  });
});
