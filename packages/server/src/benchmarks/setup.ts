import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Config } from "../config";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import { BenchmarkBlockedError, createClickUpProbe } from "./clickup";
import { enrollmentSchema } from "./contracts";
import { createBenchmarkEnvironment } from "./environment";
import { createBenchmarkRepository } from "./repository";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

export async function createSetupLink(db: Kysely<DB>, config: Config) {
  if (!config.BASE_URL) throw new BenchmarkBlockedError("The test tenant URL is not configured.");
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  await db.deleteFrom("benchmark_setup_links").where("expires_at", "<", new Date().toISOString()).execute();
  await db
    .insertInto("benchmark_setup_links")
    .values({ token_hash: tokenHash(token), expires_at: expiresAt, used_at: null })
    .execute();
  return { url: `${config.BASE_URL.replace(/\/$/, "")}/benchmark-setup#token=${token}`, expiresAt };
}

/** Setup links carry no login authority. Enrollment requires the real Sketch session and explicit team consent. */
export function benchmarkSetupRoutes(deps: {
  db: Kysely<DB>;
  config: Config;
  provider: () => Promise<IntegrationProvider | null>;
}) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    if (!deps.config.BENCHMARKS_ENABLED) return c.json({ error: "Benchmarks are disabled." }, 503);
    if (!c.get("sub")) return c.json({ error: "Sign in to the test tenant first." }, 401);
    await next();
  });
  routes.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof BenchmarkBlockedError
            ? error.message
            : "The setup request is invalid or the link expired. Create a fresh link from Benchmarks.",
      },
      400,
    ),
  );
  routes.post("/identity", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    return c.json(await createBenchmarkEnvironment(deps.db, deps.provider).establishIdentity(c.get("sub")));
  });
  async function context(userId: string, token: string) {
    tokenSchema.parse(token);
    const grant = await deps.db
      .selectFrom("benchmark_setup_links")
      .select("token_hash")
      .where("token_hash", "=", tokenHash(token))
      .where("used_at", "is", null)
      .where("expires_at", ">", new Date().toISOString())
      .executeTakeFirst();
    if (!grant)
      throw new BenchmarkBlockedError(
        "This setup link expired or was already used. Create a new link from Benchmarks.",
      );
    const user = await createUserRepository(deps.db).findById(userId);
    if (!user?.email) throw new BenchmarkBlockedError("Sign in to Sketch with an email identity before enrolling.");
    return user;
  }
  async function connections(user: Awaited<ReturnType<typeof context>>) {
    const provider = await deps.provider();
    const accounts = provider
      ? (await provider.listConnections(user.email ?? "")).filter(
          (connection) =>
            ["clickup", "clickup/clickup"].includes(connection.appId) &&
            connection.status === "active" &&
            connection.canUse !== false,
        )
      : [];
    return { provider, accounts };
  }
  routes.post("/context", async (c) => {
    const { token } = z
      .object({ token: tokenSchema })
      .strict()
      .parse(await c.req.json());
    const user = await context(c.get("sub"), token);
    const result = await connections(user)
      .then((value) => ({ ...value, connectionError: undefined as string | undefined }))
      .catch(() => ({
        accounts: [],
        connectionError:
          "Connections could not be checked. Try again when the integration provider is available. Core setup is still available.",
      }));
    return c.json({
      owner: { name: user.name, email: user.email },
      connections: result.accounts.map((account) => ({ id: account.id, name: account.accountName ?? account.appName })),
      connectionError: result.connectionError,
      connectUrl: "/integrations?connect=clickup",
    });
  });
  routes.post("/locations", async (c) => {
    const { token, accountId } = z
      .object({ token: tokenSchema, accountId: z.string().min(1).max(256) })
      .strict()
      .parse(await c.req.json());
    const user = await context(c.get("sub"), token);
    const { provider, accounts } = await connections(user).catch(() => {
      throw new BenchmarkBlockedError("ClickUp is unavailable. Try again when the integration connection is restored.");
    });
    if (!provider || !accounts.some((account) => account.id === accountId))
      throw new BenchmarkBlockedError("Select your own active ClickUp connection.");
    return c.json({
      locations: await createClickUpProbe(
        provider,
        user.email ?? "",
        accountId,
        AbortSignal.timeout(60_000),
      ).locations(),
    });
  });
  routes.post("/enrollment", async (c) => {
    const { token, enrollment } = z
      .object({ token: tokenSchema, enrollment: enrollmentSchema.extend({ sharedWithBenchmarkTeam: z.literal(true) }) })
      .strict()
      .parse(await c.req.json());
    const user = await context(c.get("sub"), token);
    let accountName = "Sketch workspace";
    if (enrollment.integration === "clickup") {
      const { provider, accounts } = await connections(user).catch(() => {
        throw new BenchmarkBlockedError(
          "ClickUp is unavailable. Try again when the integration connection is restored.",
        );
      });
      accountName =
        accounts.find((account) => account.id === enrollment.accountId)?.accountName ?? "ClickUp test account";
      if (!provider || !accounts.some((account) => account.id === enrollment.accountId))
        throw new BenchmarkBlockedError("Select your own active ClickUp connection.");
      await createClickUpProbe(provider, user.email ?? "", enrollment.accountId, AbortSignal.timeout(60_000)).validate(
        enrollment,
      );
    } else if (enrollment.accountId !== "sketch")
      throw new BenchmarkBlockedError("Invalid core-automation test identity.");
    await deps.db.transaction().execute(async (trx) => {
      const consumed = await trx
        .updateTable("benchmark_setup_links")
        .set({ used_at: new Date().toISOString() })
        .where("token_hash", "=", tokenHash(token))
        .where("used_at", "is", null)
        .where("expires_at", ">", new Date().toISOString())
        .executeTakeFirst();
      if (!Number(consumed.numUpdatedRows))
        throw new BenchmarkBlockedError("The setup link was already used or expired.");
      await createBenchmarkRepository(trx).enroll({
        ...enrollment,
        accountName,
        id: randomUUID(),
        userId: user.id,
        email: user.email ?? "",
      });
    });
    return c.json({
      success: true,
      message: "The test profile is available in Platform Benchmarks. You can close this tab.",
    });
  });
  return routes;
}
