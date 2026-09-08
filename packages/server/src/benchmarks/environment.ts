import { randomUUID } from "node:crypto";
import { managedIntegrationAppId } from "@sketch/shared";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "../db/schema";
import type { IntegrationConnection, IntegrationProvider } from "../integrations/types";
import { type IntegrationId, type ProviderIntegration, integrationNames } from "./cases";
import { BenchmarkBlockedError, hashBytes } from "./clickup";
import type { Enrollment } from "./contracts";
import { type BenchmarkTarget, createProviderProbe } from "./provider";
import { createBenchmarkRepository } from "./repository";

const bindingSchema = z.object({
  accountId: z.string(),
  target: z.object({ id: z.string(), name: z.string(), teamId: z.string().optional() }).optional(),
});
type Binding = z.infer<typeof bindingSchema>;
const bindingsSchema = z.record(z.string(), bindingSchema);
export interface ConnectionState {
  integration: ProviderIntegration;
  name: string;
  status: "ready" | "disconnected" | "choose_account" | "choose_target" | "unavailable";
  message?: string;
  accountId?: string;
  accountName?: string;
  accounts: { id: string; name: string }[];
  target?: BenchmarkTarget;
}

export function createBenchmarkEnvironment(
  db: Kysely<DB>,
  loadProvider: () => Promise<IntegrationProvider | null>,
  probeFactory: typeof createProviderProbe = createProviderProbe,
) {
  async function state() {
    let row = await db
      .selectFrom("benchmark_environment")
      .selectAll()
      .where("id", "=", "shared")
      .executeTakeFirstOrThrow();
    if (!row.user_id) {
      const enrollments = (await createBenchmarkRepository(db).enrollments()).filter(
        (entry) => entry.sharedWithBenchmarkTeam,
      );
      const owners = [...new Set(enrollments.map((entry) => entry.userId).filter(Boolean))];
      const settings = await db.selectFrom("settings").select("admin_email").executeTakeFirst();
      const user =
        owners.length === 1
          ? await db
              .selectFrom("users")
              .selectAll()
              .where("id", "=", owners[0] ?? "")
              .executeTakeFirst()
          : owners.length === 0 && settings?.admin_email
            ? await db.selectFrom("users").selectAll().where("email", "=", settings.admin_email).executeTakeFirst()
            : undefined;
      if (user?.email) {
        await db
          .updateTable("benchmark_environment")
          .set({ user_id: user.id, revision: row.revision + 1 })
          .where("id", "=", "shared")
          .where("revision", "=", row.revision)
          .where("user_id", "is", null)
          .execute();
        row = await db
          .selectFrom("benchmark_environment")
          .selectAll()
          .where("id", "=", "shared")
          .executeTakeFirstOrThrow();
      }
    }
    const user = row.user_id
      ? await db.selectFrom("users").selectAll().where("id", "=", row.user_id).executeTakeFirst()
      : null;
    return { row, user, bindings: bindingsSchema.parse(JSON.parse(row.bindings_json)) };
  }
  async function connections() {
    const current = await state();
    if (!current.user?.email)
      return {
        ...current,
        provider: null,
        accounts: [],
        error: "Open the test tenant with the shared admin account to establish its benchmark identity.",
      };
    try {
      const provider = await loadProvider();
      if (!provider)
        return {
          ...current,
          provider: null,
          accounts: [],
          error: "The integration provider is not configured on this tenant.",
        };
      const accounts = await provider.listConnections(
        current.user.email,
        current.user.name,
        provider.providerId ? { workspaceId: provider.providerId, userId: current.user.id } : undefined,
      );
      return { ...current, provider, accounts, error: undefined };
    } catch {
      return {
        ...current,
        provider: null,
        accounts: [],
        error: "Connections could not be checked. Try again; existing connections were not removed.",
      };
    }
  }
  function available(accounts: IntegrationConnection[], integration: ProviderIntegration) {
    return accounts.filter(
      (entry) =>
        (managedIntegrationAppId(entry.appId) ?? (entry.appId === "clickup/clickup" ? "clickup" : null)) ===
          integration &&
        entry.authType !== "api_key" &&
        entry.status === "active" &&
        entry.canUse !== false,
    );
  }
  function selected(accounts: IntegrationConnection[], integration: ProviderIntegration, binding?: Binding) {
    const matches = available(accounts, integration);
    return matches.find((entry) => entry.id === binding?.accountId) ?? (matches.length === 1 ? matches[0] : undefined);
  }
  async function overview() {
    const current = await connections();
    return {
      revision: current.row.revision,
      identity: current.user ? { id: current.user.id, name: current.user.name, email: current.user.email } : null,
      connections: (["clickup", "github", "linear"] as const).map((integration): ConnectionState => {
        const binding = current.bindings[integration];
        const account = selected(current.accounts, integration, binding);
        const target = binding?.accountId === account?.id ? binding?.target : undefined;
        const accounts = available(current.accounts, integration).map((entry) => ({
          id: entry.id,
          name: entry.accountName ?? entry.appName,
        }));
        return {
          integration,
          name: integrationNames[integration],
          accounts,
          status: current.error
            ? "unavailable"
            : !account
              ? accounts.length > 1
                ? "choose_account"
                : "disconnected"
              : target
                ? "ready"
                : "choose_target",
          ...(current.error ? { message: current.error } : {}),
          ...(account ? { accountId: account.id, accountName: account.accountName ?? account.appName } : {}),
          ...(target ? { target } : {}),
        };
      }),
    };
  }
  async function binding(integration: IntegrationId): Promise<Enrollment> {
    const current =
      integration === "none"
        ? { ...(await state()), accounts: [], provider: null, error: undefined }
        : await connections();
    if (!current.user?.email)
      throw new BenchmarkBlockedError(
        "The shared benchmark identity is not configured. Open the e2e tenant using its shared admin login.",
      );
    const base = {
      id: "",
      userId: current.user.id,
      email: current.user.email,
      dedicatedTestAccount: true as const,
      sharedWithBenchmarkTeam: true as const,
    };
    if (integration === "none")
      return {
        ...base,
        integration,
        accountId: "sketch",
        accountName: "Shared Sketch workspace",
        teamId: "0",
        spaceId: "0",
        secondSpaceId: "0",
        bindingFingerprint: hashBytes(JSON.stringify([current.user.id, "none"])),
      };
    if (current.error) throw new BenchmarkBlockedError(current.error);
    const saved = current.bindings[integration];
    const account = selected(current.accounts, integration, saved);
    if (!account)
      throw new BenchmarkBlockedError(`Connect or choose the shared ${integrationNames[integration]} account.`);
    if (!saved?.target || saved.accountId !== account.id)
      throw new BenchmarkBlockedError(
        `Choose the ${integrationNames[integration]} test area before running its cases.`,
      );
    return {
      ...base,
      integration,
      accountId: account.id,
      accountName: account.accountName ?? account.appName,
      target: saved.target,
      teamId: saved.target.teamId ?? "0",
      spaceId: integration === "clickup" ? saved.target.id : "0",
      secondSpaceId: integration === "clickup" ? saved.target.id : "0",
      bindingFingerprint: hashBytes(
        JSON.stringify([
          current.user.id,
          integration,
          current.provider?.providerId,
          account.id,
          account.externalAccountId,
          account.externalTenantId,
          account.accessRevision,
          saved.target,
        ]),
      ),
    };
  }
  async function validate(expected: Enrollment) {
    if (!expected.bindingFingerprint) return;
    const actual = await binding(expected.integration);
    if (actual.bindingFingerprint !== expected.bindingFingerprint)
      throw new BenchmarkBlockedError(
        "The benchmark account or test area changed. This run will not use the replacement connection.",
      );
  }
  async function targets(integration: ProviderIntegration, accountId: string) {
    const current = await connections();
    if (current.error || !current.provider || !current.user?.email)
      throw new BenchmarkBlockedError(current.error ?? "The shared identity is unavailable.");
    if (!available(current.accounts, integration).some((account) => account.id === accountId))
      throw new BenchmarkBlockedError("Choose an active account available to the shared identity.");
    return probeFactory({
      integration,
      provider: current.provider,
      userId: current.user.id,
      email: current.user.email,
      accountId,
      signal: AbortSignal.timeout(60_000),
    }).targets();
  }
  return {
    overview,
    binding,
    validate,
    targets,
    async configure(integration: ProviderIntegration, accountId: string, targetId: string, expectedRevision: number) {
      const { targets: choices } = await targets(integration, accountId);
      const target = choices.find((entry) => entry.id === targetId);
      if (!target) throw new BenchmarkBlockedError("Select an accessible test area from the connected account.");
      const current = await state();
      const result = await db
        .updateTable("benchmark_environment")
        .set({
          revision: expectedRevision + 1,
          bindings_json: JSON.stringify({ ...current.bindings, [integration]: { accountId, target } }),
        })
        .where("id", "=", "shared")
        .where("revision", "=", expectedRevision)
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows))
        throw new BenchmarkBlockedError("Someone changed benchmark setup. Refresh before saving your selection.");
      return overview();
    },
    async establishIdentity(userId: string) {
      const user = await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
      if (!user?.email || user.auth_role !== "admin")
        throw new BenchmarkBlockedError("Use the shared tenant admin account to establish the benchmark identity.");
      const current = await state();
      if (current.row.user_id && current.row.user_id !== userId)
        throw new BenchmarkBlockedError(
          `Benchmarks use ${current.user?.email ?? "the configured shared identity"}. Sign in with that account to manage its integrations.`,
        );
      await db
        .updateTable("benchmark_environment")
        .set({ user_id: userId, revision: current.row.revision + 1 })
        .where("id", "=", "shared")
        .where("revision", "=", current.row.revision)
        .execute();
      return { identity: { email: user.email, name: user.name } };
    },
    async enrollment() {
      const identity = await binding("none");
      const repository = createBenchmarkRepository(db);
      const existing = await repository.enrollmentFor(identity.userId, "sketch");
      return existing ?? repository.enroll({ ...identity, id: randomUUID() });
    },
    async discover(integration: ProviderIntegration) {
      const enrolled = await binding(integration);
      const provider = await loadProvider();
      if (!provider || !enrolled.target) throw new BenchmarkBlockedError("The integration is unavailable.");
      const snapshot = await probeFactory({
        integration,
        provider,
        userId: enrolled.userId,
        email: enrolled.email,
        accountId: enrolled.accountId,
        signal: AbortSignal.timeout(60_000),
        guard: () => validate(enrolled),
      }).discover(enrolled.target);
      return { snapshot, bindingFingerprint: enrolled.bindingFingerprint };
    },
  };
}
