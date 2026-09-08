import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/schema";
import type { BenchmarkRun, Enrollment } from "./contracts";

export function createBenchmarkRepository(db: Kysely<DB>) {
  return {
    async enroll(value: Enrollment) {
      const current = await db
        .selectFrom("benchmark_enrollments")
        .selectAll()
        .where("user_id", "=", value.userId)
        .where("account_id", "=", value.accountId)
        .executeTakeFirst();
      if (current?.active_run_id)
        throw new Error("Finish or reconcile the active batch before changing the test account.");
      if (current) {
        const result = await db
          .updateTable("benchmark_enrollments")
          .set({ config_json: JSON.stringify({ ...value, id: current.id }) })
          .where("id", "=", current.id)
          .where("active_run_id", "is", null)
          .executeTakeFirst();
        if (!Number(result.numUpdatedRows)) throw new Error("A batch started while the enrollment was changing.");
        return { ...value, id: current.id };
      }
      await db
        .insertInto("benchmark_enrollments")
        .values({
          id: value.id,
          user_id: value.userId,
          account_id: value.accountId,
          config_json: JSON.stringify(value),
          active_run_id: null,
        })
        .execute();
      return value;
    },
    async enrollmentFor(userId: string, accountId?: string): Promise<Enrollment | null> {
      let query = db.selectFrom("benchmark_enrollments").select("config_json").where("user_id", "=", userId);
      if (accountId) query = query.where("account_id", "=", accountId);
      const row = await query.orderBy("id").executeTakeFirst();
      return row ? JSON.parse(row.config_json) : null;
    },
    async enrollmentById(id: string): Promise<Enrollment | null> {
      const row = await db
        .selectFrom("benchmark_enrollments")
        .select("config_json")
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? JSON.parse(row.config_json) : null;
    },
    async enrollments(): Promise<Enrollment[]> {
      return (
        await db
          .selectFrom("benchmark_enrollments")
          .select("config_json")
          .orderBy("created_at", "desc")
          .limit(100)
          .execute()
      ).map((row) => JSON.parse(row.config_json));
    },
    async insert(run: BenchmarkRun) {
      await db
        .insertInto("benchmark_runs")
        .values({
          id: run.id,
          enrollment_id: run.enrollmentId,
          status: run.status,
          document_json: JSON.stringify(run),
          worker_id: null,
          heartbeat_at: null,
          created_at: run.createdAt,
        })
        .execute();
    },
    async get(id: string, enrollmentId: string): Promise<BenchmarkRun | null> {
      const row = await db
        .selectFrom("benchmark_runs")
        .selectAll()
        .where("id", "=", id)
        .where("enrollment_id", "=", enrollmentId)
        .executeTakeFirst();
      return row
        ? { ...JSON.parse(row.document_json), status: row.status, cancelRequested: row.cancel_requested === 1 }
        : null;
    },
    async list(enrollmentId: string): Promise<BenchmarkRun[]> {
      const rows = await db
        .selectFrom("benchmark_runs")
        .selectAll()
        .where("enrollment_id", "=", enrollmentId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(30)
        .execute();
      return rows.map((row) => ({
        ...JSON.parse(row.document_json),
        status: row.status,
        cancelRequested: row.cancel_requested === 1,
      }));
    },
    async getAny(id: string): Promise<BenchmarkRun | null> {
      const row = await db.selectFrom("benchmark_runs").selectAll().where("id", "=", id).executeTakeFirst();
      return row
        ? { ...JSON.parse(row.document_json), status: row.status, cancelRequested: row.cancel_requested === 1 }
        : null;
    },
    async listAll(
      cursor?: { createdAt: string; id: string },
      limit = 30,
      filters: { integration?: string; status?: string; q?: string } = {},
    ) {
      let query = db.selectFrom("benchmark_runs").selectAll();
      if (filters.status) query = query.where("status", "=", filters.status);
      if (filters.q)
        query = query.where(
          sql<boolean>`document_json LIKE ${`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`} ESCAPE ${"\\"}`,
        );
      if (filters.integration) {
        const match = `%"integration":"${filters.integration}"%`;
        query = query.where((eb) =>
          eb.or([
            eb("document_json", "like", match),
            ...(filters.integration === "none" ? [eb("document_json", "like", '%"suiteId":"automation_core"%')] : []),
            ...(filters.integration === "clickup"
              ? [
                  eb.and([
                    eb("document_json", "not like", '%"workspaceVersion"%'),
                    eb("document_json", "not like", '%"suiteId":"automation_core"%'),
                  ]),
                ]
              : []),
          ]),
        );
      }
      if (cursor)
        query = query.where((eb) =>
          eb.or([
            eb("created_at", "<", cursor.createdAt),
            eb.and([eb("created_at", "=", cursor.createdAt), eb("id", "<", cursor.id)]),
          ]),
        );
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .execute();
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        runs: visible.map(
          (row): BenchmarkRun => ({
            ...JSON.parse(row.document_json),
            status: row.status,
            cancelRequested: row.cancel_requested === 1,
          }),
        ),
        nextCursor: rows.length > limit && last ? { createdAt: last.created_at, id: last.id } : null,
      };
    },
    async claim(id: string, enrollmentId: string): Promise<string> {
      return db.transaction().execute(async (trx) => {
        const profile = await trx
          .selectFrom("benchmark_enrollments")
          .select(["user_id", "active_run_id"])
          .where("id", "=", enrollmentId)
          .executeTakeFirstOrThrow();
        if (!profile.user_id) throw new Error("The enrolled user was removed.");
        const owner = await trx
          .updateTable("users")
          .set({ name: sql`name` })
          .where("id", "=", profile.user_id)
          .executeTakeFirst();
        if (!Number(owner.numUpdatedRows)) throw new Error("The enrolled user was removed.");
        const requestedRow = await trx
          .selectFrom("benchmark_runs")
          .select("document_json")
          .where("id", "=", id)
          .where("enrollment_id", "=", enrollmentId)
          .executeTakeFirstOrThrow();
        const requested: BenchmarkRun = JSON.parse(requestedRow.document_json);
        if (requested.workspaceVersion) {
          const unsettled = await trx
            .selectFrom("benchmark_runs as r")
            .innerJoin("benchmark_enrollments as e", "e.id", "r.enrollment_id")
            .select(["r.id", "r.status", "r.document_json"])
            .where("e.user_id", "=", profile.user_id)
            .where("r.id", "!=", id)
            .where((eb) =>
              eb.or([
                eb("r.status", "=", "running"),
                eb("r.status", "=", "interrupted"),
                eb("r.document_json", "like", '%"cleanup":"needs_attention"%'),
              ]),
            )
            .execute();
          for (const other of unsettled) {
            if (other.status === "running")
              throw new Error("The shared identity already has a running batch. Wait for it to finish or stop it.");
            const previous: BenchmarkRun = JSON.parse(other.document_json);
            const debt = previous.cases.filter(
              (item) =>
                item.cleanup !== "complete" &&
                item.resources.some((resource) => resource.state !== "deleted" && resource.state !== "retained"),
            );
            if (
              !previous.workspaceVersion ||
              debt.some(
                (item) =>
                  !item.enrollment ||
                  requested.cases.some(
                    (candidate) =>
                      candidate.enrollment?.integration === item.enrollment?.integration &&
                      candidate.enrollment?.accountId === item.enrollment?.accountId,
                  ),
              )
            )
              throw new Error(
                "A previous batch needs cleanup on this account. Other configured accounts and core cases remain available.",
              );
          }
        } else if (
          await trx
            .selectFrom("benchmark_enrollments")
            .select("id")
            .where("user_id", "=", profile.user_id)
            .where("active_run_id", "is not", null)
            .executeTakeFirst()
        ) {
          throw new Error("This Sketch test identity already has an active batch.");
        }
        const locked = await trx
          .updateTable("benchmark_enrollments")
          .set({ active_run_id: id })
          .where("id", "=", enrollmentId)
          .where("active_run_id", profile.active_run_id ? "=" : "is", profile.active_run_id)
          .executeTakeFirst();
        if (!Number(locked.numUpdatedRows))
          throw new Error("This test account already has an active batch or needs cleanup.");
        const workerId = randomUUID();
        const claimed = await trx
          .updateTable("benchmark_runs")
          .set({ status: "running", worker_id: workerId, heartbeat_at: new Date().toISOString() })
          .where("id", "=", id)
          .where("enrollment_id", "=", enrollmentId)
          .where("status", "=", "draft")
          .executeTakeFirst();
        if (!Number(claimed.numUpdatedRows))
          throw new Error("This batch has already started. Create a repeat to run it again.");
        return workerId;
      });
    },
    async save(run: BenchmarkRun, workerId: string) {
      const result = await db
        .updateTable("benchmark_runs")
        .set({ document_json: JSON.stringify(run), status: run.status, heartbeat_at: new Date().toISOString() })
        .where("id", "=", run.id)
        .where("worker_id", "=", workerId)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows)) throw new Error("Benchmark worker ownership was lost.");
      if (run.workspaceVersion)
        for (const item of run.cases) {
          if (!item.conversationId || !item.enrollment) continue;
          await db
            .insertInto("benchmark_contexts")
            .values({
              conversation_id: item.conversationId,
              run_id: run.id,
              task_id: item.automationId ?? null,
              binding_json: JSON.stringify(item.enrollment),
            })
            .onConflict((oc) => oc.column("conversation_id").doUpdateSet({ task_id: item.automationId ?? null }))
            .execute();
        }
    },
    async heartbeat(id: string, workerId: string) {
      const result = await db
        .updateTable("benchmark_runs")
        .set({ heartbeat_at: new Date().toISOString() })
        .where("id", "=", id)
        .where("worker_id", "=", workerId)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows)) throw new Error("Benchmark worker ownership was lost.");
    },
    async assertWorker(id: string, workerId: string) {
      const row = await db
        .selectFrom("benchmark_runs")
        .select("id")
        .where("id", "=", id)
        .where("worker_id", "=", workerId)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (!row) throw new Error("Benchmark worker ownership was lost.");
    },
    async release(run: BenchmarkRun) {
      if (run.cases.some((item) => item.cleanup !== "complete" && item.resources.length)) return;
      await db
        .updateTable("benchmark_enrollments")
        .set({ active_run_id: null })
        .where("id", "=", run.enrollmentId)
        .where("active_run_id", "=", run.id)
        .execute();
    },
    async cancel(id: string, enrollmentId: string) {
      await db
        .updateTable("benchmark_runs")
        .set({ cancel_requested: 1 })
        .where("id", "=", id)
        .where("enrollment_id", "=", enrollmentId)
        .where("status", "=", "running")
        .execute();
    },
    /** Expired work is never replayed. Its account remains locked until exact-resource cleanup is reconciled. */
    async interruptStale() {
      await db
        .updateTable("benchmark_runs")
        .set({ status: "interrupted", worker_id: null })
        .where("status", "=", "running")
        .where("heartbeat_at", "<", new Date(Date.now() - 120_000).toISOString())
        .execute();
    },
    async resolveAbsentResource(
      id: string,
      enrollmentId: string,
      scenarioId: string,
      resourceKey: string,
      actor: string,
    ) {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("benchmark_runs")
          .selectAll()
          .where("id", "=", id)
          .where("enrollment_id", "=", enrollmentId)
          .executeTakeFirstOrThrow();
        if (!["completed", "interrupted"].includes(row.status))
          throw new Error("Stop the batch before reconciling resources.");
        const run: BenchmarkRun = JSON.parse(row.document_json);
        const item = run.cases.find((entry) => entry.scenario.id === scenarioId);
        const resource = item?.resources.find(
          (entry) => entry.key === resourceKey && entry.state === "intent" && entry.id === null,
        );
        if (!item || !resource || !["list", "attachment", "provider_item"].includes(resource.kind))
          throw new Error("This resource cannot be manually reconciled.");
        resource.state = "deleted";
        item.assertions.push({
          id: `manual_cleanup_${resourceKey}`,
          label: "Cleanup absence confirmed manually",
          status: "unverified",
          evidence: `${actor} confirmed on ${new Date().toISOString()} that ${resource.kind} ${resource.name ?? resource.key} was not created or is already removed. This is operator attestation, not automated proof.`,
        });
        if (item.verdict === "passed") item.verdict = "unverified";
        const changed = await trx
          .updateTable("benchmark_runs")
          .set({ document_json: JSON.stringify(run) })
          .where("id", "=", id)
          .where("status", "=", row.status)
          .where("document_json", "=", row.document_json)
          .executeTakeFirst();
        if (!Number(changed.numUpdatedRows))
          throw new Error("The batch changed while reconciling. Refresh and try again.");
      });
    },
    async claimCleanup(id: string, enrollmentId: string) {
      return db.transaction().execute(async (trx) => {
        const profile = await trx
          .selectFrom("benchmark_enrollments")
          .select("user_id")
          .where("id", "=", enrollmentId)
          .executeTakeFirstOrThrow();
        if (!profile.user_id) throw new Error("The enrolled user was removed.");
        const owner = await trx
          .updateTable("users")
          .set({ name: sql`name` })
          .where("id", "=", profile.user_id)
          .executeTakeFirst();
        if (!Number(owner.numUpdatedRows)) throw new Error("The enrolled user was removed.");
        if (
          await trx
            .selectFrom("benchmark_enrollments")
            .select("id")
            .where("user_id", "=", profile.user_id)
            .where("active_run_id", "is not", null)
            .where("active_run_id", "!=", id)
            .executeTakeFirst()
        )
          throw new Error("Another batch owns this test account.");
        const locked = await trx
          .updateTable("benchmark_enrollments")
          .set({ active_run_id: id })
          .where("id", "=", enrollmentId)
          .where((eb) => eb.or([eb("active_run_id", "is", null), eb("active_run_id", "=", id)]))
          .executeTakeFirst();
        if (!Number(locked.numUpdatedRows)) throw new Error("Another batch owns this test account.");
        const workerId = randomUUID();
        const result = await trx
          .updateTable("benchmark_runs")
          .set({ status: "running", worker_id: workerId, heartbeat_at: new Date().toISOString() })
          .where("id", "=", id)
          .where("enrollment_id", "=", enrollmentId)
          .where("status", "in", ["interrupted", "completed"])
          .executeTakeFirst();
        if (!Number(result.numUpdatedRows)) throw new Error("The batch is still running or has not started.");
        return workerId;
      });
    },
  };
}
