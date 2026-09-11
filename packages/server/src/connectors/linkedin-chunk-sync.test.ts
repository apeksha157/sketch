import { describe, expect, it } from "vitest";
import { createTestLogger } from "../test-utils";
import { createLinkedinAimfoxConnector } from "./linkedin-aimfox";

const credentials = { type: "api_key", api_key: "key" } as const;
const scopeConfig = { accountIds: ["acct-1"] };

const v2Account = {
  highWatermark: "2026-09-01T00:00:00.000Z",
  watermarkStalls: 2,
  backfillBefore: "2026-06-01T00:00:00.000Z",
  backfillDone: false,
  backfillStalls: 1,
  directionVersion: 1,
};

async function roundTripCursor(stored: unknown): Promise<Record<string, unknown>> {
  const cursor = await createLinkedinAimfoxConnector().getCursor({
    credentials,
    scopeConfig,
    currentCursor: stored === null ? null : JSON.stringify(stored),
    logger: createTestLogger(),
  });
  return JSON.parse(cursor ?? "{}");
}

/**
 * Routing onto the chunk engine is a durable database fact (D13), so the cursor
 * carries nothing about it and must stay exactly the v2 shape that shipped
 * before the engine — otherwise turning the engine on re-walks every inbox.
 */
describe("LinkedIn Aimfox cursor", () => {
  it("round-trips a v2 cursor unchanged", async () => {
    const stored = { version: 2, accounts: { "acct-1": v2Account } };

    expect(await roundTripCursor(stored)).toEqual(stored);
  });

  it("resets a foreign cursor version", async () => {
    expect(await roundTripCursor({ version: 99, accounts: { "acct-1": v2Account } })).toEqual({
      version: 2,
      accounts: {},
    });
  });
});
