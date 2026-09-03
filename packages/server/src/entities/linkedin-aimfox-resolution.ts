import type { Selectable } from "kysely";
import { isBogusCompanyName, normalizeCompanyName } from "../connectors/linkedin-aimfox-mappers";
import { domainMatchesName } from "../db/repositories/entity-domains";
import type { EntitiesTable } from "../db/schema";
import { attachLinkedinCompanyContinuation, attachLinkedinCompanySlug } from "./linkedin-company-continuation";
import { registerEntity } from "./materialize-deps";
import type { IndexEntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { normalizeName } from "./name-keys";
import { proposeEntity } from "./propose";

type EntityRow = Selectable<EntitiesTable>;

interface LinkedinPersonSeedData {
  leadId: string;
  name: string;
  email: string | null;
  emails: string[];
  publicIdentifier: string | null;
  profileUrl: string | null;
  metadata: Record<string, unknown>;
  company: {
    name: string | null;
    slug: string | null;
    linkedinUrl: string | null;
    websiteDomains: string[];
    engaged: boolean;
  };
}

type ResolutionPath = "aimfox_ref" | "t0_linkedin" | "t1_email" | "t2_name_company" | "created";

export async function materializeLinkedinAimfoxPersonSeed(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  raw: Record<string, unknown>,
): Promise<MaterializeResult> {
  const seed = readLinkedinPersonSeed(fact, raw);
  if (!seed || !fact.indexed_file_id) return { kind: "skipped", reason: "missing_person_seed_subject" };
  const triggeredByUserId = deps.resolveOwner(fact);
  if (!triggeredByUserId) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };

  const aimfoxRef = await deps.entityRepo.getEntityBySourceRef("aimfox", seed.leadId);
  if (aimfoxRef) {
    return finalizePerson(deps, fact, seed, aimfoxRef, "aimfox_ref", triggeredByUserId);
  }

  if (seed.publicIdentifier) {
    const byLinkedinRef = await deps.entityRepo.getEntityBySourceRef("linkedin", seed.publicIdentifier);
    if (byLinkedinRef) {
      return finalizePerson(deps, fact, seed, byLinkedinRef, "t0_linkedin", triggeredByUserId);
    }
    const byLinkedinContact = await deps.entityRepo.getEntitiesByContactPoint("linkedin", seed.publicIdentifier);
    if (byLinkedinContact.length === 1) {
      return finalizePerson(deps, fact, seed, byLinkedinContact[0], "t0_linkedin", triggeredByUserId);
    }
    if (byLinkedinContact.length > 1) {
      return queuePersonAmbiguity(deps, fact, seed, byLinkedinContact, "exact-ambiguous", triggeredByUserId);
    }
  }

  const emailMatches = new Map<string, EntityRow>();
  for (const email of seed.emails) {
    for (const entity of await deps.entityRepo.getPersonEntitiesByEmail(email)) emailMatches.set(entity.id, entity);
  }
  if (emailMatches.size === 1) {
    return finalizePerson(deps, fact, seed, [...emailMatches.values()][0], "t1_email", triggeredByUserId);
  }
  if (emailMatches.size > 1) {
    return queuePersonAmbiguity(deps, fact, seed, [...emailMatches.values()], "exact-ambiguous", triggeredByUserId);
  }

  const tierTwoMatches = await findTierTwoMatches(deps, seed);
  if (tierTwoMatches.length === 1) {
    return finalizePerson(deps, fact, seed, tierTwoMatches[0], "t2_name_company", triggeredByUserId);
  }
  if (tierTwoMatches.length > 1) {
    return queuePersonAmbiguity(deps, fact, seed, tierTwoMatches, "llm-ambiguous", triggeredByUserId);
  }

  const created = await deps.entityRepo.createPersonEntity({
    name: seed.name,
    email: seed.email ?? undefined,
    subtype: "external",
    source: "aimfox",
    sourceId: seed.leadId,
    provenanceTier: "structural",
  });
  return finalizePerson(deps, fact, seed, created, "created", triggeredByUserId);
}

async function finalizePerson(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  seed: LinkedinPersonSeedData,
  entity: EntityRow,
  path: ResolutionPath,
  triggeredByUserId: string,
): Promise<MaterializeResult> {
  await deps.entityRepo.upsertSourceRef({
    entityId: entity.id,
    source: "aimfox",
    sourceId: seed.leadId,
    sourceUrl: seed.profileUrl ?? undefined,
  });
  if (seed.publicIdentifier) {
    await deps.entityRepo.upsertSourceRef({
      entityId: entity.id,
      source: "linkedin",
      sourceId: seed.publicIdentifier,
      sourceUrl: seed.profileUrl ?? undefined,
    });
  }
  if (seed.email) await deps.entityRepo.attachEmailIfAbsent(entity.id, seed.email);
  const enrichmentCandidate =
    seed.emails.length === 0 &&
    (path === "created" || path === "t2_name_company") &&
    !(await entityHasEmail(deps, entity.id));
  await mergeLinkedinMetadata(deps, entity.id, seed, enrichmentCandidate);
  const refreshed = await deps.entityRepo.getEntity(entity.id);
  if (!refreshed) return { kind: "skipped", reason: "missing_person_seed_subject" };
  registerEntity(deps.index, refreshed);
  deps.index.bySourceRef.set(`aimfox:${seed.leadId}`, refreshed);
  if (seed.publicIdentifier) deps.index.bySourceRef.set(`linkedin:${seed.publicIdentifier}`, refreshed);
  await deps.onEntityResolved(refreshed);
  await materializeCompanySignal(deps, fact, seed, refreshed, triggeredByUserId);
  return { kind: "structural", entity: refreshed };
}

async function queuePersonAmbiguity(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  seed: LinkedinPersonSeedData,
  candidates: EntityRow[],
  reason: "exact-ambiguous" | "llm-ambiguous",
  triggeredByUserId: string,
): Promise<MaterializeResult> {
  const ordered = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const result = await deps.reviewRepo.upsertQueueRow({
    proposedName: seed.name,
    normalizedName: normalizeName(seed.name),
    entityType: "person",
    source: "aimfox",
    sourceId: seed.leadId,
    sourceScoped: true,
    seedSource: seed.publicIdentifier ? "linkedin" : null,
    seedSourceId: seed.publicIdentifier,
    proposedEmail: seed.email,
    candidateEntityId: ordered.length === 1 ? ordered[0].id : null,
    candidateEntityIds: ordered.length > 1 ? ordered.map((candidate) => candidate.id) : null,
    candidateScore: ordered.length === 1 ? 1 : null,
    candidateReason: reason,
    triggeredByUserId,
    evidenceIndexedFileIds: fact.indexed_file_id ? [fact.indexed_file_id] : [],
  });
  if (!result.skipEvidence && fact.indexed_file_id) {
    await deps.reviewRepo.upsertEvidence({
      reviewId: result.row.id,
      indexedFileId: fact.indexed_file_id,
      source: "linkedin_aimfox",
      note: `aimfox_lead:${seed.leadId}`,
    });
  }
  return { kind: "queued", reviewId: result.row.id };
}

async function findTierTwoMatches(deps: MaterializeDeps, seed: LinkedinPersonSeedData): Promise<EntityRow[]> {
  if (!seed.company.name || isBogusCompanyName(seed.company.name)) return [];
  const domains = new Set<string>();
  for (const domain of seed.company.websiteDomains) {
    if (domainMatchesName(domain, seed.company.name) && !(await deps.domainsRepo.isPersonalOrShared(domain))) {
      domains.add(domain);
    }
  }
  if (seed.company.slug) {
    const company = await deps.entityRepo.getEntityBySourceRef("linkedin", `company:${seed.company.slug}`);
    if (company) {
      const rows = await deps.db
        .selectFrom("entity_domains")
        .select("domain")
        .where("entity_id", "=", company.id)
        .where("kind", "=", "corporate")
        .execute();
      for (const row of rows) domains.add(row.domain);
    }
  }
  const matchingCompanyIds = (await findCompaniesByNormalizedName(deps, seed.company.name)).map(
    (company) => company.id,
  );
  if (matchingCompanyIds.length > 0) {
    const rows = await deps.db
      .selectFrom("entity_domains")
      .select("domain")
      .where("entity_id", "in", matchingCompanyIds)
      .where("kind", "=", "corporate")
      .execute();
    for (const row of rows) domains.add(row.domain);
  }
  const guessedDomain = guessCompanyDomain(seed.company.name);
  if (guessedDomain && !(await deps.domainsRepo.isPersonalOrShared(guessedDomain))) domains.add(guessedDomain);
  if (domains.size === 0) return [];

  const candidates = new Map<string, EntityRow>();
  for (const domain of domains) {
    const rows = await deps.db
      .selectFrom("entities")
      .leftJoin("entity_relationships", (join) =>
        join
          .onRef("entity_relationships.source_entity_id", "=", "entities.id")
          .on("entity_relationships.relationship_type", "=", "works_at")
          .on("entity_relationships.valid_to", "is", null),
      )
      .leftJoin("entity_domains", (join) =>
        join
          .onRef("entity_domains.entity_id", "=", "entity_relationships.target_entity_id")
          .on("entity_domains.kind", "=", "corporate"),
      )
      .leftJoin("entity_contact_points", (join) =>
        join
          .onRef("entity_contact_points.entity_id", "=", "entities.id")
          .on("entity_contact_points.kind", "=", "email"),
      )
      .selectAll("entities")
      .where("entities.source_type", "=", "person")
      .where("entities.deleted_at", "is", null)
      .where((expression) =>
        expression.or([
          expression("entity_domains.domain", "=", domain),
          expression("entity_contact_points.value", "like", `%@${domain}`),
        ]),
      )
      .execute();
    for (const row of rows) candidates.set(row.id, row);
  }
  return [...candidates.values()]
    .filter((candidate) => namesLikelySame(seed.name, candidate.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function materializeCompanySignal(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  seed: LinkedinPersonSeedData,
  person: IndexEntityRow,
  triggeredByUserId: string,
): Promise<void> {
  const companyName = seed.company.name;
  if (!companyName || isBogusCompanyName(companyName) || !fact.indexed_file_id) return;
  const domains: string[] = [];
  for (const domain of seed.company.websiteDomains) {
    if (domainMatchesName(domain, companyName) && !(await deps.domainsRepo.isPersonalOrShared(domain))) {
      domains.push(domain);
    }
  }
  const uniqueDomains = [...new Set(domains)].sort();
  const matchingCompanies = await findCompaniesByNormalizedName(deps, companyName);
  let company: IndexEntityRow | null = matchingCompanies.length === 1 ? matchingCompanies[0] : null;
  const matchedCompanyHasDomain = company
    ? Boolean(
        await deps.db
          .selectFrom("entity_domains")
          .select("id")
          .where("entity_id", "=", company.id)
          .where("kind", "=", "corporate")
          .executeTakeFirst(),
      )
    : false;
  if (uniqueDomains.length === 0 && !matchedCompanyHasDomain && (!seed.company.engaged || !seed.company.slug)) return;

  for (const domain of uniqueDomains) {
    const byDomain = await deps.domainsRepo.lookupCompanyByDomain(domain);
    if (byDomain) {
      company = byDomain as unknown as IndexEntityRow;
      break;
    }
  }
  if (!company && seed.company.slug) {
    company = await deps.entityRepo.getEntityBySourceRef("linkedin", `company:${seed.company.slug}`);
  }

  if (!company) {
    const primaryDomain = uniqueDomains[0] ?? null;
    const sourceId = primaryDomain ? `company-domain:${primaryDomain}` : `company:${seed.company.slug?.toLowerCase()}`;
    const proposal = await proposeEntity(
      {
        db: deps.db,
        entityRepo: deps.entityRepo,
        reviewRepo: deps.reviewRepo,
        resolutionLedger: deps.resolutionLedger,
        domainsRepo: deps.domainsRepo,
        lookup: deps.lookup,
        readEmail: deps.readEmail,
        onEntityResolved: deps.onEntityResolved,
        logger: deps.logger,
      },
      {
        name: companyName,
        entityType: "company",
        subtype: "external",
        source: "linkedin_company_signal",
        sourceId,
        evidence: [
          { indexedFileId: fact.indexed_file_id, note: `linkedin_company:${seed.company.slug ?? primaryDomain}` },
        ],
        contextFileId: fact.indexed_file_id,
        triggeredByUserId,
        metadata: {
          linkedinUrl: seed.company.linkedinUrl,
          linkedinUniversalName: seed.company.slug,
          origin: "linkedin_aimfox",
        },
        provenanceTier: "structural",
        evidenceDomain: primaryDomain,
      },
    );
    if (proposal.kind === "queued") {
      await attachLinkedinCompanyContinuation(deps.db, {
        reviewId: proposal.reviewId,
        companyName,
        personEntityId: person.id,
        companySlug: seed.company.slug,
        companyDomain: primaryDomain,
        companyLinkedinUrl: seed.company.linkedinUrl,
        evidenceFileId: fact.indexed_file_id,
      });
      return;
    }
    if (proposal.kind === "suppressed") return;
    company = proposal.entity;
  }

  registerEntity(deps.index, company);
  for (const domain of uniqueDomains) {
    const result = await deps.domainsRepo.upsertAuthoritativeCorporateDomain({
      entityId: company.id,
      domain,
      source: "linkedin",
      confidence: 1,
      isPrimary: true,
    });
    if (result === "skipped_manual_conflict" || result === "skipped_auto_conflict") {
      deps.logger?.warn(
        { companyEntityId: company.id, domain, result },
        "Skipped conflicting LinkedIn company domain claim",
      );
    }
  }

  const slugResult = await attachLinkedinCompanySlug(deps.db, {
    companyEntityId: company.id,
    slug: seed.company.slug,
    linkedinUrl: seed.company.linkedinUrl,
  });
  if (slugResult === "conflict") {
    const existing = seed.company.slug
      ? await deps.entityRepo.getEntityBySourceRef("linkedin", `company:${seed.company.slug}`)
      : null;
    const review = await deps.reviewRepo.upsertQueueRow({
      proposedName: companyName,
      normalizedName: normalizeName(companyName),
      entityType: "company",
      source: "linkedin_company_claim",
      sourceId: `${seed.company.slug}:${person.id}`,
      sourceScoped: true,
      candidateEntityId: existing?.id ?? null,
      candidateScore: existing ? 1 : null,
      candidateReason: "exact-ambiguous",
      triggeredByUserId,
      evidenceIndexedFileIds: [fact.indexed_file_id],
    });
    if (!review.skipEvidence) {
      await deps.reviewRepo.upsertEvidence({
        reviewId: review.row.id,
        indexedFileId: fact.indexed_file_id,
        source: "linkedin_aimfox",
        note: `linkedin_company_slug_conflict:${seed.company.slug}`,
      });
    }
    await attachLinkedinCompanyContinuation(deps.db, {
      reviewId: review.row.id,
      companyName,
      personEntityId: person.id,
      companySlug: seed.company.slug,
      companyDomain: uniqueDomains[0] ?? null,
      companyLinkedinUrl: seed.company.linkedinUrl,
      evidenceFileId: fact.indexed_file_id,
    });
    return;
  }

  const relationshipId = await deps.domainsRepo.upsertWorksAt({
    personEntityId: person.id,
    companyEntityId: company.id,
    confidence: "EXTRACTED",
    confidenceScore: 1,
    source: "linkedin",
  });
  await deps.domainsRepo.addEvidence({
    relationshipId,
    indexedFileId: fact.indexed_file_id,
    note: seed.company.slug ? `linkedin_company:${seed.company.slug}` : `linkedin_company_domain:${uniqueDomains[0]}`,
  });
  await deps.entityRepo.createMention({
    entityId: company.id,
    indexedFileId: fact.indexed_file_id,
    confidence: "EXTRACTED",
    source: "linkedin",
    relation: "mentioned",
  });
}

async function findCompaniesByNormalizedName(deps: MaterializeDeps, name: string): Promise<IndexEntityRow[]> {
  const normalized = normalizeCompanyName(name);
  const rows = await deps.db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "provenance_tier", "aliases", "metadata", "status", "hotness", "created_at"])
    .where("source_type", "=", "company")
    .where("deleted_at", "is", null)
    .execute();
  return rows.filter((company) => normalizeCompanyName(company.name) === normalized);
}

async function mergeLinkedinMetadata(
  deps: MaterializeDeps,
  entityId: string,
  seed: LinkedinPersonSeedData,
  enrichmentCandidate: boolean,
): Promise<void> {
  const entity = await deps.entityRepo.getEntity(entityId);
  if (!entity) return;
  const metadata = parseObject(entity.metadata);
  const linkedinAimfox = parseObject(metadata.linkedinAimfox);
  const leads = parseObject(linkedinAimfox.leads);
  leads[seed.leadId] = {
    ...seed.metadata,
    linkedinProfileUrl: seed.profileUrl,
    linkedinPublicIdentifier: seed.publicIdentifier,
    currentCompanyName: seed.company.name,
    currentCompanyUniversalName: seed.company.slug,
    currentCompanyLinkedinUrl: seed.company.linkedinUrl,
    companyWebsiteDomains: seed.company.websiteDomains,
    enrichmentCandidate,
  };
  metadata.linkedinAimfox = { ...linkedinAimfox, leads };
  metadata.enrichmentCandidate = Object.values(leads).some((lead) => parseObject(lead).enrichmentCandidate === true);
  await deps.entityRepo.updateEntity(entityId, { metadata: JSON.stringify(metadata) });
}

async function entityHasEmail(deps: MaterializeDeps, entityId: string): Promise<boolean> {
  const row = await deps.db
    .selectFrom("entity_contact_points")
    .select("id")
    .where("entity_id", "=", entityId)
    .where("kind", "=", "email")
    .executeTakeFirst();
  return Boolean(row);
}

function readLinkedinPersonSeed(fact: IndexedFileFactRow, raw: Record<string, unknown>): LinkedinPersonSeedData | null {
  if (!fact.subject_name || !fact.subject_source_id) return null;
  const company = parseObject(raw.company);
  const metadata = parseObject(raw.metadata);
  const emails = stringArray(raw.emails);
  if (fact.subject_email && !emails.includes(fact.subject_email)) emails.unshift(fact.subject_email);
  return {
    leadId: fact.subject_source_id,
    name: fact.subject_name,
    email: emails[0] ?? null,
    emails,
    publicIdentifier: readString(raw, "linkedinPublicIdentifier"),
    profileUrl: readString(raw, "linkedinUrl") ?? readString(raw, "sourceUrl"),
    metadata,
    company: {
      name: readString(company, "name"),
      slug: readString(company, "slug")?.toLowerCase() ?? null,
      linkedinUrl: readString(company, "linkedinUrl"),
      websiteDomains: stringArray(company.websiteDomains).map((domain) => domain.toLowerCase()),
      engaged: company.engaged === true,
    },
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
    : [];
}

const NICKNAMES = new Map([
  ["bob", "robert"],
  ["rob", "robert"],
  ["robbie", "robert"],
  ["chris", "christopher"],
  ["kate", "katherine"],
  ["katie", "katherine"],
  ["mike", "michael"],
  ["liz", "elizabeth"],
  ["beth", "elizabeth"],
]);

function namesLikelySame(incoming: string, existing: string): boolean {
  const incomingTokens = normalizeName(incoming).split(" ").filter(Boolean);
  const existingTokens = normalizeName(existing).split(" ").filter(Boolean);
  if (incomingTokens.join(" ") === existingTokens.join(" ")) return true;
  if (incomingTokens.length < 2 || existingTokens.length < 2) return false;
  if (incomingTokens.at(-1) !== existingTokens.at(-1)) return false;
  return (
    (NICKNAMES.get(incomingTokens[0]) ?? incomingTokens[0]) === (NICKNAMES.get(existingTokens[0]) ?? existingTokens[0])
  );
}

function guessCompanyDomain(name: string): string | null {
  const compact = normalizeCompanyName(name).replace(/[^a-z0-9]+/g, "");
  return compact ? `${compact}.com` : null;
}
