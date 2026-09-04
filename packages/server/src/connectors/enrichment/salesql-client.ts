import { createHash } from "node:crypto";
import { acquireRpmSlot } from "../rpm-pacer";
import type { EnrichedEmail, EnrichedPhone, EnrichmentResult, PersonEnrichmentProvider } from "./provider";

const SALESQL_BASE_URL = "https://api-public.salesql.com";
const DEFAULT_MAX_RPM = 60;

export interface SalesqlClientOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRpm?: number;
}

type SalesqlEmail = {
  email?: unknown;
  type?: unknown;
  status?: unknown;
};

type SalesqlPhone = {
  phone?: unknown;
  number?: unknown;
  type?: unknown;
  country_code?: unknown;
  is_valid?: unknown;
};

type SalesqlPerson = {
  emails?: unknown;
  phones?: unknown;
};

function readRetryAfterMs(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

function summarizeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "SalesQL API error";
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 240)}...`;
}

function readPersonPayload(raw: unknown): SalesqlPerson {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const nested = record.person;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as SalesqlPerson;
  return record as SalesqlPerson;
}

function mapEmails(value: unknown): EnrichedEmail[] {
  if (!Array.isArray(value)) return [];
  const out: EnrichedEmail[] = [];
  for (const item of value as SalesqlEmail[]) {
    const email = typeof item.email === "string" ? item.email.trim().toLowerCase() : "";
    if (!email) continue;
    out.push({ email, type: item.type === "Work" ? "work" : "direct", verified: item.status === "Valid" });
  }
  return out;
}

function mapPhones(value: unknown): EnrichedPhone[] {
  if (!Array.isArray(value)) return [];
  const out: EnrichedPhone[] = [];
  for (const item of value as SalesqlPhone[]) {
    const phone =
      typeof item.phone === "string" ? item.phone.trim() : typeof item.number === "string" ? item.number.trim() : "";
    if (!phone) continue;
    out.push({
      phone,
      type: item.type === "Work" ? "work" : "personal",
      countryCode: typeof item.country_code === "string" && item.country_code.trim() ? item.country_code.trim() : null,
      valid: item.is_valid === true,
    });
  }
  return out;
}

export class SalesqlClient implements PersonEnrichmentProvider {
  readonly name = "salesql";
  readonly version = "v1";
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRpm: number;
  private readonly quotaIdentity: string;

  constructor(
    private readonly apiKey: string,
    options: SalesqlClientOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRpm = options.maxRpm ?? DEFAULT_MAX_RPM;
    this.quotaIdentity = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  }

  async enrichByLinkedinUrl(url: string): Promise<EnrichmentResult> {
    const params = new URLSearchParams({ linkedin_url: url });
    return this.request(`/v1/persons/enrich?${params.toString()}`);
  }

  async allowance(): Promise<{ remainingCalls: number | null }> {
    const result = await this.requestAllowance();
    return { remainingCalls: result };
  }

  private async request(path: string): Promise<EnrichmentResult> {
    try {
      const response = await this.fetchSalesql(path);
      if (response.status === 404) return { kind: "not_found" };
      if (response.status === 429) return { kind: "rate_limited", retryAfterMs: readRetryAfterMs(response) };
      if (response.status === 401 || response.status === 403) {
        return {
          kind: "error",
          status: response.status,
          message: `SalesQL API authorization failed (${response.status})`,
        };
      }
      if (!response.ok) {
        const body = await response.text();
        return { kind: "error", status: response.status, message: summarizeErrorBody(body) };
      }
      const payload = readPersonPayload(await response.json());
      return { kind: "found", emails: mapEmails(payload.emails), phones: mapPhones(payload.phones) };
    } catch (err) {
      return { kind: "error", status: null, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async requestAllowance(): Promise<number | null> {
    try {
      const response = await this.fetchSalesql("/v1/allowance");
      if (!response.ok) return null;
      const payload = await response.json();
      if (!payload || typeof payload !== "object") return null;
      const record = payload as Record<string, unknown>;
      const candidates = [record.remainingCalls, record.remaining_calls, record.remaining, record.credits];
      for (const candidate of candidates) {
        const value =
          typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : Number.NaN;
        if (Number.isFinite(value)) return value;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchSalesql(path: string): Promise<Response> {
    await acquireRpmSlot(`salesql:${this.quotaIdentity}`, { maxRpm: this.maxRpm, sleep: this.sleep });
    return this.fetchFn(`${SALESQL_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }
}
