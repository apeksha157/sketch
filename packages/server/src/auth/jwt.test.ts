import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt } from "./jwt";

const SECRET = "a".repeat(64);

describe("JWT sign and verify", () => {
  it("signJwt() produces a token that verifyJwt() can decode", async () => {
    const token = await signJwt("admin@example.com", "admin", SECRET);
    const payload = await verifyJwt(token, SECRET);
    expect(payload).toEqual({ sub: "admin@example.com", role: "admin" });
  });

  it("verifyJwt() returns correct sub and role for member tokens", async () => {
    const token = await signJwt("user-123", "member", SECRET);
    const payload = await verifyJwt(token, SECRET);
    expect(payload).toEqual({ sub: "user-123", role: "member" });
  });

  it("verifyJwt() returns null for a token signed with a different secret", async () => {
    const token = await signJwt("admin@example.com", "admin", SECRET);
    const payload = await verifyJwt(token, "b".repeat(64));
    expect(payload).toBeNull();
  });

  it("verifyJwt() returns null for malformed tokens", async () => {
    expect(await verifyJwt("not-a-jwt", SECRET)).toBeNull();
    expect(await verifyJwt("", SECRET)).toBeNull();
    expect(await verifyJwt("a.b.c", SECRET)).toBeNull();
  });

  it("verifyJwt() returns null for an expired token", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ sub: "admin@example.com", role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("0s")
      .sign(new TextEncoder().encode(SECRET));

    const payload = await verifyJwt(token, SECRET);
    expect(payload).toBeNull();
  });

  it("verifyJwt() defaults role to admin for old tokens without role claim", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ sub: "admin@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode(SECRET));

    const payload = await verifyJwt(token, SECRET);
    expect(payload).toEqual({ sub: "admin@example.com", role: "admin" });
  });

  it("verifyJwt() returns email field when present in JWT payload", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({
      sub: "550e8400-e29b-41d4-a716-446655440000",
      role: "admin",
      email: "admin@example.com",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode(SECRET));

    const payload = await verifyJwt(token, SECRET);
    expect(payload).toEqual({
      sub: "550e8400-e29b-41d4-a716-446655440000",
      role: "admin",
      email: "admin@example.com",
    });
  });

  it("verifyJwt() omits email field when not present in JWT payload", async () => {
    const token = await signJwt("admin@example.com", "admin", SECRET);
    const payload = await verifyJwt(token, SECRET);
    expect(payload).toEqual({ sub: "admin@example.com", role: "admin" });
    expect(payload).not.toHaveProperty("email");
  });
});
