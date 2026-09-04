export interface PersonEnrichmentProvider {
  readonly name: string;
  readonly version: string;
  enrichByLinkedinUrl(url: string): Promise<EnrichmentResult>;
  allowance?(): Promise<{ remainingCalls: number | null }>;
}

export type EnrichmentResult =
  | { kind: "found"; emails: EnrichedEmail[]; phones: EnrichedPhone[] }
  | { kind: "not_found" }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "error"; status: number | null; message: string };

export type EnrichedEmail = {
  email: string;
  type: "work" | "direct";
  verified: boolean;
};

export type EnrichedPhone = {
  phone: string;
  type: "work" | "personal";
  countryCode: string | null;
  valid: boolean;
};
