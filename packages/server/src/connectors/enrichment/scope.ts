import { z } from "zod";

export const LINKEDIN_VISIBILITY_MODES = ["owner", "workspace"] as const;
export type LinkedinVisibilityMode = (typeof LINKEDIN_VISIBILITY_MODES)[number];

const enrichmentScopeSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    dailyCap: z.coerce.number().int().min(0).optional().default(25),
    batch: z.coerce.number().int().min(1).optional().default(50),
    autoMerge: z.boolean().optional().default(false),
  })
  .strict();

const linkedinVisibilitySchema = z.enum(LINKEDIN_VISIBILITY_MODES);

export interface LinkedinEnrichmentScope {
  enabled: boolean;
  dailyCap: number;
  batch: number;
  autoMerge: boolean;
}

export class LinkedinVisibilityScopeValidationError extends Error {
  override name = "LinkedinVisibilityScopeValidationError";
}

export function parseLinkedinEnrichmentScope(
  scopeConfig: Record<string, unknown> | null | undefined,
): LinkedinEnrichmentScope {
  return enrichmentScopeSchema.parse(scopeConfig?.enrichment ?? {});
}

export function parseLinkedinVisibilityScopeConfig(
  scopeConfig: Record<string, unknown> | null | undefined,
): LinkedinVisibilityMode {
  return linkedinVisibilitySchema.catch("owner").parse(scopeConfig?.visibility);
}

export function normalizeLinkedinEnrichmentScopeConfig(scopeConfig: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(scopeConfig, "enrichment")) return scopeConfig;
  return { ...scopeConfig, enrichment: parseLinkedinEnrichmentScope(scopeConfig) };
}

export function normalizeLinkedinVisibilityScopeConfig(
  scopeConfig: Record<string, unknown>,
  opts: { required?: boolean; forbidden?: boolean } = {},
): Record<string, unknown> {
  const hasVisibility = Object.hasOwn(scopeConfig, "visibility");
  if (opts.forbidden && hasVisibility) {
    throw new LinkedinVisibilityScopeValidationError(
      "LinkedIn visibility must be changed with PUT /api/connectors/:id/visibility",
    );
  }
  if (opts.required && !hasVisibility) {
    throw new LinkedinVisibilityScopeValidationError("LinkedIn visibility is required");
  }
  if (!hasVisibility) return scopeConfig;
  return { ...scopeConfig, visibility: linkedinVisibilitySchema.parse(scopeConfig.visibility) };
}
