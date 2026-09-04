import { describe, expect, it } from "vitest";
import { SalesqlClient } from "./salesql-client";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

describe("SalesqlClient", () => {
  it("parses envelopes and flat payloads, maps misses and rate limits, and sends the expected request", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return response({
          person: {
            emails: [{ email: "Jane@Acme.test", type: "Work", status: "Valid" }],
            phones: [{ phone: "4155551234", type: "Personal", country_code: "US", is_valid: true }],
          },
        });
      }
      if (calls.length === 2) {
        return response({
          emails: [{ email: "direct@example.test", type: "Direct", status: "Unverifiable" }],
          phones: [],
        });
      }
      if (calls.length === 3) return response({ error: "Person not found" }, { status: 404 });
      return response({ error: "rate" }, { status: 429, headers: { "Retry-After": "7" } });
    };
    const client = new SalesqlClient("secret-key", { fetchFn, sleep: async () => {}, maxRpm: 100_000 });

    await expect(client.enrichByLinkedinUrl("https://www.linkedin.com/in/jane")).resolves.toEqual({
      kind: "found",
      emails: [{ email: "jane@acme.test", type: "work", verified: true }],
      phones: [{ phone: "4155551234", type: "personal", countryCode: "US", valid: true }],
    });
    await expect(client.enrichByLinkedinUrl("https://www.linkedin.com/in/direct")).resolves.toEqual({
      kind: "found",
      emails: [{ email: "direct@example.test", type: "direct", verified: false }],
      phones: [],
    });
    await expect(client.enrichByLinkedinUrl("https://www.linkedin.com/in/missing")).resolves.toEqual({
      kind: "not_found",
    });
    await expect(client.enrichByLinkedinUrl("https://www.linkedin.com/in/limited")).resolves.toEqual({
      kind: "rate_limited",
      retryAfterMs: 7000,
    });

    const firstUrl = new URL(calls[0].url);
    expect(firstUrl.origin).toBe("https://api-public.salesql.com");
    expect(firstUrl.pathname).toBe("/v1/persons/enrich");
    expect(firstUrl.searchParams.get("linkedin_url")).toBe("https://www.linkedin.com/in/jane");
    expect(calls[0].init?.headers).toEqual({ Authorization: "Bearer secret-key" });
  });
});
