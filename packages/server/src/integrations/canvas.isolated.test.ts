import { constants, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialEnvelope } from "../connectors/credential-envelope";
import { CanvasProvider, type CanvasProviderRequestError } from "./canvas";

function encryptForTest(payload: unknown, publicKeyPem: string): CredentialEnvelope {
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  const encryptedKey = publicEncrypt(
    {
      key: publicKeyPem,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    contentKey,
  );
  return {
    version: 1,
    algorithm: "RSA-OAEP-256+A256GCM",
    keyId: "key-1",
    encryptedKey: encryptedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

describe("CanvasProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves Canvas account access metadata when listing connections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accounts: [
            {
              id: "secrets:owner-1:notion:notion",
              source: "canvas_user_secrets",
              name: "Notion",
              accountName: "Engineering Notion",
              authType: "oauth",
              healthy: true,
              status: "active",
              app: { name: "Notion", nameSlug: "notion", imgSrc: "https://img.test/notion.png" },
              accessLevel: "organization",
              ownerUserId: "owner-1",
              ownerName: "Tara",
              isOwnedByViewer: false,
              canUse: true,
              canManageAccess: false,
              canDelete: false,
              connectedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(fetchMock).toHaveBeenCalledWith("https://canvas.example.com/api/pipedream/accounts", {
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
      },
      signal: expect.any(AbortSignal),
    });
    expect(connections[0]).toMatchObject({
      id: "secrets:owner-1:notion:notion",
      providerId: "provider-1",
      source: "canvas_user_secrets",
      appId: "notion",
      appName: "Notion",
      accountName: "Engineering Notion",
      authType: "oauth",
      accessLevel: "organization",
      ownerUserId: "owner-1",
      ownerName: "Tara",
      isOwnedByViewer: false,
      canUse: true,
      canManageAccess: false,
      canDelete: false,
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("sends the current Sketch display name to Canvas when listing connections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accounts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await provider.listConnections("priya@example.com", "Priya Shah");

    expect(fetchMock).toHaveBeenCalledWith("https://canvas.example.com/api/pipedream/accounts", {
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
        "X-User-Name": "Priya Shah",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects managed GitHub and Linear connection mutations before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");

    await expect(provider.removeConnection("priya@example.com", "secrets:owner-1:github:github")).rejects.toMatchObject(
      {
        status: 409,
        code: "CLI_INTEGRATION",
      },
    );
    await expect(
      provider.updateConnectionAccess("priya@example.com", "secrets:owner-1:github:github", "organization"),
    ).rejects.toMatchObject({ status: 409, code: "CLI_INTEGRATION" });
    await expect(provider.removeConnection("priya@example.com", "secrets:owner-1:linear:linear")).rejects.toMatchObject(
      { status: 409, code: "CLI_INTEGRATION" },
    );
    await expect(
      provider.updateConnectionAccess("priya@example.com", "secrets:owner-1:linear:linear", "organization"),
    ).rejects.toMatchObject({ status: 409, code: "CLI_INTEGRATION" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves Canvas error codes when initiating app connections", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "App not found" } }), { status: 404 }),
        ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");

    await expect(provider.initiateConnection("priya@example.com", "google-gmail-oauth", "")).rejects.toMatchObject({
      name: "CanvasProviderRequestError",
      status: 404,
      code: "NOT_FOUND",
      message: "App not found",
    } satisfies Partial<CanvasProviderRequestError>);
  });

  it("does not expose or initiate the ClickUp API-token Canvas app", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            data: [
              { nameSlug: "clickup", name: "ClickUp", description: "OAuth" },
              { nameSlug: "clickup-api-key", name: "ClickUp", description: "API token" },
            ],
            pageInfo: { endCursor: null, hasMore: false },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await expect(provider.listApps("clickup")).resolves.toMatchObject({
      apps: [expect.objectContaining({ id: "clickup" })],
    });
    await expect(provider.initiateConnection("priya@example.com", "clickup-api-key", "")).rejects.toMatchObject({
      status: 409,
      code: "OAUTH_REQUIRED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("lists only OAuth ClickUp accounts for managed access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:user-1:clickup:clickup",
                source: "canvas_user_secrets",
                name: "ClickUp",
                app: { name: "ClickUp", nameSlug: "clickup" },
                authType: "oauth",
                healthy: true,
                status: "active",
              },
              {
                id: "secrets:user-1:clickup-api-key:clickup-api-key",
                source: "canvas_user_secrets",
                name: "ClickUp",
                app: { name: "ClickUp", nameSlug: "clickup-api-key" },
                authType: "api_key",
                healthy: true,
                status: "active",
              },
              {
                id: "legacy-clickup",
                source: "canvas_user_secrets",
                name: "ClickUp",
                app: { name: "ClickUp", nameSlug: "clickup" },
                authType: "api_key",
                healthy: true,
                status: "active",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");
    expect(connections).toHaveLength(1);
    expect(connections).toMatchObject([{ appId: "clickup", authType: "oauth" }]);
  });

  it("keeps Canvas-owned ClickUp OAuth accounts when legacy metadata omits authType", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:user-1:clickup:clickup",
                source: "canvas_user_secrets",
                name: "ClickUp",
                app: { name: "ClickUp", nameSlug: "clickup" },
                healthy: true,
                status: "active",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await expect(provider.listConnections("priya@example.com")).resolves.toMatchObject([
      { appId: "clickup", source: "canvas_user_secrets", authType: "oauth" },
    ]);
  });

  it("keeps ClickUp out of the Canvas CLI broker while leaving OAuth app discovery available", () => {
    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const policy = provider.getBrokerSpec({
      userEmail: "priya@example.com",
      claudeConfigDir: "/tmp/sketch",
    }).argvPolicy;
    expect(
      provider.getBrokerSpec({ userEmail: "priya@example.com", claudeConfigDir: "/tmp/sketch" }).credentialEnv
        .CANVAS_BLOCKED_APP_IDS,
    ).toContain("clickup");

    expect(policy?.(["search-apps", "clickup"])).toMatchObject({ allowed: false });
    expect(policy?.(["search-apps", "google-drive"])).toEqual({ allowed: true });
  });

  it("classifies legacy Canvas access rows as Canvas-owned when source is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:owner-1:notion:notion",
                name: "Notion",
                healthy: true,
                app: { name: "Notion", nameSlug: "notion" },
                accessLevel: "personal",
                isOwnedByViewer: true,
                canManageAccess: true,
                canDelete: true,
                connectedAt: "2026-01-03T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections[0]).toMatchObject({
      id: "secrets:owner-1:notion:notion",
      source: "canvas_user_secrets",
      accessLevel: "personal",
      canManageAccess: true,
      canDelete: true,
    });
  });

  it("keeps plain account rows as Pipedream when no Canvas access metadata is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "apn_123",
                name: "Slack",
                healthy: true,
                app: { name: "Slack", nameSlug: "slack" },
                created_at: "2026-01-04T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections[0]).toMatchObject({
      id: "apn_123",
      source: "pipedream",
      appId: "slack",
      appName: "Slack",
    });
  });

  it("omits Canvas accounts the viewer cannot use", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:owner-1:notion:notion",
                source: "canvas_user_secrets",
                name: "Notion",
                app: { name: "Notion", nameSlug: "notion" },
                healthy: true,
                accessLevel: "organization",
                canUse: true,
              },
              {
                id: "secrets:owner-1:linear:linear",
                source: "canvas_user_secrets",
                name: "Linear",
                app: { name: "Linear", nameSlug: "linear" },
                healthy: true,
                accessLevel: "personal",
                canUse: false,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections.map((connection) => connection.appId)).toEqual(["notion"]);
  });

  it("hides legacy Canvas GitHub rows even without app metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [{ id: "secrets:owner-1:github:github", name: "GitHub", healthy: true }],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await expect(provider.listConnections("priya@example.com")).resolves.toEqual([]);
  });

  it("hides legacy Canvas GitHub and Linear rows identified only by their display name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [{ id: "apn_github_1", name: "GitHub", healthy: true }],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await expect(provider.listConnections("priya@example.com")).resolves.toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ accounts: [{ id: "apn_linear_1", name: "Linear", healthy: true }] }), {
          status: 200,
        }),
      ),
    );
    await expect(provider.listConnections("priya@example.com")).resolves.toEqual([]);
  });

  it("omits non-owner personal Canvas accounts even when canUse is incorrectly true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:owner-1:github:github",
                source: "canvas_user_secrets",
                name: "GitHub",
                app: { name: "GitHub", nameSlug: "github" },
                healthy: true,
                accessLevel: "personal",
                isOwnedByViewer: false,
                canUse: true,
              },
              {
                id: "secrets:owner-1:slack:slack",
                source: "canvas_user_secrets",
                name: "Slack",
                app: { name: "Slack", nameSlug: "slack" },
                healthy: true,
                accessLevel: "organization",
                isOwnedByViewer: false,
                canUse: true,
              },
              {
                id: "secrets:viewer-1:notion:notion",
                source: "canvas_user_secrets",
                name: "Notion",
                app: { name: "Notion", nameSlug: "notion" },
                healthy: true,
                accessLevel: "personal",
                isOwnedByViewer: true,
                canUse: true,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections.map((connection) => connection.appId)).toEqual(["slack", "notion"]);
  });

  it("does not infer Canvas ownership solely from canonical secret account IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:owner-1:fireflies:fireflies",
                name: "Fireflies",
                healthy: true,
                app: { name: "Fireflies", nameSlug: "fireflies" },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections[0]).toMatchObject({
      id: "secrets:owner-1:fireflies:fireflies",
      source: "pipedream",
      appId: "fireflies",
      appName: "Fireflies",
    });
    expect(connections[0].canManageAccess).toBeUndefined();
    expect(connections[0].canDelete).toBeUndefined();
  });

  it("forwards access updates with the real viewer email", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await provider.updateConnectionAccess("priya@example.com", "secrets:owner-1:notion:notion", "organization");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://canvas.example.com/api/canvas-accounts/secrets%3Aowner-1%3Anotion%3Anotion/access",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
          "X-User-Email": "priya@example.com",
        },
        body: JSON.stringify({ accessLevel: "organization" }),
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("throws Canvas error details from access updates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: "Bad Request",
            message: "Only Canvas-owned accounts can be shared",
          }),
          { status: 400 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");

    await expect(
      provider.updateConnectionAccess("priya@example.com", "pd-account", "organization"),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "Only Canvas-owned accounts can be shared",
    });
  });

  it("executes a Canvas action through the configured REST endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { id: "task-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");

    await expect(
      provider.executeAction({
        userEmail: "priya@example.com",
        componentKey: "clickup-create-task-with-attachment",
        configuredProps: { name: "Bug report" },
      }),
    ).resolves.toEqual({ id: "task-1" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://canvas.example.com/api/direct-executions/action");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
      },
      body: JSON.stringify({
        componentKey: "clickup-create-task-with-attachment",
        configuredProps: { name: "Bug report" },
      }),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("propagates caller cancellation to Canvas action requests", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const controller = new AbortController();
    const request = provider.executeAction(
      {
        userEmail: "priya@example.com",
        componentKey: "clickup-create-task",
        configuredProps: {},
      },
      controller.signal,
    );

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("mints Sketch connector credentials with user and role headers", async () => {
    const envelope = {
      version: 1,
      algorithm: "RSA-OAEP-256+A256GCM",
      keyId: "key-1",
      encryptedKey: "encrypted-key",
      iv: "iv",
      tag: "tag",
      ciphertext: "ciphertext",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            connectorType: "teams",
            provider: "microsoft",
            credentialKind: "oauth_access_token",
            expiresAt: "2026-01-01T01:00:00.000Z",
            envelope,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const result = await provider.mintConnectorCredential({
      userEmail: "priya@example.com",
      connectorType: "teams",
      publicKeyId: "key-1",
      accountId: "secrets:user-1:microsoft:microsoft-teams-oauth",
      userName: "Priya Shah",
      userOrgRole: "admin",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://canvas.example.com/api/sketch/credentials/mint", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
        "X-User-Name": "Priya Shah",
        "X-User-Org-Role": "admin",
      },
      body: JSON.stringify({
        connectorType: "teams",
        publicKeyId: "key-1",
        accountId: "secrets:user-1:microsoft:microsoft-teams-oauth",
      }),
      signal: expect.any(AbortSignal),
    });
    expect(result).toMatchObject({
      connectorType: "teams",
      provider: "microsoft",
      credentialKind: "oauth_access_token",
      envelope,
    });
  });

  it("rejects malformed Sketch connector credential mint responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { connectorType: "teams" } }), {
          status: 200,
        }),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await expect(
      provider.mintConnectorCredential({
        userEmail: "priya@example.com",
        connectorType: "teams",
      }),
    ).rejects.toThrow("Canvas credential mint returned an invalid response");
  });

  it("mints and rechecks a cached actor-scoped ClickUp OAuth token without exposing the envelope", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const envelope = encryptForTest(
      {
        type: "oauth_access_token",
        connectorType: "clickup",
        provider: "clickup",
        accessToken: "clickup-short-lived-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      publicKeyPem,
    );
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              connectorType: "clickup",
              provider: "clickup",
              credentialKind: "oauth_access_token",
              expiresAt: "2099-02-01T00:00:00.000Z",
              envelope,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1", {
      credentialPrivateKeyPem: privateKeyPem,
      credentialPublicKeyId: "key-1",
    });
    const request = {
      integration: "clickup" as const,
      userEmail: "priya@example.com",
      accountId: "clickup-account-1",
      workspaceContext: { workspaceId: "provider-1", userId: "user-1" },
    };

    await expect(provider.getCanvasAccessToken(request)).resolves.toEqual({
      accessToken: "clickup-short-lived-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await expect(provider.getCanvasAccessToken(request)).resolves.toEqual({
      accessToken: "clickup-short-lived-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    vi.advanceTimersByTime(11 * 60_000);
    await expect(provider.getCanvasAccessToken(request)).resolves.toEqual({
      accessToken: "clickup-short-lived-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("https://canvas.example.com/api/sketch/credentials/mint", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
        "X-Sketch-Workspace-Id": "provider-1",
        "X-Sketch-Workspace-User-Id": "user-1",
      },
      body: JSON.stringify({
        connectorType: "clickup",
        publicKeyId: "key-1",
        accountId: "clickup-account-1",
      }),
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("clickup-short-lived-token");
  });

  it("rejects a Canvas ClickUp personal-token envelope", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const envelope = encryptForTest(
      {
        type: "api_key",
        connectorType: "clickup",
        provider: "clickup-api-key",
        apiKey: "pk_clickup-token",
      },
      publicKeyPem,
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            connectorType: "clickup",
            provider: "clickup-api-key",
            credentialKind: "api_key",
            envelope,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1", {
      credentialPrivateKeyPem: privateKeyPem,
      credentialPublicKeyId: "key-1",
    });

    await expect(
      provider.getCanvasAccessToken({
        integration: "clickup",
        userEmail: "priya@example.com",
        workspaceContext: { workspaceId: "provider-1", userId: "user-1" },
      }),
    ).rejects.toThrow("Canvas clickup credential response did not contain the requested credential");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("pk_clickup-token");
  });
});
