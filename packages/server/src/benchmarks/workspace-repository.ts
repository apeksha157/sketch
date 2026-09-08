import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import { type CaseDefinition, type CaseInput, type DesignConversation, caseInputSchema, curatedCases } from "./cases";
import { BenchmarkBlockedError } from "./clickup";

export function createBenchmarkWorkspaceRepository(db: Kysely<DB>) {
  return {
    async cases() {
      const rows = await db
        .selectFrom("benchmark_cases")
        .selectAll()
        .orderBy("updated_at", "desc")
        .limit(1000)
        .execute();
      const definitions = rows.map((row) => JSON.parse(row.document_json) as CaseDefinition);
      return [...definitions, ...curatedCases.filter((entry) => !definitions.some((saved) => saved.id === entry.id))];
    },
    async case(id: string): Promise<CaseDefinition | null> {
      const row = await db.selectFrom("benchmark_cases").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? JSON.parse(row.document_json) : (curatedCases.find((entry) => entry.id === id) ?? null);
    },
    async saveCase(input: CaseInput, options: { id?: string; expectedRevision?: number; designId?: string } = {}) {
      const parsed = caseInputSchema.parse(input);
      const definition: CaseDefinition = {
        ...parsed,
        id: options.id ?? randomUUID(),
        revision: (options.expectedRevision ?? 0) + 1,
        source: options.designId ? "generated" : "manual",
        updatedAt: new Date().toISOString(),
        ...(options.designId ? { designId: options.designId } : {}),
      };
      if (options.id) {
        const result = await db
          .updateTable("benchmark_cases")
          .set({
            revision: definition.revision,
            document_json: JSON.stringify(definition),
            updated_at: definition.updatedAt,
          })
          .where("id", "=", options.id)
          .where("revision", "=", options.expectedRevision ?? 0)
          .executeTakeFirst();
        if (!Number(result.numUpdatedRows))
          throw new BenchmarkBlockedError("This case changed or is a curated case. Refresh or save a new copy.");
      } else {
        await db
          .insertInto("benchmark_cases")
          .values({
            id: definition.id,
            revision: definition.revision,
            document_json: JSON.stringify(definition),
            updated_at: definition.updatedAt,
          })
          .execute();
      }
      return definition;
    },
    async designs() {
      const rows = await db
        .selectFrom("benchmark_designs")
        .select(["id", "document_json", "revision", "lease_id", "lease_expires_at"])
        .orderBy("updated_at", "desc")
        .limit(30)
        .execute();
      return rows.map((row) => {
        const doc: DesignConversation = JSON.parse(row.document_json);
        return {
          id: row.id,
          revision: row.revision,
          integration: doc.integration,
          createdAt: doc.createdAt,
          title: doc.messages.find((entry) => entry.role === "user")?.text.slice(0, 100) ?? "New case conversation",
          busy: Boolean(row.lease_id && row.lease_expires_at && row.lease_expires_at > new Date().toISOString()),
        };
      });
    },
    async saveProposal(id: string, revision: number, indexes: number[]) {
      return db.transaction().execute(async (trx) => {
        const locked = await trx
          .updateTable("benchmark_designs")
          .set({ revision })
          .where("id", "=", id)
          .where("revision", "=", revision)
          .where("lease_id", "is", null)
          .executeTakeFirst();
        if (!Number(locked.numUpdatedRows))
          throw new BenchmarkBlockedError(
            "The proposal changed or the agent is responding. Refresh before saving cases.",
          );
        const row = await trx
          .selectFrom("benchmark_designs")
          .select("document_json")
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        const design: DesignConversation = JSON.parse(row.document_json);
        if (indexes.some((index) => !design.cases[index]) || new Set(indexes).size !== indexes.length)
          throw new BenchmarkBlockedError("Select distinct available proposals.");
        const saved: CaseDefinition[] = [];
        for (const index of indexes) {
          const definition: CaseDefinition = {
            ...caseInputSchema.parse(design.cases[index]),
            id: `generated-${id}-${revision}-${index}`,
            revision: 1,
            source: "generated",
            updatedAt: new Date().toISOString(),
            designId: id,
          };
          await trx
            .insertInto("benchmark_cases")
            .values({
              id: definition.id,
              revision: 1,
              document_json: JSON.stringify(definition),
              updated_at: definition.updatedAt,
            })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
          const existing = await trx
            .selectFrom("benchmark_cases")
            .select("document_json")
            .where("id", "=", definition.id)
            .executeTakeFirstOrThrow();
          saved.push(JSON.parse(existing.document_json));
        }
        return saved;
      });
    },
    async design(id: string): Promise<DesignConversation | null> {
      const row = await db
        .selectFrom("benchmark_designs")
        .select("document_json")
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? JSON.parse(row.document_json) : null;
    },
    async createDesign(design: DesignConversation) {
      await db
        .insertInto("benchmark_designs")
        .values({
          id: design.id,
          revision: design.revision,
          document_json: JSON.stringify(design),
          lease_id: null,
          lease_expires_at: null,
          updated_at: design.createdAt,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      const row = await db
        .selectFrom("benchmark_designs")
        .select("document_json")
        .where("id", "=", design.id)
        .executeTakeFirst();
      return row ? (JSON.parse(row.document_json) as DesignConversation) : design;
    },
    async claimDesign(id: string, revision: number) {
      const lease = randomUUID();
      const now = new Date().toISOString();
      const result = await db
        .updateTable("benchmark_designs")
        .set({ lease_id: lease, lease_expires_at: new Date(Date.now() + 120_000).toISOString() })
        .where("id", "=", id)
        .where("revision", "=", revision)
        .where((eb) => eb.or([eb("lease_id", "is", null), eb("lease_expires_at", "<", now)]))
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows))
        throw new BenchmarkBlockedError(
          "This conversation changed or the agent is still responding. Refresh before sending another message.",
        );
      return lease;
    },
    async saveDesign(design: DesignConversation, lease: string) {
      const updated = { ...design, revision: design.revision + 1 };
      const result = await db
        .updateTable("benchmark_designs")
        .set({
          document_json: JSON.stringify(updated),
          revision: updated.revision,
          lease_id: null,
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", design.id)
        .where("revision", "=", design.revision)
        .where("lease_id", "=", lease)
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows))
        throw new BenchmarkBlockedError("The conversation lease expired. Refresh to see the latest response.");
      return updated;
    },
    async releaseDesign(id: string, lease: string) {
      await db
        .updateTable("benchmark_designs")
        .set({ lease_id: null, lease_expires_at: null })
        .where("id", "=", id)
        .where("lease_id", "=", lease)
        .execute();
    },
  };
}
