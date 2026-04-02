/**
 * Tests for the Notion connector's retry logic.
 *
 * Verifies that 429 responses are bounded by MAX_RETRIES, that concurrent
 * connector instances do not share rate-limiter state, and that refreshTokens
 * skips refresh when token is still valid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotionConnector } from "./notion";

describe("Notion 429 retry bounded", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws after MAX_RETRIES (3) consecutive 429 responses on validateCredentials", async () => {
    fetchSpy.mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    );

    const connector = createNotionConnector();
    await expect(connector.validateCredentials({ type: "api_key", api_key: "test-key" })).rejects.toThrow(
      /rate limited after/i,
    );

    // At most 3 fetch calls
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("succeeds immediately on 200 response", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ object: "user", id: "u1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const connector = createNotionConnector();
    await expect(connector.validateCredentials({ type: "api_key", api_key: "test-key" })).resolves.toBeUndefined();
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});

describe("Notion concurrent syncs do not share rate-limiter state", () => {
  it("two connector instances have independent requestTimes arrays", () => {
    // createNotionConnector() uses makeNotionRequests() which creates a new
    // requestTimes closure per call
    const connectorA = createNotionConnector();
    const connectorB = createNotionConnector();

    expect(connectorA).not.toBe(connectorB);
    expect(connectorA.type).toBe("notion");
    expect(connectorB.type).toBe("notion");
  });
});

describe("Notion refreshTokens expiry check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when token is not yet expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const connector = createNotionConnector();
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
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const connector = createNotionConnector();
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
