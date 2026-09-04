import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { EnrichmentResult, PersonEnrichmentProvider } from "../connectors/enrichment/provider";
import type { DB } from "../db/schema";

export class StubProvider implements PersonEnrichmentProvider {
  readonly name = "salesql";

  readonly calls: string[] = [];

  constructor(
    readonly version: string,
    private readonly results: EnrichmentResult[],
  ) {}

  async enrichByLinkedinUrl(url: string): Promise<EnrichmentResult> {
    this.calls.push(url);
    return this.results.shift() ?? { kind: "not_found" };
  }
}

export async function seedEntity(
  db: Kysely<DB>,
  input: { id: string; name: string; sourceType: string; metadata?: unknown },
) {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.sourceType,
      subtype: input.sourceType === "person" ? "external" : null,
      aliases: null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: "inferred",
      hotness: 0,
      created_at: now,
      updated_at: now,
      project_lifecycle_status: null,
      ai_brief: null,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
}

export async function seedCandidate(
  db: Kysely<DB>,
  input: { id: string; publicIdentifier: string; companyId?: string },
) {
  await seedEntity(db, {
    id: input.id,
    name: input.id,
    sourceType: "person",
    metadata: { enrichmentCandidate: true },
  });
  await db
    .insertInto("entity_source_refs")
    .values({
      id: randomUUID(),
      entity_id: input.id,
      source: "linkedin",
      source_id: input.publicIdentifier,
      source_url: `https://www.linkedin.com/in/${input.publicIdentifier}`,
      last_seen_at: new Date().toISOString(),
    })
    .execute();
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: input.id,
      kind: "linkedin",
      value: input.publicIdentifier,
      display_value: `https://www.linkedin.com/in/${input.publicIdentifier}`,
      label: null,
      is_primary: 1,
      source: "linkedin",
      connector_config_id: null,
      created_by_user_id: null,
      verified_at: null,
      last_contacted_at: null,
    })
    .execute();
  if (input.companyId) {
    await db
      .insertInto("entity_relationships")
      .values({
        id: randomUUID(),
        source_entity_id: input.id,
        target_entity_id: input.companyId,
        relationship_type: "works_at",
        confidence: "EXTRACTED",
        confidence_score: 0.9,
        source: "linkedin_aimfox",
      })
      .execute();
  }
}

export async function seedEmailContactPoint(
  db: Kysely<DB>,
  input: { entityId: string; email: string; source?: string; verifiedAt?: string | null },
) {
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: input.entityId,
      kind: "email",
      value: input.email.toLowerCase(),
      display_value: input.email,
      label: null,
      is_primary: 1,
      source: input.source ?? "gmail",
      connector_config_id: null,
      created_by_user_id: null,
      verified_at: input.verifiedAt ?? null,
      last_contacted_at: null,
    })
    .execute();
}

export async function contactPoints(db: Kysely<DB>, entityId: string) {
  return db
    .selectFrom("entity_contact_points")
    .selectAll()
    .where("entity_id", "=", entityId)
    .orderBy("kind", "asc")
    .orderBy("value", "asc")
    .execute();
}
