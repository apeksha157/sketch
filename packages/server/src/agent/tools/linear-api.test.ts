import { afterEach, describe, expect, it, vi } from "vitest";
import { LINEAR_MAX_QUERY_CHARS, LINEAR_MAX_RESPONSE_BYTES, executeLinearApi, handleLinearApi } from "./linear-api";
import type { SketchMcpDeps } from "./types";

const deps = (getCanvasAccessToken: NonNullable<SketchMcpDeps["getCanvasAccessToken"]>): SketchMcpDeps =>
  ({ getCanvasAccessToken }) as SketchMcpDeps;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Linear API tool", () => {
  it("executes bounded GraphQL with a Canvas token and returns data", async () => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "short-lived-token", expiresAt: "later" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), { status: 200 }));

    await expect(
      executeLinearApi(
        { query: "query Viewer { viewer { id } }", variables: { limit: 1 }, accountId: "account-1" },
        deps(getCanvasAccessToken),
      ),
    ).resolves.toEqual({ viewer: { id: "viewer-1" } });

    expect(getCanvasAccessToken).toHaveBeenCalledWith({
      integration: "linear",
      accountId: "account-1",
      forceRefresh: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer short-lived-token",
          "Content-Type": "application/json",
          "public-file-urls-expire-in": "60",
        },
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));

    await expect(executeLinearApi({ query: "query { viewer { id } }" }, deps(getCanvasAccessToken))).resolves.toEqual({
      ok: true,
    });
    expect(getCanvasAccessToken).toHaveBeenNthCalledWith(2, { integration: "linear", forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429])("does not refresh on HTTP %s", async (status) => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "token" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("failure", { status }));

    await expect(executeLinearApi({ query: "query { viewer { id } }" }, deps(getCanvasAccessToken))).rejects.toThrow(
      status === 403 ? "forbidden" : "rate limit",
    );
    expect(getCanvasAccessToken).toHaveBeenCalledTimes(1);
  });

  it("does not refresh network or GraphQL failures", async () => {
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: "token" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(executeLinearApi({ query: "query { viewer { id } }" }, deps(getCanvasAccessToken))).rejects.toThrow(
      "network down",
    );
    expect(getCanvasAccessToken).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    const secondFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "bad query" }] }), { status: 200 }));
    await expect(executeLinearApi({ query: "query { viewer { id } }" }, deps(getCanvasAccessToken))).rejects.toThrow(
      "bad query",
    );
    expect(getCanvasAccessToken).toHaveBeenCalledTimes(2);
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  it("caps queries and tool output without exposing credentials", async () => {
    const secret = "very-secret-token";
    const getCanvasAccessToken = vi.fn().mockResolvedValue({ accessToken: secret });
    const query = "x".repeat(LINEAR_MAX_QUERY_CHARS + 1);
    await expect(executeLinearApi({ query }, deps(getCanvasAccessToken))).rejects.toThrow("character limit");
    expect(getCanvasAccessToken).not.toHaveBeenCalled();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { value: "x".repeat(LINEAR_MAX_RESPONSE_BYTES) } }), { status: 200 }),
    );
    const result = await handleLinearApi({ query: "query { viewer { id } }" }, deps(getCanvasAccessToken));
    expect(result.content[0]?.text).toContain("exceeds");
    expect(result.content[0]?.text).not.toContain(secret);
  });
});
