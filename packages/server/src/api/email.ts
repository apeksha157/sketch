/**
 * Email channel API — SMTP configuration and verification code delivery.
 */
import { randomInt } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { SmtpConfig } from "../email/send";
import { sendVerificationCode, verifySmtp } from "../email/send";
import { requireAdmin } from "./middleware";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

const smtpSchema = z.object({
  host: z.string().min(1, "SMTP host is required"),
  port: z.coerce.number().int().min(1).max(65535),
  user: z.string().min(1, "SMTP username is required"),
  password: z.string().min(1, "SMTP password is required"),
  from: z.string().min(1, "From address is required"),
  secure: z.boolean().default(true),
});

const sendCodeSchema = z.object({
  email: z.string().email("Invalid email address"),
});

/** Extract SMTP config from a settings row, or null if not configured. */
export function getSmtpConfig(
  row: {
    smtp_host: string | null;
    smtp_port: number | null;
    smtp_user: string | null;
    smtp_password: string | null;
    smtp_from: string | null;
    smtp_secure: number;
  } | null,
): SmtpConfig | null {
  if (!row?.smtp_host || !row?.smtp_port || !row?.smtp_user || !row?.smtp_password || !row?.smtp_from) {
    return null;
  }
  return {
    host: row.smtp_host,
    port: row.smtp_port,
    user: row.smtp_user,
    password: row.smtp_password,
    from: row.smtp_from,
    secure: row.smtp_secure === 1,
  };
}

/** Generate a 6-digit verification code. */
function generateCode(): string {
  return String(randomInt(100000, 999999));
}

/**
 * In-memory verification code store.
 * Maps email → { code, expiresAt }.
 * In production this would use Redis or DB — fine for single-process.
 */
const pendingCodes = new Map<string, { code: string; expiresAt: number }>();

/** Verify a code for an email. Returns true if valid, false otherwise. */
export function verifyCode(email: string, code: string): boolean {
  const entry = pendingCodes.get(email.toLowerCase());
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    pendingCodes.delete(email.toLowerCase());
    return false;
  }
  if (entry.code !== code) return false;
  pendingCodes.delete(email.toLowerCase());
  return true;
}

export function emailRoutes(settings: SettingsRepo) {
  const routes = new Hono();

  /** Test SMTP connection without saving. */
  routes.post("/verification", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = smtpSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    try {
      await verifySmtp(parsed.data);
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      return c.json({ error: { code: "SMTP_VERIFY_FAILED", message: `SMTP verification failed: ${message}` } }, 400);
    }
  });

  /** Save SMTP configuration (verifies first). */
  routes.put("/config", requireAdmin(), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = smtpSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    try {
      await verifySmtp(parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      return c.json({ error: { code: "SMTP_VERIFY_FAILED", message: `SMTP verification failed: ${message}` } }, 400);
    }

    await settings.update({
      smtpHost: parsed.data.host,
      smtpPort: parsed.data.port,
      smtpUser: parsed.data.user,
      smtpPassword: parsed.data.password,
      smtpFrom: parsed.data.from,
      smtpSecure: parsed.data.secure ? 1 : 0,
    });

    return c.json({ success: true });
  });

  /** Remove SMTP configuration. */
  routes.delete("/config", requireAdmin(), async (c) => {
    await settings.update({
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPassword: null,
      smtpFrom: null,
      smtpSecure: null,
    });
    return c.json({ success: true });
  });

  /** Send a verification code to an email address. Requires SMTP to be configured. */
  routes.post("/verification-codes", async (c) => {
    const row = await settings.get();
    const smtp = getSmtpConfig(row);
    if (!smtp) {
      return c.json({ error: { code: "SMTP_NOT_CONFIGURED", message: "Email (SMTP) is not configured" } }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = sendCodeSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const code = generateCode();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    pendingCodes.set(parsed.data.email.toLowerCase(), { code, expiresAt });

    try {
      await sendVerificationCode(smtp, {
        to: parsed.data.email,
        code,
        botName: row?.bot_name ?? undefined,
      });
      return c.json({ success: true });
    } catch (err) {
      pendingCodes.delete(parsed.data.email.toLowerCase());
      const message = err instanceof Error ? err.message : "Failed to send email";
      return c.json({ error: { code: "SEND_FAILED", message: `Failed to send verification code: ${message}` } }, 500);
    }
  });

  /** Verify a code that was sent to an email. */
  routes.post("/verification-codes/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ email: z.string().email(), code: z.string().length(6) }).safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const valid = verifyCode(parsed.data.email, parsed.data.code);
    if (!valid) {
      return c.json({ error: { code: "INVALID_CODE", message: "Invalid or expired code" } }, 400);
    }

    return c.json({ success: true, email: parsed.data.email });
  });

  return routes;
}
