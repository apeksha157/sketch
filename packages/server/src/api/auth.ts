/**
 * Auth routes — admin login (password), member login (magic link), session management.
 * JWTs are signed with a per-deployment secret stored in the settings table,
 * so sessions survive server restarts. Cookie-based with httpOnly, sameSite=lax.
 */
import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { verifyEmailToken } from "../auth/email-verify";
import { signJwt, verifyJwt } from "../auth/jwt";
import { createRateLimitedMagicLinkToken, findVerifiedUserByEmail, verifyMagicLinkToken } from "../auth/magic-link";
import { verifyPassword } from "../auth/password";
import type { Config } from "../config";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { createEmailTransport, sendMagicLinkEmail } from "../email";
import { getSmtpConfig, resolveBaseUrl } from "./shared";

export const SESSION_COOKIE = "sketch_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function setSessionCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function createSession(
  c: Context,
  sub: string,
  role: "admin" | "member",
  jwtSecret: string,
): Promise<void> {
  const token = await signJwt(sub, role, jwtSecret);
  setSessionCookie(c, token, isSecure(c));
}

export function authRoutes(settings: SettingsRepo, db: Kysely<DB>, deps: { config: Config; logger: Logger }) {
  const routes = new Hono();

  routes.post("/login", async (c) => {
    const row = await settings.get();
    if (!row?.admin_email || !row?.admin_password_hash) {
      return c.json({ error: { code: "SETUP_REQUIRED", message: "Admin account not configured" } }, 503);
    }

    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Email and password required" } }, 400);
    }

    const emailMatch = body.email.toLowerCase() === row.admin_email.toLowerCase();
    const passwordMatch = emailMatch && (await verifyPassword(body.password, row.admin_password_hash));

    if (!emailMatch || !passwordMatch) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid credentials" } }, 401);
    }

    // Backfill jwt_secret for accounts created before the JWT migration
    let jwtSecret = row.jwt_secret;
    if (!jwtSecret) {
      jwtSecret = randomBytes(32).toString("hex");
      await settings.update({ jwtSecret });
    }

    await createSession(c, row.admin_email, "admin", jwtSecret);
    return c.json({ authenticated: true, email: row.admin_email });
  });

  routes.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ authenticated: false });
  });

  routes.get("/session", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) {
      // Dev-only auto-login: if enabled and an admin account exists, issue
      // an admin session so fresh preview browsers (Claude Code preview tool,
      // incognito windows, Playwright) can load the dashboard without a
      // manual login. Gated on NODE_ENV !== "production" as a belt-and-braces
      // check in case DEV_AUTO_LOGIN leaks into a real deployment.
      if (deps.config.DEV_AUTO_LOGIN && deps.config.NODE_ENV !== "production") {
        const row = await settings.get();
        if (row?.admin_email && row.jwt_secret && row.onboarding_completed_at) {
          await createSession(c, row.admin_email, "admin", row.jwt_secret);
          deps.logger.warn({ email: row.admin_email }, "DEV_AUTO_LOGIN: auto-issued admin session");
          return c.json({
            authenticated: true,
            role: "admin" as const,
            email: row.admin_email,
          });
        }
      }
      return c.json({ authenticated: false });
    }

    const row = await settings.get();
    if (!row?.jwt_secret) {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ authenticated: false });
    }

    const payload = await verifyJwt(token, row.jwt_secret);
    if (!payload) {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ authenticated: false });
    }

    // Sliding renewal — issue a fresh JWT to extend the session
    await createSession(c, payload.sub, payload.role, row.jwt_secret);

    if (payload.role === "member") {
      const user = await db.selectFrom("users").selectAll().where("id", "=", payload.sub).executeTakeFirst();
      if (!user) {
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return c.json({ authenticated: false });
      }
      return c.json({
        authenticated: true,
        role: "member" as const,
        userId: user.id,
        name: user.name,
        email: user.email,
      });
    }

    return c.json({
      authenticated: true,
      role: "admin" as const,
      email: payload.sub,
    });
  });

  routes.get("/verify-email", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.redirect("/?verification=invalid");
    }

    const result = await verifyEmailToken(db, token);
    if (!result) {
      return c.redirect("/?verification=invalid");
    }

    return c.redirect("/?verification=success");
  });

  // --- Magic link login ---

  routes.post("/magic-link", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    if (!body.email) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Email required" } }, 400);
    }

    const email = body.email.toLowerCase().trim();

    // Always return success (prevent email enumeration)
    const successResponse = { success: true };

    const user = await findVerifiedUserByEmail(db, email);
    if (!user) return c.json(successResponse);

    // Atomic rate-limit check + token creation in a single transaction
    const token = await createRateLimitedMagicLinkToken(db, user.id);
    if (!token) return c.json(successResponse);

    const baseUrl = resolveBaseUrl(c, deps.config);
    const magicLinkUrl = `${baseUrl}/api/auth/magic-link/verify?token=${token}`;

    // Reuse settings already fetched by the middleware cache path where possible,
    // but we need SMTP config which requires a fresh read.
    const settingsRow = await settings.get();
    const smtp = settingsRow ? getSmtpConfig(settingsRow) : null;
    if (smtp) {
      const transport = createEmailTransport(smtp);
      await sendMagicLinkEmail(transport, email, magicLinkUrl, settingsRow?.bot_name ?? "Sketch", smtp.from);
    } else {
      deps.logger.info({ magicLinkUrl }, "Magic link (SMTP not configured)");
    }

    return c.json(successResponse);
  });

  routes.get("/magic-link/verify", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.redirect("/login?error=invalid_link");
    }

    const userId = await verifyMagicLinkToken(db, token);
    if (!userId) {
      return c.redirect("/login?error=expired_link");
    }

    const settingsRow = await settings.get();
    if (!settingsRow?.jwt_secret) {
      return c.redirect("/login?error=server_error");
    }

    await createSession(c, userId, "member", settingsRow.jwt_secret);
    return c.redirect("/");
  });

  return routes;
}
