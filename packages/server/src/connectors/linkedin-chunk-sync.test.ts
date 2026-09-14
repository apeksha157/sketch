import { describe, expect, it } from "vitest";
import { createTestLogger } from "../test-utils";
import { createLinkedinAimfoxConnector } from "./linkedin-aimfox";
import { splitLinkedinSweepBudget } from "./linkedin-chunk-sync";

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

/**
 * A reindex fills the pending-history set with thousands of conversations at
 * once. Idle-close has to keep a share of every sweep through that, or a live
 * conversation that went quiet keeps an open tail for the whole migration.
 */
describe("LinkedIn sweep budget", () => {
  it("reserves about half the budget for idle-close while a reindex floods the history set", () => {
    expect(splitLinkedinSweepBudget(50, 2_600, 100)).toEqual({ pendingHistory: 25, idle: 25 });
  });

  it("gives the backlog whatever idle-close does not need", () => {
    expect(splitLinkedinSweepBudget(50, 2_600, 3)).toEqual({ pendingHistory: 47, idle: 3 });
    expect(splitLinkedinSweepBudget(50, 2_600, 0)).toEqual({ pendingHistory: 50, idle: 0 });
  });

  it("gives idle-close whatever the backlog does not need", () => {
    expect(splitLinkedinSweepBudget(50, 5, 100)).toEqual({ pendingHistory: 5, idle: 45 });
    expect(splitLinkedinSweepBudget(50, 0, 100)).toEqual({ pendingHistory: 0, idle: 50 });
  });

  it("never promises more than the budget, whatever the odd sizes", () => {
    for (const budget of [1, 3, 7, 50]) {
      for (const pendingHistory of [0, 1, 2, 60]) {
        for (const idle of [0, 1, 2, 60]) {
          const share = splitLinkedinSweepBudget(budget, pendingHistory, idle);
          expect(share.pendingHistory + share.idle).toBeLessThanOrEqual(budget);
          expect(share.pendingHistory).toBeLessThanOrEqual(pendingHistory);
          expect(share.idle).toBeLessThanOrEqual(idle);
          expect(share.pendingHistory + share.idle).toBe(Math.min(budget, pendingHistory + idle));
        }
      }
    }
  });
});
