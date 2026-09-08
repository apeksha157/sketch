import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import { BenchmarkBlockedError } from "./clickup";
import type { Enrollment } from "./contracts";
import { createBenchmarkEnvironment } from "./environment";

export async function benchmarkExecutionProvider(params: {
  db: Kysely<DB>;
  enabled: boolean;
  userId: string | null;
  conversationId?: string;
  taskId?: string;
  loadProvider: () => Promise<IntegrationProvider | null>;
}): Promise<() => Promise<IntegrationProvider | null>> {
  if (!params.enabled || (!params.conversationId && !params.taskId)) return params.loadProvider;
  let query = params.db.selectFrom("benchmark_contexts").selectAll();
  query = params.conversationId
    ? query.where("conversation_id", "=", params.conversationId)
    : query.where("task_id", "=", params.taskId ?? "");
  const context = await query.executeTakeFirst();
  if (!context) return params.loadProvider;
  const binding: Enrollment = JSON.parse(context.binding_json);
  if (!params.userId || binding.userId !== params.userId)
    throw new BenchmarkBlockedError("The benchmark execution identity does not match this conversation.");
  const environment = createBenchmarkEnvironment(params.db, params.loadProvider);
  async function guard(accountId?: string) {
    const run = await params.db
      .selectFrom("benchmark_runs")
      .select(["status", "cancel_requested"])
      .where("id", "=", context?.run_id ?? "")
      .executeTakeFirst();
    if (run?.status !== "running" || run.cancel_requested)
      throw new BenchmarkBlockedError("The benchmark stopped. No further integration actions may start.");
    await environment.validate(binding);
    if (accountId && accountId !== binding.accountId)
      throw new BenchmarkBlockedError(
        "This benchmark is bound to another connection. It cannot switch accounts during execution.",
      );
  }
  await guard();
  return async () => {
    await guard();
    if (binding.integration === "none") return null;
    const provider = await params.loadProvider();
    if (!provider) throw new BenchmarkBlockedError("The benchmark connection is unavailable.");
    return new Proxy(provider, {
      get(target, property, receiver) {
        if (property === "getCanvasAccessToken")
          return async (request: Parameters<NonNullable<IntegrationProvider["getCanvasAccessToken"]>>[0]) => {
            await guard(request.accountId);
            if (request.integration !== binding.integration)
              throw new BenchmarkBlockedError("This case cannot use a different integration.");
            if (!target.getCanvasAccessToken) throw new BenchmarkBlockedError("Managed authorization is unavailable.");
            return target.getCanvasAccessToken({
              ...request,
              userEmail: binding.email,
              accountId: binding.accountId,
              workspaceContext: target.providerId
                ? { workspaceId: target.providerId, userId: binding.userId }
                : undefined,
            });
          };
        if (property === "getGithubAccessToken")
          return async (request: Parameters<NonNullable<IntegrationProvider["getGithubAccessToken"]>>[0]) => {
            await guard(request.accountId);
            if (binding.integration !== "github" || !target.getGithubAccessToken)
              throw new BenchmarkBlockedError("This case has no GitHub connection.");
            return target.getGithubAccessToken({
              ...request,
              userEmail: binding.email,
              accountId: binding.accountId,
              workspaceContext: target.providerId
                ? { workspaceId: target.providerId, userId: binding.userId }
                : undefined,
            });
          };
        if (property === "listConnections")
          return async () => {
            await guard();
            return (
              await target.listConnections(
                binding.email,
                undefined,
                target.providerId ? { workspaceId: target.providerId, userId: binding.userId } : undefined,
              )
            ).filter((entry) => entry.id === binding.accountId);
          };
        if (property === "getBrokerSpec") return () => null;
        if (
          property === "executeAction" ||
          property === "removeConnection" ||
          property === "initiateConnection" ||
          property === "updateConnectionAccess"
        )
          return async () => {
            throw new BenchmarkBlockedError(
              "Use the managed integration tools for this case. Connection management remains available in the tenant UI.",
            );
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}
