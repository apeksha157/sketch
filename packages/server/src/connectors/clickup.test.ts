/**
 * Tests for the ClickUp connector's retry logic.
 *
 * Verifies that 429 (rate limit) responses are bounded by MAX_RETRIES and
 * do not produce an infinite loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClickUpConnector } from "./clickup";

describe("ClickUp 429 retry bounded", () => {
  const token = "test-api-key";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws after MAX_RETRIES (3) consecutive 429 responses — does not loop infinitely", async () => {
    // Return 429 every time
    fetchSpy.mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    );

    const connector = createClickUpConnector();

    // validateCredentials calls clickupRequest("/user", ...) which will hit 429
    await expect(connector.validateCredentials({ type: "api_key", api_key: token })).rejects.toThrow(
      /rate limited after/i,
    );

    // Should have been called exactly MAX_RETRIES (3) times — not more
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("succeeds on first call when fetch returns 200", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 1, username: "test" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const connector = createClickUpConnector();
    await expect(connector.validateCredentials({ type: "api_key", api_key: token })).resolves.toBeUndefined();
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});

describe("ClickUp refreshTokens expiry check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when token is not yet expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const connector = createClickUpConnector();
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const result = await connector.refreshTokens?.({
      type: "oauth",
      access_token: "existing-token",
      refresh_token: "refresh-token",
      client_id: "client-id",
      client_secret: "client-secret",
      expires_at: futureExpiry,
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when token is expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-token", token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const connector = createClickUpConnector();
    const pastExpiry = new Date(Date.now() - 60 * 1000).toISOString();

    const result = await connector.refreshTokens?.({
      type: "oauth",
      access_token: "old-token",
      refresh_token: "refresh-token",
      client_id: "client-id",
      client_secret: "client-secret",
      expires_at: pastExpiry,
    });

    expect(result).not.toBeNull();
    expect(result?.access_token).toBe("new-token");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
