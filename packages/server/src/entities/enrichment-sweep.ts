import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { EnrichedEmail, EnrichedPhone, PersonEnrichmentProvider } from "../connectors/enrichment/provider";
import { createEnrichmentAttemptsRepository } from "../db/repositories/enrichment-attempts";
import { createEntityRepository, normalizeContactPointValue } from "../db/repositories/entities";
import { type EntityDomainsRepository, createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB } from "../db/schema";
import { normalizePhoneCountryCode, normalizePhoneLike } from "../identity-normalization";
import { yieldToEventLoop } from "../lib/event-loop";
import { handleProposeGraphVerdicts } from "../mcp/curation/propose-graph-verdicts";
import { inferAffiliationFromEmail, isProviderManagedEmailDomain, isRoleAccountEmail } from "./affiliations";
import { mergeEntities } from "./merge";
import { resolveLiveEntity, resolveLiveEntityId } from "./redirect";

export interface EnrichmentSweepDeps {
  db: Kysely<DB>;
  provider: PersonEnrichmentProvider;
  logger: Logger;
  domainsRepo?: EntityDomainsRepository;
  entitiesRepo?: ReturnType<typeof createEntityRepository>;
}

export interface EnrichmentSweepOptions {
  apply?: boolean;
  limit?: number;
  dailyCap: number;
  batch: number;
  autoMerge?: boolean;
}

export interface EnrichmentSweepReport {
  seeded: number;
  selected: number;
  enriched: number;
  notFound: number;
  failed: number;
  skipped: number;
  merged: number;
  proposed: number;
  wouldMerge: number;
  wouldPropose: number;
  domainsAttached: number;
  creditsRemaining: number | null;
  stoppedOn?: "rate_limited" | "auth";
}

export type EnrichmentManualRunOutcome =
  | { started: false; reason: "in_flight" }
  | { started: true; completion: Promise<EnrichmentSweepReport> };

export interface EnrichmentSweepService {
  runOnce(opts?: { apply?: boolean; limit?: number }): Promise<EnrichmentSweepReport>;
  tryRunManual(opts?: { apply?: boolean; limit?: number }): EnrichmentManualRunOutcome;
}

export interface EnrichmentSweepServiceDeps extends EnrichmentSweepDeps {
  readScope: () => Promise<{ enabled: boolean; dailyCap: number; batch: number; autoMerge: boolean } | null>;
}

export function emptyEnrichmentSweepReport(): EnrichmentSweepReport {
  return {
    seeded: 0,
    selected: 0,
    enriched: 0,
    notFound: 0,
    failed: 0,
    skipped: 0,
    merged: 0,
    proposed: 0,
    wouldMerge: 0,
    wouldPropose: 0,
    domainsAttached: 0,
    creditsRemaining: null,
  };
}

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function primaryEmail(emails: EnrichedEmail[]): EnrichedEmail | null {
  return (
    emails.find((email) => email.type === "work" && email.verified) ?? emails.find((email) => email.verified) ?? null
  );
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

type DedupCandidate = {
  entityId: string;
  emails: EnrichedEmail[];
};

type DedupResult = {
  outcome: "attached" | "merged" | "proposed";
  merged: number;
  proposed: number;
  wouldMerge: number;
  wouldPropose: number;
};

async function emailPassesAutoMergeGuard(params: {
  email: EnrichedEmail;
  domainsRepo: EntityDomainsRepository;
}): Promise<boolean> {
  if (!params.email.verified) return false;
  const domain = domainOf(params.email.email);
  if (!domain) return false;
  if (isRoleAccountEmail(params.email.email)) return false;
  if (isProviderManagedEmailDomain(domain)) return false;
  return !(await params.domainsRepo.isPersonalOrShared(domain));
}

async function dedupCandidatesByEmail(params: {
  db: Kysely<DB>;
  entitiesRepo: ReturnType<typeof createEntityRepository>;
  linkedinEntityId: string;
  emails: EnrichedEmail[];
}): Promise<DedupCandidate[]> {
  const emailHits = await params.entitiesRepo.getPersonEntitiesByEmails(params.emails.map((email) => email.email));
  const candidatesById = new Map<string, DedupCandidate>();
  for (const email of params.emails) {
    const normalized = normalizeContactPointValue("email", email.email);
    for (const hit of emailHits.get(normalized) ?? []) {
      const liveId = await resolveLiveEntityId(params.db, hit.id);
      if (liveId === params.linkedinEntityId) continue;
      const candidate = candidatesById.get(liveId) ?? { entityId: liveId, emails: [] };
      if (!candidate.emails.some((candidateEmail) => candidateEmail.email === email.email))
        candidate.emails.push(email);
      candidatesById.set(liveId, candidate);
    }
  }
  return [...candidatesById.values()].sort((a, b) => a.entityId.localeCompare(b.entityId));
}

function candidateReason(candidates: DedupCandidate[], candidate: DedupCandidate): string {
  const status = candidate.emails.some((email) => email.verified) ? "Valid" : "Unverifiable";
  return `SalesQL enrichment: shared email (${status}, ${candidates.length} candidate(s))`;
}

function candidateEvidence(candidate: DedupCandidate): { notes: string[] } {
  return {
    notes: [
      ...new Set(candidate.emails.map((email) => domainOf(email.email)).filter((domain): domain is string => !!domain)),
    ]
      .sort((a, b) => a.localeCompare(b))
      .map((domain) => `SalesQL email domain @${domain}`),
  };
}

function parseProposalResult(result: Awaited<ReturnType<typeof handleProposeGraphVerdicts>>): {
  stored: number;
  results: Array<{ disposition?: string }>;
} {
  return JSON.parse(result.content[0]?.text ?? "{}") as {
    stored: number;
    results: Array<{ disposition?: string }>;
  };
}

async function reResolveDedupByEmail(params: {
  db: Kysely<DB>;
  domainsRepo: EntityDomainsRepository;
  entitiesRepo: ReturnType<typeof createEntityRepository>;
  linkedinEntityId: string;
  emails: EnrichedEmail[];
  apply: boolean;
  autoMerge: boolean;
  logger: Logger;
}): Promise<DedupResult> {
  const candidates = await dedupCandidatesByEmail({
    db: params.db,
    entitiesRepo: params.entitiesRepo,
    linkedinEntityId: params.linkedinEntityId,
    emails: params.emails,
  });
  if (candidates.length === 0) {
    return { outcome: "attached", merged: 0, proposed: 0, wouldMerge: 0, wouldPropose: 0 };
  }

  const autoMergeCandidate =
    candidates.length === 1 &&
    (
      await Promise.all(
        candidates[0].emails.map((email) => emailPassesAutoMergeGuard({ email, domainsRepo: params.domainsRepo })),
      )
    ).some(Boolean);

  if (autoMergeCandidate && params.autoMerge) {
    if (!params.apply) return { outcome: "merged", merged: 0, proposed: 0, wouldMerge: 1, wouldPropose: 0 };
    const merge = await mergeEntities(params.db, {
      survivorId: candidates[0].entityId,
      loserId: params.linkedinEntityId,
      mergedBy: "salesql_enrichment@v1",
    });
    params.logger.info(
      { survivorId: candidates[0].entityId, loserId: params.linkedinEntityId, mergeId: merge.mergeId },
      "SalesQL enrichment auto-merged duplicate person",
    );
    return { outcome: "merged", merged: 1, proposed: 0, wouldMerge: 0, wouldPropose: 0 };
  }

  if (!params.apply) {
    return { outcome: "proposed", merged: 0, proposed: 0, wouldMerge: 0, wouldPropose: candidates.length };
  }

  const verdicts: Parameters<typeof handleProposeGraphVerdicts>[0]["verdicts"] = candidates.map((candidate) => ({
    action: "merge_into",
    subjectEntityId: params.linkedinEntityId,
    targetEntityId: candidate.entityId,
    reason: candidateReason(candidates, candidate),
    evidence: candidateEvidence(candidate),
  }));
  const result = parseProposalResult(
    await handleProposeGraphVerdicts({ verdicts }, params.db, {
      userId: MACHINE_PRINCIPAL_USER_ID,
      tokenId: "salesql-sweep",
    }),
  );
  const proposed = result.stored ?? 0;
  if (proposed < result.results.length) {
    params.logger.debug(
      { dispositions: result.results.map((row) => row.disposition) },
      "SalesQL merge proposal not inserted",
    );
  }
  return { outcome: "proposed", merged: 0, proposed, wouldMerge: 0, wouldPropose: 0 };
}

async function attachEmails(params: {
  entitiesRepo: ReturnType<typeof createEntityRepository>;
  entityId: string;
  emails: EnrichedEmail[];
  now: string;
  primary: EnrichedEmail | null;
}): Promise<void> {
  for (const email of params.emails) {
    await params.entitiesRepo.upsertContactPoint({
      entityId: params.entityId,
      kind: "email",
      value: email.email,
      source: "salesql",
      verifiedAt: email.verified ? params.now : null,
      makePrimary: params.primary?.email === email.email,
    });
  }
  if (params.primary) await params.entitiesRepo.attachEmailIfAbsent(params.entityId, params.primary.email);
}

async function attachPhones(params: {
  entitiesRepo: ReturnType<typeof createEntityRepository>;
  entityId: string;
  phones: EnrichedPhone[];
  now: string;
  logger: Logger;
}): Promise<void> {
  for (const phone of params.phones) {
    try {
      const country = normalizePhoneCountryCode(phone.countryCode);
      await params.entitiesRepo.upsertContactPoint({
        entityId: params.entityId,
        kind: "phone",
        value: normalizePhoneLike(phone.phone, country),
        label: phone.type,
        source: "salesql",
        verifiedAt: phone.valid ? params.now : null,
      });
    } catch (err) {
      params.logger.warn({ err, entityId: params.entityId }, "Skipped invalid SalesQL phone");
    }
  }
}

async function attachCompanyDomain(params: {
  db: Kysely<DB>;
  domainsRepo: EntityDomainsRepository;
  entitiesRepo: ReturnType<typeof createEntityRepository>;
  personEntityId: string;
  primary: EnrichedEmail | null;
  logger: Logger;
}): Promise<boolean> {
  if (!params.primary || params.primary.type !== "work") return false;
  const domain = domainOf(params.primary.email);
  if (!domain) return false;
  if (isRoleAccountEmail(params.primary.email)) return false;
  if (isProviderManagedEmailDomain(domain)) return false;
  if (await params.domainsRepo.isPersonalOrShared(domain)) return false;

  const companies = await params.entitiesRepo.listWorksAtCompanies(params.personEntityId);
  if (companies.length === 1 && !companies[0].hasCorporateDomain) {
    const result = await params.domainsRepo.upsertAuthoritativeCorporateDomain({
      entityId: companies[0].companyId,
      domain,
      source: "salesql",
      confidence: 0.9,
      isPrimary: true,
    });
    if (result === "inserted" || result === "updated") return true;
    if (result !== "skipped_manual_conflict" && result !== "skipped_auto_conflict") return false;
  }

  await inferAffiliationFromEmail(
    { db: params.db, domainsRepo: params.domainsRepo, logger: params.logger },
    { personEntityId: params.personEntityId, email: params.primary.email },
  );
  return false;
}

/**
 * `apply: false` still calls the provider — that is how hit-rate gets
 * measured — but writes nothing to entities and leaves found rows `pending`
 * (outcome `dry_run`) so the next `apply: true` run picks up the same rows
 * first. Found rows therefore cost one credit per mode; not-found is free.
 */
export async function runEnrichmentSweep(
  deps: EnrichmentSweepDeps,
  opts: EnrichmentSweepOptions,
): Promise<EnrichmentSweepReport> {
  const report = emptyEnrichmentSweepReport();
  const attemptsRepo = createEnrichmentAttemptsRepository(deps.db, { currentVersion: deps.provider.version });
  const entitiesRepo = deps.entitiesRepo ?? createEntityRepository(deps.db);
  const domainsRepo = deps.domainsRepo ?? createEntityDomainsRepository(deps.db);
  const apply = opts.apply === true;
  const now = new Date();
  const day = utcDay(now);
  report.seeded = await attemptsRepo.seedPendingCandidates(deps.provider.name, deps.provider.version);

  const used = await attemptsRepo.callsToday(deps.provider.name, day);
  const remaining = Math.max(0, opts.dailyCap - used);
  const limit = Math.max(0, Math.min(opts.batch, opts.limit ?? opts.batch, remaining));
  const rows = await attemptsRepo.selectEligible(deps.provider.name, limit, now);
  report.selected = rows.length;
  if (rows.length > 0 && deps.provider.allowance) {
    report.creditsRemaining = (await deps.provider.allowance()).remainingCalls;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i > 0 && i % 10 === 0) await yieldToEventLoop();
    try {
      const resolvedEntityId = await resolveLiveEntityId(deps.db, row.entity_id);
      const entity = await resolveLiveEntity(deps.db, row.entity_id);
      if (!entity || resolvedEntityId !== row.entity_id) {
        await attemptsRepo.markOutcome({
          provider: deps.provider.name,
          linkedinUrl: row.linkedin_url,
          providerVersion: deps.provider.version,
          status: "skipped",
          outcome: "merged_away",
        });
        report.skipped++;
        continue;
      }

      const result = await deps.provider.enrichByLinkedinUrl(row.linkedin_url);
      await attemptsRepo.recordCall(deps.provider.name, day);

      if (result.kind === "not_found") {
        await attemptsRepo.markOutcome({
          provider: deps.provider.name,
          linkedinUrl: row.linkedin_url,
          providerVersion: deps.provider.version,
          status: "not_found",
          outcome: "none",
        });
        report.notFound++;
        continue;
      }

      if (result.kind === "rate_limited") {
        await attemptsRepo.markOutcome({
          provider: deps.provider.name,
          linkedinUrl: row.linkedin_url,
          providerVersion: deps.provider.version,
          status: "pending",
          outcome: "rate_limited",
          retryAfterMs: result.retryAfterMs,
        });
        report.stoppedOn = "rate_limited";
        return report;
      }

      if (result.kind === "error") {
        await attemptsRepo.markOutcome({
          provider: deps.provider.name,
          linkedinUrl: row.linkedin_url,
          providerVersion: deps.provider.version,
          status: "failed",
          outcome: result.message,
        });
        report.failed++;
        if (result.status === 401 || result.status === 403) {
          deps.logger.warn({ status: result.status }, "SalesQL authorization failed; stopping enrichment sweep");
          report.stoppedOn = "auth";
          return report;
        }
        continue;
      }

      const selectedPrimary = primaryEmail(result.emails);
      const nowIso = new Date().toISOString();
      let outcome: "attached" | "merged" | "proposed" | "none" = selectedPrimary ? "attached" : "none";
      if (apply) {
        await attachEmails({
          entitiesRepo,
          entityId: entity.id,
          emails: result.emails,
          now: nowIso,
          primary: selectedPrimary,
        });
        await attachPhones({
          entitiesRepo,
          entityId: entity.id,
          phones: result.phones,
          now: nowIso,
          logger: deps.logger,
        });
        if (
          await attachCompanyDomain({
            db: deps.db,
            domainsRepo,
            entitiesRepo,
            personEntityId: entity.id,
            primary: selectedPrimary,
            logger: deps.logger,
          })
        ) {
          report.domainsAttached++;
        }
      }
      if (result.emails.length > 0) {
        const dedup = await reResolveDedupByEmail({
          db: deps.db,
          domainsRepo,
          entitiesRepo,
          linkedinEntityId: entity.id,
          emails: result.emails,
          apply,
          autoMerge: opts.autoMerge === true,
          logger: deps.logger,
        });
        outcome = dedup.outcome;
        report.merged += dedup.merged;
        report.proposed += dedup.proposed;
        report.wouldMerge += dedup.wouldMerge;
        report.wouldPropose += dedup.wouldPropose;
      }
      await attemptsRepo.markOutcome({
        provider: deps.provider.name,
        linkedinUrl: row.linkedin_url,
        providerVersion: deps.provider.version,
        status: apply ? "enriched" : "pending",
        emailsFound: result.emails.length,
        phonesFound: result.phones.length,
        outcome: apply ? outcome : "dry_run",
      });
      report.enriched++;
    } catch (err) {
      deps.logger.error(
        { err, linkedinUrl: row.linkedin_url, entityId: row.entity_id },
        "SalesQL enrichment row failed",
      );
      await attemptsRepo.markOutcome({
        provider: deps.provider.name,
        linkedinUrl: row.linkedin_url,
        providerVersion: deps.provider.version,
        status: "failed",
        outcome: err instanceof Error ? err.message : String(err),
      });
      report.failed++;
    }
  }

  return report;
}

export function createEnrichmentSweepService(deps: EnrichmentSweepServiceDeps): EnrichmentSweepService {
  let inflight: Promise<EnrichmentSweepReport> | null = null;

  async function runOnce(opts: { apply?: boolean; limit?: number } = {}): Promise<EnrichmentSweepReport> {
    if (inflight) return inflight;
    inflight = (async () => {
      const scope = await deps.readScope();
      if (!scope?.enabled) return emptyEnrichmentSweepReport();
      return runEnrichmentSweep(deps, {
        apply: opts.apply,
        limit: opts.limit,
        dailyCap: scope.dailyCap,
        batch: scope.batch,
        autoMerge: scope.autoMerge,
      });
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function tryRunManual(opts: { apply?: boolean; limit?: number } = {}): EnrichmentManualRunOutcome {
    if (inflight) return { started: false, reason: "in_flight" };
    const completion = runOnce(opts);
    completion
      .then((report) => deps.logger.info({ report }, "Manual SalesQL enrichment sweep completed"))
      .catch((err) => deps.logger.error({ err }, "Manual SalesQL enrichment sweep failed"));
    return { started: true, completion };
  }

  return { runOnce, tryRunManual };
}
