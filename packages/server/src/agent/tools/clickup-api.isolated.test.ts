import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasProvider, CanvasProviderRequestError } from "../../integrations/canvas";
import {
  CLICKUP_MAX_ATTACHMENT_BYTES,
  CLICKUP_MAX_BODY_BYTES,
  CLICKUP_MAX_PATH_CHARS,
  CLICKUP_MAX_RESPONSE_BYTES,
  ClickUpApiRateLimitError,
  ClickUpUploadUncertainError,
  executeClickUpApi,
  handleClickUpApi,
} from "./clickup-api";
import type { SketchMcpDeps } from "./types";

const deps = (getCanvasAccessToken: NonNullable<SketchMcpDeps["getCanvasAccessToken"]>): SketchMcpDeps =>
  ({ getCanvasAccessToken }) as SketchMcpDeps;

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sketch-clickup-api-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

  it.each(["truncated", "omitted"])(
    "returns exact authorized account IDs for a %s account selection",
    async (selection) => {
      const provider = new CanvasProvider("https://canvas.example.test", "test-key", "canvas-1");
      const accountId = "secrets:owner-1:clickup:clickup";
      const listConnections = vi.spyOn(provider, "listConnections").mockResolvedValue([
        {
          id: accountId,
          appId: "clickup",
          appName: "ClickUp",
          providerId: "canvas-1",
          status: "active",
          createdAt: "2026-09-07T00:00:00Z",
          source: "canvas_user_secrets",
          authType: "oauth",
          canUse: true,
        },
      ]);
      const getCanvasAccessToken = vi
        .fn()
        .mockRejectedValue(
          selection === "truncated"
            ? new CanvasProviderRequestError(400, "BAD_REQUEST", "Invalid Canvas-owned account id")
            : new CanvasProviderRequestError(403, "FORBIDDEN", "Account unavailable"),
        );
      const result = await handleClickUpApi(
        {
          method: "GET",
          path: "/team",
          ...(selection === "truncated" ? { accountId: "secrets:owner-1:clickup" } : {}),
        },
        {
          ...deps(getCanvasAccessToken),
          loadIntegrationProvider: async () => provider,
          currentUserId: "viewer-1",
          currentUserEmail: "viewer@example.test",
          integrationUserId: "owner-1",
          integrationUserEmail: "owner@example.test",
        },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(accountId);
      expect(result.content[0].text).toContain("verbatim");
      expect(result.content[0].text).not.toContain("Reconnect it");
      expect(listConnections).toHaveBeenCalledWith("owner@example.test", undefined, {
        workspaceId: "canvas-1",
        userId: "owner-1",
      });
      expect(getCanvasAccessToken).toHaveBeenCalledOnce();
    },
  );

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

  it("rejects attachment JSON bytes at the transport boundary before authorization", async () => {
    const getCanvasAccessToken = vi.fn();
    await expect(
      executeClickUpApi(
        { method: "POST", path: "/task/task-1/attachment", accountId: "account-1", body: { base64: "bytes" } },
        deps(getCanvasAccessToken),
      ),
    ).rejects.toThrow("require trusted local files");
    expect(getCanvasAccessToken).not.toHaveBeenCalled();
  });

  it("serializes trusted local files as native ClickUp multipart attachments", async () => {
    const root = await createTemporaryRoot();
    const filePath = join(root, "report.txt");
    await writeFile(filePath, "attachment bytes");
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "multipart-token" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const rawHeaders = new Headers(init?.headers);
      expect(rawHeaders.has("content-type")).toBe(false);
      const request = new Request(input, init);
      const form = await request.formData();
      expect([...form.keys()]).toEqual(["attachment"]);
      const parts = form.getAll("attachment");
      expect(parts).toHaveLength(1);
      const part = parts[0];
      expect(part).toBeInstanceOf(File);
      expect((part as File).name).toBe("reported-name.txt");
      expect((part as File).type).toBe("text/plain");
      await expect((part as File).text()).resolves.toBe("attachment bytes");
      return new Response(JSON.stringify({ id: "attachment-1" }), { status: 200 });
    });

    await expect(
      executeClickUpApi(
        {
          method: "POST",
          path: "/task/task-1/attachment",
          accountId: "account-1",
          files: [{ path: filePath, filename: "reported-name.txt", contentType: "text/plain" }],
        },
        { ...deps(getCanvasAccessToken), workspaceDir: root },
      ),
    ).resolves.toEqual({ id: "attachment-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getCanvasAccessToken).toHaveBeenCalledWith({
      integration: "clickup",
      accountId: "account-1",
      forceRefresh: false,
    });
  });

  it("rejects untrusted attachment paths, URLs, symlinks, and multiple files before credential access", async () => {
    const root = await createTemporaryRoot();
    const outsideRoot = await createTemporaryRoot();
    const trustedPath = join(root, "trusted.txt");
    const outsidePath = join(outsideRoot, "outside.txt");
    const symlinkPath = join(root, "linked.txt");
    await writeFile(trustedPath, "trusted");
    await writeFile(outsidePath, "outside");
    await symlink(trustedPath, symlinkPath);
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "untrusted-token" });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const attachment = (path: string) => ({
      method: "POST" as const,
      path: "/task/task-1/attachment",
      files: [{ path }],
    });

    await expect(
      executeClickUpApi(attachment(outsidePath), { ...deps(getCanvasAccessToken), workspaceDir: root }),
    ).rejects.toThrow("outside the trusted automation file roots");
    await expect(
      executeClickUpApi(attachment("https://example.test/file"), { ...deps(getCanvasAccessToken), workspaceDir: root }),
    ).rejects.toThrow("absolute trusted local path");
    await expect(
      executeClickUpApi(attachment("relative.txt"), { ...deps(getCanvasAccessToken), workspaceDir: root }),
    ).rejects.toThrow("absolute trusted local path");
    await expect(
      executeClickUpApi(attachment(symlinkPath), { ...deps(getCanvasAccessToken), workspaceDir: root }),
    ).rejects.toThrow("regular, non-symlink");
    await expect(
      executeClickUpApi(
        {
          method: "POST",
          path: "/task/task-1/attachment",
          files: [{ path: trustedPath }, { path: trustedPath }],
        },
        { ...deps(getCanvasAccessToken), workspaceDir: root },
      ),
    ).rejects.toThrow("at most 1 local file");
    expect(getCanvasAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the per-file attachment byte limit", async () => {
    const root = await createTemporaryRoot();
    const largeFile = join(root, "large.bin");
    await writeFile(largeFile, Buffer.alloc(CLICKUP_MAX_ATTACHMENT_BYTES + 1));
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "size-token" });
    await expect(
      executeClickUpApi(
        { method: "POST", path: "/task/task-1/attachment", files: [{ path: largeFile }] },
        { ...deps(getCanvasAccessToken), workspaceDir: root },
      ),
    ).rejects.toThrow("per-file limit");

    expect(getCanvasAccessToken).not.toHaveBeenCalled();
  });

  it("honors cancellation before reading and preserves uncertainty after a sent upload", async () => {
    const root = await createTemporaryRoot();
    const filePath = join(root, "cancel.txt");
    await writeFile(filePath, "cancel me");
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "cancel-token" });
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      executeClickUpApi(
        { method: "POST", path: "/task/task-1/attachment", files: [{ path: filePath }] },
        { ...deps(getCanvasAccessToken), workspaceDir: root },
        controller.signal,
      ),
    ).rejects.toThrow(/aborted|cancelled/i);
    expect(getCanvasAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const uncertainFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket closed"));
    const uploadError = await executeClickUpApi(
      { method: "POST", path: "/task/task-1/attachment", files: [{ path: filePath }] },
      { ...deps(getCanvasAccessToken), workspaceDir: root },
    ).catch((error: unknown) => error);
    expect(uploadError).toBeInstanceOf(ClickUpUploadUncertainError);
    expect((uploadError as Error).message).not.toContain("cancel-token");
    expect(uncertainFetch).toHaveBeenCalledOnce();
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
