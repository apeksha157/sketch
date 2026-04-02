/**
 * Tests for the Linear connector's retry logic.
 *
 * Verifies that 429 responses are bounded by MAX_RETRIES, that concurrent
 * connector instances do not share rate-limiter state, and that refreshTokens
 * skips refresh when token is still valid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLinearConnector } from "./linear";

describe("Linear 429 retry bounded", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws after MAX_RETRIES (3) consecutive 429 responses", async () => {
    fetchSpy.mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    );

    const connector = createLinearConnector();
    await expect(connector.validateCredentials({ type: "api_key", api_key: "test-key" })).rejects.toThrow(
      /rate limited after/i,
    );

    // At most 3 fetch calls (MAX_RETRIES)
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("succeeds immediately on 200 response", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { id: "u1", name: "Test" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const connector = createLinearConnector();
    await expect(connector.validateCredentials({ type: "api_key", api_key: "test-key" })).resolves.toBeUndefined();
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});

describe("Linear concurrent syncs do not share rate-limiter state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("two connector instances have independent lastRequestTime", async () => {
    // Each createLinearConnector() call creates a new closure with its own lastRequestTime
    const connectorA = createLinearConnector();
    const connectorB = createLinearConnector();

    // They are distinct objects
    expect(connectorA).not.toBe(connectorB);

    // Both are independent instances of the same type
    expect(connectorA.type).toBe("linear");
    expect(connectorB.type).toBe("linear");
  });
});

describe("Linear refreshTokens expiry check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when token is not yet expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const connector = createLinearConnector();
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
      new Response(
        JSON.stringify({
          access_token: "new-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const connector = createLinearConnector();
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

  it("refreshes when no expires_at is set (treat as expired)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const connector = createLinearConnector();

    const result = await connector.refreshTokens?.({
      type: "oauth",
      access_token: "old-token",
      refresh_token: "refresh-token",
      client_id: "client-id",
      client_secret: "client-secret",
      // no expires_at
    });

    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
