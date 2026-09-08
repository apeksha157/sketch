import { describe, expect, it } from "vitest";
import { resolveContentPrincipals, resolveMembershipPrincipals } from "./principals";

function userRepo(verifiedEmails: string[], authRole: "admin" | "member" = "member") {
  return {
    list: async () => [],
    findById: async () =>
      ({
        id: "user-1",
        email: "unverified@example.com",
        whatsapp_number: null,
        slack_user_id: null,
        whatsapp_lid: null,
        auth_role: authRole,
      }) as never,
    getAllEmailsForUser: async () => ["unverified@example.com"],
    getVerifiedEmailsForUser: async () => verifiedEmails,
  };
}

describe("resolveMembershipPrincipals", () => {
  it("does not resolve an unverified primary email as an authorization principal", async () => {
    const principals = await resolveMembershipPrincipals({
      currentUserId: "user-1",
      userRepo: userRepo([]),
    });

    expect(principals).not.toContainEqual({ type: "email", value: "unverified@example.com" });
  });

  it("resolves a verified email as an authorization principal", async () => {
    const principals = await resolveMembershipPrincipals({
      currentUserId: "user-1",
      userRepo: userRepo(["verified@example.com"]),
    });

    expect(principals).toContainEqual({ type: "email", value: "verified@example.com" });
  });
});

describe("resolveContentPrincipals", () => {
  it("bypasses only when the public MCP opts in and no explicit principals are set", async () => {
    const admin = userRepo(["admin@example.com"], "admin");

    await expect(
      resolveContentPrincipals({
        currentUserId: "user-1",
        userRepo: admin,
        adminBypass: { enabled: true },
        publicMcp: { userPrincipals: undefined, adminReadAll: true },
      }),
    ).resolves.toBeUndefined();

    await expect(
      resolveContentPrincipals({
        currentUserId: "user-1",
        userRepo: admin,
        adminBypass: { enabled: true },
        publicMcp: { filterEntityMetadata: true },
      }),
    ).resolves.toEqual([{ type: "email", value: "admin@example.com" }]);

    await expect(
      resolveContentPrincipals({
        currentUserId: "user-1",
        userRepo: admin,
        adminBypass: { enabled: true },
        publicMcp: { userPrincipals: [{ type: "email", value: "scoped@example.com" }] },
      }),
    ).resolves.toEqual([{ type: "email", value: "scoped@example.com" }]);
  });
});
