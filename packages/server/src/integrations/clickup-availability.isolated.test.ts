import type { IntegrationConnection } from "@sketch/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAvailableManagedIntegrations } from "./availability";
import { CanvasProviderRequestError } from "./canvas";
import { recordClickUpRateLimit } from "./clickup-request-budget";
import type { IntegrationProvider } from "./types";

function connection(
  appId: string,
  overrides: Partial<Pick<IntegrationConnection, "id" | "authType" | "status" | "canUse" | "healthy" | "source">> = {},
): IntegrationConnection {
  return {
    id: "secrets:user-1:clickup:clickup",
    providerId: "canvas-provider",
    source: "canvas_user_secrets",
    executionMode: "canvas",
    appId,
    appName: appId,
    status: "active",
    authType: appId === "clickup" ? "oauth" : "api_key",
    canUse: true,
    healthy: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    connectedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function provider(
  listConnections: IntegrationProvider["listConnections"],
  getCanvasAccessToken: IntegrationProvider["getCanvasAccessToken"] = vi
    .fn()
    .mockResolvedValue({ accessToken: "test-token" }),
): IntegrationProvider {
  return {
    type: "canvas",
    providerId: "canvas-provider",
    listConnections,
    getCanvasAccessToken,
  } as IntegrationProvider;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("managed integration availability", () => {
  it("uses the actor/workspace context and counts only active usable ClickUp connections", async () => {
    const listConnections = vi
      .fn()
      .mockResolvedValue([
        connection("clickup-api-key"),
        connection("clickup"),
        connection("clickup", { status: "error" }),
        connection("clickup", { canUse: false }),
        connection("clickup", { healthy: false }),
        connection("clickup", { source: "pipedream" }),
      ]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 1 } }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ teams: [{ id: "team-1" }] }), { status: 200 })),
    );

    const available = await listAvailableManagedIntegrations({
      loadIntegrationProvider: vi.fn().mockResolvedValue(provider(listConnections)),
      userEmail: "user@example.com",
      currentUserId: "user-1",
    });

    expect(available).toEqual(new Set(["clickup"]));
    expect(listConnections).toHaveBeenCalledWith("user@example.com", undefined, {
      workspaceId: "canvas-provider",
      userId: "user-1",
    });
  });

  it.each(["discovery", "mint"])("waits for valid ClickUp access when %s exceeds three seconds", async (stage) => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    const delay = async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    };
    const canvas = provider(
      vi.fn(async () => {
        if (stage === "discovery") await delay();
        return [connection("clickup")];
      }),
      vi.fn(async () => {
        if (stage === "mint") await delay();
        return { accessToken: "test-token" };
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(url.endsWith("/user") ? { user: { id: 1 } } : { teams: [{ id: "team-1" }] })),
      ),
    );
    const availability = listAvailableManagedIntegrations({
      loadIntegrationProvider: async () => canvas,
      userEmail: "user@example.com",
      currentUserId: "user-1",
      logger,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(availability).resolves.toEqual(new Set(["clickup"]));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails closed when Canvas is absent or misconfigured", async () => {
    await expect(
      listAvailableManagedIntegrations({
        loadIntegrationProvider: vi.fn().mockResolvedValue(null),
        userEmail: "user@example.com",
        currentUserId: "user-1",
      }),
    ).resolves.toEqual(new Set());

    await expect(
      listAvailableManagedIntegrations({
        loadIntegrationProvider: vi.fn().mockRejectedValue(new Error("credential sentinel")),
        userEmail: "user@example.com",
        currentUserId: "user-1",
      }),
    ).resolves.toEqual(new Set());
  });

  it("does not hide other integrations when the ClickUp credential request times out", async () => {
    const result = listAvailableManagedIntegrations({
      loadIntegrationProvider: async () =>
        provider(
          vi.fn().mockResolvedValue([connection("github"), connection("linear"), connection("clickup")]),
          vi.fn().mockRejectedValue(new DOMException("Request timed out", "TimeoutError")),
        ),
      userEmail: "user@example.com",
      currentUserId: "user-1",
    });
    await expect(result).resolves.toEqual(new Set(["github", "linear"]));
  });

  it("reuses a bounded validation result while still checking current access and exact-account minting", async () => {
    vi.useFakeTimers();
    const listConnections = vi.fn().mockResolvedValue([connection("clickup")]);
    const mint = vi.fn().mockResolvedValue({ accessToken: "adoption-cache-token" });
    const canvas = provider(listConnections, mint);
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async (url: string) =>
          new Response(JSON.stringify(url.endsWith("/user") ? { user: { id: 1 } } : { teams: [{ id: "team-1" }] })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const params = {
      loadIntegrationProvider: async () => canvas,
      userEmail: "user@example.com",
      currentUserId: "user-1",
    };
    await expect(listAvailableManagedIntegrations(params)).resolves.toEqual(new Set(["clickup"]));
    await expect(listAvailableManagedIntegrations(params)).resolves.toEqual(new Set(["clickup"]));
    expect(mint).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(listAvailableManagedIntegrations(params)).resolves.toEqual(new Set(["clickup"]));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    listConnections.mockResolvedValue([connection("clickup", { canUse: false })]);
    await expect(listAvailableManagedIntegrations(params)).resolves.toEqual(new Set());
    expect(mint).toHaveBeenCalledTimes(3);
  });

  it.each([{ user: {} }, { user: null }, { teams: [] }, { teams: [null] }])(
    "never adopts a malformed successful response %j",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(
            async (url: string) =>
              new Response(
                JSON.stringify(
                  (url.endsWith("/user") && "user" in body) || (url.endsWith("/team") && "teams" in body)
                    ? body
                    : url.endsWith("/user")
                      ? { user: { id: 1 } }
                      : { teams: [{ id: "team-1" }] },
                ),
              ),
          ),
      );
      await expect(
        listAvailableManagedIntegrations({
          loadIntegrationProvider: async () => provider(vi.fn().mockResolvedValue([connection("clickup")])),
          userEmail: "user@example.com",
          currentUserId: "user-1",
        }),
      ).resolves.toEqual(new Set());
    },
  );

  it("honors the same known token cooldown as ordinary API work without probing or reconnecting", async () => {
    const token = "known-cooldown-token";
    recordClickUpRateLimit(token, new Headers({ "Retry-After": "600" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listAvailableManagedIntegrations({
        loadIntegrationProvider: async () =>
          provider(
            vi.fn().mockResolvedValue([connection("clickup")]),
            vi.fn().mockResolvedValue({ accessToken: token }),
          ),
        userEmail: "user@example.com",
        currentUserId: "user-1",
      }),
    ).resolves.toEqual(new Set());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates every eligible Canvas account by its opaque ID without selecting one", async () => {
    const accountIds = ["secrets:user-1:clickup:clickup", "secrets:owner-1:clickup:clickup"];
    const listConnections = vi.fn().mockResolvedValue(accountIds.map((id) => connection("clickup", { id })));
    const getCanvasAccessToken = vi.fn().mockImplementation(async ({ accountId }) => ({ accessToken: accountId }));
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const endpoint = url.endsWith("/user") ? "user" : "team";
      return new Response(JSON.stringify(endpoint === "user" ? { user: { id: 1 } } : { teams: [{ id: "team-1" }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listAvailableManagedIntegrations({
        loadIntegrationProvider: vi.fn().mockResolvedValue(provider(listConnections, getCanvasAccessToken)),
        userEmail: "user@example.com",
        currentUserId: "user-1",
      }),
    ).resolves.toEqual(new Set(["clickup"]));

    expect(getCanvasAccessToken).toHaveBeenCalledTimes(2);
    expect(getCanvasAccessToken.mock.calls.map(([request]) => request.accountId)).toEqual(
      expect.arrayContaining(accountIds),
    );
    for (const call of getCanvasAccessToken.mock.calls) {
      expect(call[0]).toMatchObject({
        integration: "clickup",
        workspaceContext: { workspaceId: "canvas-provider", userId: "user-1" },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps SHARD_009 uncertain when the user is valid but no ClickUp workspace is authorized", async () => {
    const logger = { warn: vi.fn() };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 1 } }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ECODE: "SHARD_009", err: "Team not found" }), { status: 404 }),
        ),
    );

    await expect(
      listAvailableManagedIntegrations({
        loadIntegrationProvider: vi
          .fn()
          .mockResolvedValue(provider(vi.fn().mockResolvedValue([connection("clickup")]))),
        userEmail: "user@example.com",
        currentUserId: "user-1",
        logger,
      }),
    ).resolves.toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith(
      { event: "managed_integration_clickup_validation_failed", reason: "uncertain_workspace" },
      "ClickUp managed integration validation failed closed",
    );
  });

  it.each([
    ["transient upstream failure", 503, "transient"],
    ["revoked token", 401, "revoked_or_missing"],
    ["resource-level forbidden", 403, "uncertain_workspace"],
  ] as const)("distinguishes %s without reconnecting", async (_label, status, reason) => {
    const logger = { warn: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "failure" }), { status })));

    await expect(
      listAvailableManagedIntegrations({
        loadIntegrationProvider: vi
          .fn()
          .mockResolvedValue(provider(vi.fn().mockResolvedValue([connection("clickup")]))),
        userEmail: "user@example.com",
        currentUserId: "user-1",
        logger,
      }),
    ).resolves.toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith(
      { event: "managed_integration_clickup_validation_failed", reason },
      "ClickUp managed integration validation failed closed",
    );
  });

  it.each([403, 404] as const)(
    "distinguishes Canvas mint authorization failure %s from direct API resource errors",
    async (status) => {
      const logger = { warn: vi.fn() };
      const getCanvasAccessToken = vi
        .fn()
        .mockRejectedValue(new CanvasProviderRequestError(status, "OAUTH", "Canvas authorization failed"));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        listAvailableManagedIntegrations({
          loadIntegrationProvider: vi
            .fn()
            .mockResolvedValue(provider(vi.fn().mockResolvedValue([connection("clickup")]), getCanvasAccessToken)),
          userEmail: "user@example.com",
          currentUserId: "user-1",
          logger,
        }),
      ).resolves.toEqual(new Set());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { event: "managed_integration_clickup_validation_failed", reason: "revoked_or_missing" },
        "ClickUp managed integration validation failed closed",
      );
    },
  );
});
