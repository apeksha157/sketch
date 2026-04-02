/**
 * System API routes — internal management endpoints authenticated by bearer token.
 * Used by managed deployments to update configuration (e.g. Slack tokens) remotely.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

type SlackTokensCallback = (tokens: { botToken: string; appToken?: string }) => unknown;

interface SystemDeps {
  systemSecret: string;
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  onSlackTokensUpdated?: Function;
  userRepo?: UserRepo;
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  startWhatsAppPairing?: Function;
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  cancelWhatsAppPairing?: Function;
}

const tokenSchema = z.object({
  botToken: z.string().min(1),
  appToken: z.string().optional(),
});

const identitySchema = z.object({
  adminEmail: z.string().email(),
  adminPasswordHash: z.string().min(1),
  orgName: z.string().optional(),
  botName: z.string().optional(),
});

const llmSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("anthropic"),
    apiKey: z.string().min(1),
  }),
  z.object({
    provider: z.literal("bedrock"),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    region: z.string().min(1),
  }),
]);

async function verifyAnthropicApiKey(apiKey: string): Promise<void> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "Ping" }],
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("invalid_auth");
  }

  if (!response.ok) {
    throw new Error("verification_failed");
  }
}

export function systemRoutes(settings: SettingsRepo, deps: SystemDeps) {
  const routes = new Hono();

  routes.use("/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth || auth !== `Bearer ${deps.systemSecret}`) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid system secret" } }, 401);
    }
    return next();
  });

  routes.put("/slack/tokens", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: "botToken is required" } }, 400);
    }

    const { botToken, appToken } = parsed.data;
    await settings.update({
      slackBotToken: botToken,
      ...(appToken ? { slackAppToken: appToken } : {}),
    });

    if (deps.onSlackTokensUpdated) {
      const cb = deps.onSlackTokensUpdated as SlackTokensCallback;
      await cb({ botToken, ...(appToken ? { appToken } : {}) });
    }

    return c.json({ success: true });
  });

  routes.put("/identity", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = identitySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    const { adminEmail, adminPasswordHash, orgName, botName } = parsed.data;

    const existing = await settings.get();
    if (existing) {
      await settings.update({
        adminEmail,
        adminPasswordHash,
        ...(orgName !== undefined ? { orgName } : {}),
        ...(botName !== undefined ? { botName } : {}),
      });
    } else {
      await settings.create({
        adminEmail,
        adminPasswordHash,
        ...(orgName !== undefined ? { orgName } : {}),
        ...(botName !== undefined ? { botName } : {}),
      });
    }

    if (deps.userRepo) {
      const existingUser = await deps.userRepo.findByEmail(adminEmail);
      if (existingUser) {
        await deps.userRepo.update(existingUser.id, { role: "admin" });
      } else {
        const namePart = adminEmail.split("@")[0];
        await deps.userRepo.create({ name: namePart, email: adminEmail, role: "admin" });
      }
    }

    return c.json({ ok: true });
  });

  routes.put("/llm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = llmSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    const data = parsed.data;
    if (data.provider === "anthropic") {
      try {
        await verifyAnthropicApiKey(data.apiKey);
      } catch {
        return c.json({ error: { code: "INVALID_LLM_CREDENTIALS", message: "Invalid Anthropic API key" } }, 400);
      }
      await settings.update({
        llmProvider: "anthropic",
        anthropicApiKey: data.apiKey,
      });
    } else {
      // TODO: Bedrock credential verification deferred -- no existing verification logic for AWS credentials
      await settings.update({
        llmProvider: "bedrock",
        awsAccessKeyId: data.accessKeyId,
        awsSecretAccessKey: data.secretAccessKey,
        awsRegion: data.region,
      });
    }

    return c.json({ ok: true });
  });

  routes.get("/whatsapp/pair", async (c) => {
    if (!deps.startWhatsAppPairing) {
      return c.json({ error: { code: "NOT_FOUND", message: "WhatsApp pairing not available" } }, 404);
    }
    return deps.startWhatsAppPairing(c);
  });

  routes.delete("/whatsapp/pair", async (c) => {
    if (deps.cancelWhatsAppPairing) {
      deps.cancelWhatsAppPairing();
    }
    return c.json({ ok: true });
  });

  routes.post("/onboarding/complete", async (c) => {
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    return c.json({ ok: true });
  });

  return routes;
}
