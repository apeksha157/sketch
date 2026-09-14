import { z } from "zod";

export const LINKEDIN_VISIBILITY_MODES = ["owner", "workspace"] as const;
export type LinkedinVisibilityMode = (typeof LINKEDIN_VISIBILITY_MODES)[number];

/**
 * `autoMerge` defaults on: a clean match (exactly one existing person with the same
 * work email) merges without review. Personal addresses, role inboxes and multi-matches
 * still file proposals regardless. Rows that never stored the key pick this up on their
 * next sweep, which is intended.
 */
const enrichmentScopeSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    dailyCap: z.coerce.number().int().min(0).optional().default(25),
    batch: z.coerce.number().int().min(1).optional().default(50),
    autoMerge: z.boolean().optional().default(true),
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

/**
 * The chunk-engine switch is operator-facing, so it lives in the connector's
 * scope config next to `visibility` and `enrichment` rather than in a
 * deployment secret. Absent means "not decided here": the deployment-wide
 * `LINKEDIN_CHUNK_ENGINE_ENABLED` default then applies.
 */
export function parseLinkedinChunkEngineScopeConfig(
  scopeConfig: Record<string, unknown> | null | undefined,
): boolean | undefined {
  const value = scopeConfig?.chunkEngine;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The single reader of the chunk-engine switch. Every surface that branches on
 * it — sync routing, the reindex worker, the API — goes through here, so the
 * per-connector value and the env default can never disagree between them.
 */
export function resolveLinkedinChunkEngineEnabled(input: {
  scopeConfig: Record<string, unknown> | null | undefined;
  envDefault: boolean | undefined;
}): boolean {
  return parseLinkedinChunkEngineScopeConfig(input.scopeConfig) ?? input.envDefault === true;
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
