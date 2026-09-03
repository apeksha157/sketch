import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";

export interface LinkedinCompanyContinuationInput {
  reviewId: string;
  companyName: string;
  personEntityId: string;
  companySlug: string | null;
  companyDomain: string | null;
  companyLinkedinUrl: string | null;
  evidenceFileId: string;
}

export async function attachLinkedinCompanyContinuation(
  db: Kysely<DB>,
  input: LinkedinCompanyContinuationInput,
): Promise<void> {
  const companySlug = input.companySlug?.trim().toLowerCase() || null;
  const companyDomain = input.companyDomain?.trim().toLowerCase() || null;
  const continuationKey = [
    input.reviewId,
    input.companyName,
    input.personEntityId,
    companySlug ?? "",
    companyDomain ?? "",
    input.evidenceFileId,
  ].join("|");
  const candidateId = `linkedin:${createHash("sha256").update(continuationKey).digest("hex")}`;
  const now = new Date().toISOString();
  await db
    .insertInto("entity_candidates")
    .values({
      id: candidateId,
      name: input.companyName,
      type: "linkedin_company_continuation",
      variations: JSON.stringify([]),
      first_seen_file_id: input.evidenceFileId,
      seen_file_ids: JSON.stringify([input.evidenceFileId]),
      seen_count: 1,
      promoted_entity_id: null,
      domain: companyDomain,
      proposed_company_name: input.companyName,
      first_observed_by_user_id: null,
      observed_person_entity_ids: JSON.stringify([input.personEntityId]),
      evidence_file_ids: JSON.stringify([input.evidenceFileId]),
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();
  await db
    .insertInto("entity_review_domain_candidates")
    .values({
      review_id: input.reviewId,
      domain_candidate_id: candidateId,
      company_slug: companySlug,
      company_linkedin_url: input.companyLinkedinUrl,
      created_at: now,
    })
    .onConflict((conflict) =>
      conflict.columns(["review_id", "domain_candidate_id"]).doUpdateSet({
        company_slug: companySlug,
        company_linkedin_url: input.companyLinkedinUrl,
      }),
    )
    .execute();
}

export type LinkedinSlugAttachResult = "inserted" | "unchanged" | "conflict" | "missing";

export async function attachLinkedinCompanySlug(
  db: Kysely<DB>,
  input: { companyEntityId: string; slug: string | null; linkedinUrl: string | null },
): Promise<LinkedinSlugAttachResult> {
  const slug = input.slug?.trim().toLowerCase();
  if (!slug) return "missing";
  const sourceId = `company:${slug}`;
  const inserted = await db
    .insertInto("entity_source_refs")
    .values({
      id: randomUUID(),
      entity_id: input.companyEntityId,
      source: "linkedin",
      source_id: sourceId,
      source_url: input.linkedinUrl,
      last_seen_at: new Date().toISOString(),
    })
    .onConflict((conflict) => conflict.columns(["source", "source_id"]).doNothing())
    .returning("entity_id")
    .executeTakeFirst();
  if (inserted) return "inserted";
  const existing = await db
    .selectFrom("entity_source_refs")
    .select("entity_id")
    .where("source", "=", "linkedin")
    .where("source_id", "=", sourceId)
    .executeTakeFirstOrThrow();
  return existing.entity_id === input.companyEntityId ? "unchanged" : "conflict";
}

export async function finalizeLinkedinCompanyContinuations(
  db: Kysely<DB>,
  reviewId: string,
  companyEntityId: string,
  logger?: Logger,
): Promise<void> {
  const rows = await db
    .selectFrom("entity_review_domain_candidates")
    .innerJoin("entity_candidates", "entity_candidates.id", "entity_review_domain_candidates.domain_candidate_id")
    .select([
      "entity_candidates.id as candidate_id",
      "entity_candidates.promoted_entity_id",
      "entity_candidates.domain as company_domain",
      "entity_candidates.observed_person_entity_ids",
      "entity_candidates.evidence_file_ids",
      "entity_review_domain_candidates.company_slug",
      "entity_review_domain_candidates.company_linkedin_url",
    ])
    .where("entity_review_domain_candidates.review_id", "=", reviewId)
    .where("entity_candidates.type", "=", "linkedin_company_continuation")
    .orderBy("entity_candidates.id", "asc")
    .execute();
  if (rows.length === 0) return;
  const domainsRepo = createEntityDomainsRepository(db);
  const entityRepo = createEntityRepository(db);

  for (const row of rows) {
    if (row.promoted_entity_id && row.promoted_entity_id !== companyEntityId) {
      logger?.warn(
        { reviewId, companyEntityId, promotedEntityId: row.promoted_entity_id },
        "Skipped already-finalized LinkedIn company continuation",
      );
      continue;
    }
    if (row.company_domain) {
      const domainResult = await domainsRepo.upsertAuthoritativeCorporateDomain({
        entityId: companyEntityId,
        domain: row.company_domain,
        source: "linkedin",
        confidence: 1,
        isPrimary: true,
      });
      if (domainResult === "skipped_manual_conflict" || domainResult === "skipped_auto_conflict") {
        logger?.warn(
          { reviewId, companyEntityId, domain: row.company_domain, result: domainResult },
          "Skipped conflicting LinkedIn company domain claim",
        );
      }
    }

    const slugResult = await attachLinkedinCompanySlug(db, {
      companyEntityId,
      slug: row.company_slug,
      linkedinUrl: row.company_linkedin_url,
    });
    if (slugResult === "conflict") {
      logger?.warn(
        { reviewId, companyEntityId, slug: row.company_slug },
        "Skipped conflicting LinkedIn company slug claim",
      );
    }

    const personEntityIds = parseStringArray(row.observed_person_entity_ids);
    const evidenceFileIds = parseStringArray(row.evidence_file_ids);
    for (const personEntityId of personEntityIds) {
      const relationshipId = await domainsRepo.upsertWorksAt({
        personEntityId,
        companyEntityId,
        confidence: "EXTRACTED",
        confidenceScore: 1,
        source: "linkedin",
      });
      for (const indexedFileId of evidenceFileIds) {
        await domainsRepo.addEvidence({
          relationshipId,
          indexedFileId,
          note: row.company_slug
            ? `linkedin_company:${row.company_slug}`
            : `linkedin_company_domain:${row.company_domain}`,
        });
      }
    }
    for (const indexedFileId of evidenceFileIds) {
      await entityRepo.createMention({
        entityId: companyEntityId,
        indexedFileId,
        confidence: "EXTRACTED",
        source: "linkedin",
        relation: "mentioned",
      });
    }
    await db
      .updateTable("entity_candidates")
      .set({ promoted_entity_id: companyEntityId, updated_at: new Date().toISOString() })
      .where("id", "=", row.candidate_id)
      .where("promoted_entity_id", "is", null)
      .execute();
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
