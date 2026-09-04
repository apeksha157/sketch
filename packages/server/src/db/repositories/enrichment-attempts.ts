import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import { buildLinkedinProfileUrl } from "../../connectors/linkedin-aimfox-mappers";
import { metadataFlagIsTrue } from "../dialect";
import type { DB, PersonEnrichmentAttemptsTable } from "../schema";
import { whereLiveEntity } from "./entities";

export type EnrichmentAttemptRow = Selectable<PersonEnrichmentAttemptsTable>;

export type EnrichmentOutcomeStatus = "enriched" | "not_found" | "failed" | "pending" | "skipped";

export interface MarkEnrichmentOutcomeInput {
  provider: string;
  linkedinUrl: string;
  providerVersion: string;
  status: EnrichmentOutcomeStatus;
  emailsFound?: number;
  phonesFound?: number;
  outcome?: string | null;
  retryAfterMs?: number | null;
  message?: string | null;
  now?: Date;
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function iso(date = new Date()): string {
  return date.toISOString();
}

function addMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function linkedinUrl(publicIdentifier: string): string | null {
  const value = publicIdentifier.trim().replace(/^\/+|\/+$/g, "");
  if (!value || value.startsWith("company:")) return null;
  return buildLinkedinProfileUrl(value.toLowerCase());
}

export function createEnrichmentAttemptsRepository(db: Kysely<DB>, opts: { currentVersion?: string } = {}) {
  async function seedPendingCandidates(providerName: string, version: string): Promise<number> {
    const rows = await db
      .selectFrom("entities")
      .select(["id"])
      .where("source_type", "=", "person")
      .where(whereLiveEntity())
      .where(metadataFlagIsTrue(db, "enrichmentCandidate"))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("entity_contact_points")
              .select(sql`1`.as("one"))
              .whereRef("entity_contact_points.entity_id", "=", "entities.id")
              .where("entity_contact_points.kind", "=", "email"),
          ),
        ),
      )
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    const entityIds = rows.map((row) => row.id);
    if (entityIds.length === 0) return 0;

    const refs = new Map<string, string>();
    const contactPoints = new Map<string, string>();
    for (const ids of chunk(entityIds, 500)) {
      const sourceRefs = await db
        .selectFrom("entity_source_refs")
        .select(["entity_id", "source_id"])
        .where("entity_id", "in", ids)
        .where("source", "=", "linkedin")
        .orderBy("last_seen_at", "desc")
        .execute();
      for (const ref of sourceRefs) if (!refs.has(ref.entity_id)) refs.set(ref.entity_id, ref.source_id);

      const linkedinPoints = await db
        .selectFrom("entity_contact_points")
        .select(["entity_id", "value"])
        .where("entity_id", "in", ids)
        .where("kind", "=", "linkedin")
        .orderBy("updated_at", "desc")
        .execute();
      for (const point of linkedinPoints) {
        if (!contactPoints.has(point.entity_id)) contactPoints.set(point.entity_id, point.value);
      }
    }

    let seeded = 0;
    const now = iso();
    for (const entityId of entityIds) {
      const url = linkedinUrl(refs.get(entityId) ?? contactPoints.get(entityId) ?? "");
      if (!url) continue;
      const result = await db
        .insertInto("person_enrichment_attempts")
        .values({
          provider: providerName,
          linkedin_url: url,
          entity_id: entityId,
          status: "pending",
          attempts: 0,
          last_attempt_at: null,
          next_eligible_at: null,
          provider_version: version,
          emails_found: 0,
          phones_found: 0,
          outcome: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(["provider", "linkedin_url"]).doNothing())
        .executeTakeFirst();
      seeded += Number(result.numInsertedOrUpdatedRows ?? 0);
    }
    return seeded;
  }

  async function selectEligible(
    providerName: string,
    limit: number,
    now = new Date(),
  ): Promise<EnrichmentAttemptRow[]> {
    if (limit <= 0) return [];
    const nowIso = iso(now);
    const currentVersion = opts.currentVersion ?? "";
    return db
      .selectFrom("person_enrichment_attempts")
      .selectAll()
      .where("provider", "=", providerName)
      .where((eb) => {
        const versionPredicates = currentVersion
          ? [eb.and([eb("provider_version", "!=", currentVersion), eb("status", "in", ["not_found", "failed"])])]
          : [];
        return eb.or([
          ...versionPredicates,
          eb.and([
            eb("status", "=", "pending"),
            eb.or([eb("next_eligible_at", "is", null), eb("next_eligible_at", "<=", nowIso)]),
          ]),
          eb.and([eb("status", "in", ["failed", "not_found"]), eb("next_eligible_at", "<=", nowIso)]),
        ]);
      })
      .orderBy("created_at", "asc")
      .orderBy("linkedin_url", "asc")
      .limit(limit)
      .execute();
  }

  async function recordCall(provider: string, day = utcDay()): Promise<void> {
    await db
      .insertInto("enrichment_daily_usage")
      .values({ provider, day, calls: 1, updated_at: iso() })
      .onConflict((oc) =>
        oc.columns(["provider", "day"]).doUpdateSet({
          calls: sql`enrichment_daily_usage.calls + 1`,
          updated_at: iso(),
        }),
      )
      .execute();
  }

  async function callsToday(provider: string, day = utcDay()): Promise<number> {
    const row = await db
      .selectFrom("enrichment_daily_usage")
      .select("calls")
      .where("provider", "=", provider)
      .where("day", "=", day)
      .executeTakeFirst();
    return Number(row?.calls ?? 0);
  }

  async function markOutcome(input: MarkEnrichmentOutcomeInput): Promise<void> {
    const now = input.now ?? new Date();
    const nowIso = iso(now);
    const existing = await db
      .selectFrom("person_enrichment_attempts")
      .select(["attempts"])
      .where("provider", "=", input.provider)
      .where("linkedin_url", "=", input.linkedinUrl)
      .executeTakeFirst();
    const nextAttempts = Number(existing?.attempts ?? 0) + 1;
    const base = {
      attempts: nextAttempts,
      last_attempt_at: nowIso,
      provider_version: input.providerVersion,
      emails_found: input.emailsFound ?? 0,
      phones_found: input.phonesFound ?? 0,
      outcome: input.outcome ?? input.message ?? null,
      updated_at: nowIso,
    };
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const errorBackoffMs = Math.min(2 ** nextAttempts * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
    const retryBackoffMs = input.retryAfterMs ?? 60 * 60 * 1000;
    const status = input.status === "pending" ? "pending" : input.status;
    const nextEligibleAt =
      input.status === "not_found"
        ? addMs(now, ninetyDaysMs)
        : input.status === "failed"
          ? addMs(now, errorBackoffMs)
          : input.status === "pending" && input.retryAfterMs !== undefined
            ? addMs(now, retryBackoffMs)
            : null;

    await db
      .updateTable("person_enrichment_attempts")
      .set({
        ...base,
        status,
        next_eligible_at: nextEligibleAt,
      })
      .where("provider", "=", input.provider)
      .where("linkedin_url", "=", input.linkedinUrl)
      .execute();
  }

  return {
    callsToday,
    markOutcome,
    recordCall,
    seedPendingCandidates,
    selectEligible,
  };
}
