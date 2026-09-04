import { z } from "zod";

const enrichmentScopeSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    dailyCap: z.coerce.number().int().min(0).optional().default(200),
    batch: z.coerce.number().int().min(1).optional().default(50),
  })
  .strict();

export interface LinkedinEnrichmentScope {
  enabled: boolean;
  dailyCap: number;
  batch: number;
}

export function parseLinkedinEnrichmentScope(
  scopeConfig: Record<string, unknown> | null | undefined,
): LinkedinEnrichmentScope {
  return enrichmentScopeSchema.parse(scopeConfig?.enrichment ?? {});
}

export function normalizeLinkedinEnrichmentScopeConfig(scopeConfig: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(scopeConfig, "enrichment")) return scopeConfig;
  return { ...scopeConfig, enrichment: parseLinkedinEnrichmentScope(scopeConfig) };
}
