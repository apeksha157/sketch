import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { EnrichedEmail, EnrichedPhone, PersonEnrichmentProvider } from "../connectors/enrichment/provider";
import { createEnrichmentAttemptsRepository } from "../db/repositories/enrichment-attempts";
import { createEntityRepository } from "../db/repositories/entities";
import { type EntityDomainsRepository, createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { normalizePhoneCountryCode, normalizePhoneLike } from "../identity-normalization";
import { yieldToEventLoop } from "../lib/event-loop";
import { inferAffiliationFromEmail, isProviderManagedEmailDomain, isRoleAccountEmail } from "./affiliations";
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
}

export interface EnrichmentSweepReport {
  seeded: number;
  selected: number;
  enriched: number;
  notFound: number;
  failed: number;
  skipped: number;
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
  readScope: () => Promise<{ enabled: boolean; dailyCap: number; batch: number } | null>;
}

export function emptyEnrichmentSweepReport(): EnrichmentSweepReport {
  return {
    seeded: 0,
    selected: 0,
    enriched: 0,
    notFound: 0,
    failed: 0,
    skipped: 0,
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
      await attemptsRepo.markOutcome({
        provider: deps.provider.name,
        linkedinUrl: row.linkedin_url,
        providerVersion: deps.provider.version,
        status: apply ? "enriched" : "pending",
        emailsFound: result.emails.length,
        phonesFound: result.phones.length,
        outcome: apply ? (selectedPrimary ? "attached" : "none") : "dry_run",
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
