import { describe, expect, it } from "vitest";
import { getIntegrationActor } from "./types";

describe("integration actor identity", () => {
  it.each([
    [{}, { userId: "viewer", userEmail: "viewer@example.test" }],
    [
      { integrationUserId: "owner", integrationUserEmail: "owner@example.test" },
      { userId: "owner", userEmail: "owner@example.test" },
    ],
    [
      { integrationUserId: "owner", integrationUserEmail: null },
      { userId: "owner", userEmail: null },
    ],
    [{ integrationUserId: "owner" }, { userId: "owner", userEmail: null }],
    [{ integrationUserEmail: "owner@example.test" }, { userId: null, userEmail: "owner@example.test" }],
    [
      { integrationUserId: null, integrationUserEmail: null },
      { userId: null, userEmail: null },
    ],
    [{ integrationUserId: null }, { userId: null, userEmail: null }],
  ])("never combines an explicit actor override %j with the viewer", (override, expected) => {
    expect(getIntegrationActor({ currentUserId: "viewer", userEmail: "viewer@example.test", ...override })).toEqual(
      expected,
    );
  });
});
