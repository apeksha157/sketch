import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasProvider } from "../../integrations/canvas";
import {
  CLICKUP_MAX_BODY_BYTES,
  CLICKUP_MAX_PATH_CHARS,
  CLICKUP_MAX_RESPONSE_BYTES,
  ClickUpApiRateLimitError,
  executeClickUpApi,
  handleClickUpApi,
} from "./clickup-api";
import type { SketchMcpDeps } from "./types";

const deps = (getCanvasAccessToken: NonNullable<SketchMcpDeps["getCanvasAccessToken"]>): SketchMcpDeps =>
  ({ getCanvasAccessToken }) as SketchMcpDeps;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClickUp API tool", () => {
  it("uses the complete automation owner identity for fallback credential minting", async () => {
    const provider = new CanvasProvider("https://canvas.example.test", "test-key", "canvas-1");
    const getCanvasAccessToken = vi
      .spyOn(provider, "getCanvasAccessToken")
      .mockResolvedValue({ accessToken: "owner-oauth-token" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ teams: [{ id: "123" }] })));
    await executeClickUpApi(
      { method: "GET", path: "/team", accountId: "owner-account" },
      {
        ...deps(vi.fn()),
        getCanvasAccessToken: undefined,
        loadIntegrationProvider: async () => provider,
        currentUserId: "viewer",
        currentUserEmail: "viewer@example.test",
        integrationUserId: "owner",
        integrationUserEmail: "owner@example.test",
      },
    );
    expect(getCanvasAccessToken).toHaveBeenCalledWith({
      integration: "clickup",
      accountId: "owner-account",
      forceRefresh: false,
      userEmail: "owner@example.test",
      workspaceContext: { workspaceId: "canvas-1", userId: "owner" },
    });
  });

  it.each([null, undefined])("does not mint as the viewer when the owner's email is %s", async (email) => {
    const provider = new CanvasProvider("https://canvas.example.test", "test-key", "canvas-1");
    const getCanvasAccessToken = vi.spyOn(provider, "getCanvasAccessToken");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      executeClickUpApi(
        { method: "GET", path: "/team" },
        {
          ...deps(vi.fn()),
          getCanvasAccessToken: undefined,
          loadIntegrationProvider: async () => provider,
          currentUserId: "viewer",
          currentUserEmail: "viewer@example.test",
          integrationUserId: "owner",
          integrationUserEmail: email,
        },
      ),
    ).rejects.toThrow("authorization is not configured");
    expect(getCanvasAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("executes a bounded v2 request with a Canvas OAuth token", async () => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({
      accessToken: "short-lived-token",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ teams: [{ id: "team-1" }] }), { status: 200 }));

    await expect(
      executeClickUpApi(
        {
          method: "GET",
          path: "/team",
          query: { archived: "false" },
          accountId: "account-1",
        },
        deps(getCanvasAccessToken),
      ),
    ).resolves.toEqual({ teams: [{ id: "team-1" }] });

    expect(getCanvasAccessToken).toHaveBeenCalledWith({
      integration: "clickup",
      accountId: "account-1",
      forceRefresh: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team?archived=false",
      expect.objectContaining({
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer short-lived-token",
        },
      }),
    );
  });

  it("sends JSON bodies without allowing the agent to choose an origin", async () => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "token" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "task-1" }), { status: 200 }));

    await executeClickUpApi(
      {
        method: "POST",
        path: "/list/list-1/task",
        body: { name: "Fix the bug", priority: { priority: "high" } },
      },
      deps(getCanvasAccessToken),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/list/list-1/task",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Fix the bug", priority: { priority: "high" } }),
      }),
    );
  });

  it("force-refreshes and retries exactly once after HTTP 401", async () => {
    const getCanvasAccessToken = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "expired-token" })
      .mockResolvedValueOnce({ accessToken: "fresh-token" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: "user-1" } }), { status: 200 }));

    await expect(executeClickUpApi({ method: "GET", path: "/user" }, deps(getCanvasAccessToken))).resolves.toEqual({
      user: { id: "user-1" },
    });
    expect(getCanvasAccessToken).toHaveBeenNthCalledWith(2, { integration: "clickup", forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { method: "POST" as const, path: "/team/team-1/webhook" },
    { method: "GET" as const, path: "/team/team-1/webhooks" },
    { method: "PUT" as const, path: "/webhook/webhook-1" },
    { method: "DELETE" as const, path: "/WEBHOOKS/webhook-1" },
  ])("rejects unbound or unsupported webhook mutations before minting %s %s", async (args) => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "webhook-token" });

    await expect(executeClickUpApi(args, deps(getCanvasAccessToken))).rejects.toThrow(/webhook/i);
    expect(getCanvasAccessToken).not.toHaveBeenCalled();
  });

  it("redacts signing secrets from webhook inventory without a private raw-response bypass", async () => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "internal-webhook-token" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ webhooks: [{ id: "hook-1", secret: "signing-secret", echo: "signing-secret" }] }),
          { status: 200 },
        ),
      );

    await expect(
      executeClickUpApi({ method: "GET", path: "/team/123/webhook" }, deps(getCanvasAccessToken)),
    ).resolves.toEqual({ webhooks: [{ id: "hook-1", secret: "[redacted]", echo: "[redacted]" }] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([403, 404])("does not mistake provider resource HTTP %s for a disconnected OAuth grant", async (status) => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "token" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "upstream account detail" }), { status }),
    );

    const result = await handleClickUpApi({ method: "GET", path: "/team" }, deps(getCanvasAccessToken));
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `ClickUp API failed: ClickUp API request failed with HTTP ${status}.`,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("upstream account detail");
  });

  it("does not retry rate limits, network failures, or a second 401", async () => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "token" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(executeClickUpApi({ method: "GET", path: "/team" }, deps(getCanvasAccessToken))).rejects.toThrow(
      "HTTP 429",
    );
    expect(getCanvasAccessToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
    getCanvasAccessToken.mockClear();
    getCanvasAccessToken.mockResolvedValue({ accessToken: "network-token" });
    const failedFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(executeClickUpApi({ method: "GET", path: "/team" }, deps(getCanvasAccessToken))).rejects.toThrow(
      "network down",
    );
    expect(getCanvasAccessToken).toHaveBeenCalledOnce();
    expect(failedFetch).toHaveBeenCalledOnce();
  });

  it("returns a typed bounded 429 error with an actionable cooldown and shares it per token", async () => {
    const token = "rate-limit-token";
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }));

    const error = await executeClickUpApi(
      { method: "POST", path: "/team/team-1/task" },
      deps(getCanvasAccessToken),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClickUpApiRateLimitError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 2_000 });
    expect((error as Error).message).toContain("Wait at least 2 seconds before retrying");

    const modelResult = await handleClickUpApi({ method: "GET", path: "/team" }, deps(getCanvasAccessToken));
    expect(modelResult.content[0]?.text).toContain("Wait at least 2 seconds before retrying");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not shorten a long provider rate-limit hint", async () => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "bounded-rate-limit-token" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "999999" } }),
    );

    const error = await executeClickUpApi({ method: "GET", path: "/team" }, deps(getCanvasAccessToken)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ status: 429, retryAfterMs: 999_999_000 });
  });

  it("rejects unsafe paths and oversized bodies before minting a token", async () => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "token" });
    await expect(
      executeClickUpApi({ method: "GET", path: "/team/../user" }, deps(getCanvasAccessToken)),
    ).rejects.toThrow("dot segments");
    await expect(
      executeClickUpApi({ method: "GET", path: "/oauth/token" }, deps(getCanvasAccessToken)),
    ).rejects.toThrow("OAuth endpoints");
    await expect(
      executeClickUpApi({ method: "GET", path: `/${"a".repeat(CLICKUP_MAX_PATH_CHARS)}` }, deps(getCanvasAccessToken)),
    ).rejects.toThrow("relative ClickUp API v2 path");
    await expect(
      executeClickUpApi(
        { method: "POST", path: "/team", body: "x".repeat(CLICKUP_MAX_BODY_BYTES) },
        deps(getCanvasAccessToken),
      ),
    ).rejects.toThrow("request body exceeds");
    expect(getCanvasAccessToken).not.toHaveBeenCalled();
  });

  it("bounds output and redacts a token echoed by the provider", async () => {
    const secret = "very-secret-token";
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: secret });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: secret, data: "x".repeat(CLICKUP_MAX_RESPONSE_BYTES) }), { status: 200 }),
    );

    const result = await handleClickUpApi({ method: "GET", path: "/team" }, deps(getCanvasAccessToken));
    expect(result.content[0]?.text).toContain("exceeds");
    expect(result.content[0]?.text).not.toContain(secret);
  });

  it("redacts OAuth tokens from model output and rejects redirects", async () => {
    const secret = "oauth-token-secret";
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: secret });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error(`redirect blocked while forwarding ${secret}`));

    const result = await handleClickUpApi({ method: "GET", path: "/team" }, deps(getCanvasAccessToken));
    expect(result.content[0]?.text).toContain("redirect blocked");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: `Bearer ${secret}` }),
      }),
    );
  });
});
