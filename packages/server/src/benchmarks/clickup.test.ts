import { describe, expect, it, vi } from "vitest";
import type { IntegrationProvider } from "../integrations/types";
import { BRIEF, createClickUpProbe } from "./clickup";

function provider(): IntegrationProvider {
  return {
    type: "canvas",
    listApps: async () => ({ apps: [], pageInfo: { hasMore: false, endCursor: null } }),
    initiateConnection: async () => ({ redirectUrl: "https://example.com" }),
    listConnections: async () => [],
    removeConnection: async () => {},
    isBrokerCapable: () => false,
    getBrokerSpec: () => null,
    getCanvasAccessToken: async () => ({ accessToken: "fixture-only-token" }),
  };
}

describe("independent ClickUp verification", () => {
  it("reads all pages rather than treating a short page as the end", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tasks: [{ id: "1", name: "One" }] }))
      .mockResolvedValueOnce(Response.json({ tasks: [{ id: "2", name: "Two" }], last_page: true }));
    expect(
      await createClickUpProbe(
        provider(),
        "owner@example.com",
        "account",
        new AbortController().signal,
        transport,
      ).tasks("1"),
    ).toHaveLength(2);
    expect(transport.mock.calls[1]?.[0]).toContain("page=1");
  });
  it("uses attachment bytes and never forwards provider credentials to a download host", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "1", name: "Task", attachments: [{ url: "https://attachments.clickup.com/brief" }] }),
      )
      .mockResolvedValueOnce(new Response(BRIEF));
    expect(
      await createClickUpProbe(
        provider(),
        "owner@example.com",
        "account",
        new AbortController().signal,
        transport,
      ).attachmentMatches("1"),
    ).toBe(true);
    expect(transport.mock.calls[1]?.[1]?.headers).toBeUndefined();
  });
  it("rejects wrong bytes and unsupported download hosts", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "1", attachments: [{ url: "https://attachments.clickup.com/brief" }] }),
      )
      .mockResolvedValueOnce(new Response("wrong content"));
    expect(
      await createClickUpProbe(
        provider(),
        "owner@example.com",
        "account",
        new AbortController().signal,
        transport,
      ).attachmentMatches("1"),
    ).toBe(false);
    const blocked = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "1", attachments: [{ url: "http://127.0.0.1/private" }] }));
    await expect(
      createClickUpProbe(
        provider(),
        "owner@example.com",
        "account",
        new AbortController().signal,
        blocked,
      ).attachmentMatches("1"),
    ).rejects.toThrow("unsupported");
    expect(blocked).toHaveBeenCalledTimes(1);
  });
  it("does not retry ambiguous writes and honors worker fencing before credentials", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("network interrupted"));
    await expect(
      createClickUpProbe(
        provider(),
        "owner@example.com",
        "account",
        new AbortController().signal,
        transport,
      ).createTask("1", "Task"),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    const blocked = vi.fn<typeof fetch>();
    const guard = async () => {
      throw new Error("lost worker");
    };
    await expect(
      createClickUpProbe(
        provider(),
        "owner@example.com",
        "account",
        new AbortController().signal,
        blocked,
        guard,
      ).createTask("1", "Task"),
    ).rejects.toThrow("lost worker");
    expect(blocked).not.toHaveBeenCalled();
  });
});
