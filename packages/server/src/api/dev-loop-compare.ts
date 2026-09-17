import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { DB } from "../db/schema";
import {
  type ConsolidatedLoopExtractorVersion,
  type LoopCompareListParams,
  type LoopCompareSourceBucket,
  compareConsolidatedLoopStage,
  listConsolidatedLoopStagesForCompare,
  selectExistingConsolidatedLoopStages,
} from "../eval/consolidated-loop-report";
import { denyIfNotAdmin } from "./auth-helpers";

const BUCKETS = new Set<LoopCompareSourceBucket>(["fireflies", "email", "slack", "whatsapp", "docs"]);
const VERSIONS = new Set<ConsolidatedLoopExtractorVersion>(["loop-v1", "loop-v2"]);

function invalidQuery(c: Parameters<typeof denyIfNotAdmin>[0], field: string) {
  return c.json({ error: { code: "INVALID_QUERY", message: `Invalid ${field}`, field } }, 400);
}

function validSince(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
  }
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function parseListParams(c: Parameters<typeof denyIfNotAdmin>[0]): LoopCompareListParams | Response {
  const since = c.req.query("since");
  if (since !== undefined && !validSince(since)) return invalidQuery(c, "since");

  const limitValue = c.req.query("limit");
  if (limitValue !== undefined && !/^\d+$/.test(limitValue)) return invalidQuery(c, "limit");
  const limit = limitValue === undefined ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return invalidQuery(c, "limit");

  const bucket = c.req.query("bucket");
  if (bucket !== undefined && !BUCKETS.has(bucket as LoopCompareSourceBucket)) return invalidQuery(c, "bucket");

  const version = c.req.query("version");
  if (version !== undefined && !VERSIONS.has(version as ConsolidatedLoopExtractorVersion)) {
    return invalidQuery(c, "version");
  }

  return {
    since: since ?? null,
    limit,
    bucket: (bucket as LoopCompareSourceBucket | undefined) ?? null,
    version: (version as ConsolidatedLoopExtractorVersion | undefined) ?? null,
  };
}

export function devLoopCompareRoutes(db: Kysely<DB>, logger: Logger) {
  const routes = new Hono();

  routes.get("/loop-stages", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const params = parseListParams(c);
    if (params instanceof Response) return params;
    const stages = await listConsolidatedLoopStagesForCompare(db, params);
    logger.debug({ stageCount: stages.length }, "Listed loop comparison stages");
    return c.json({ stages });
  });

  routes.get("/loop-stages/:fileId", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const version = c.req.query("version");
    if (version !== undefined && !VERSIONS.has(version as ConsolidatedLoopExtractorVersion)) {
      return invalidQuery(c, "version");
    }
    const fileId = c.req.param("fileId");
    const [selection] = await selectExistingConsolidatedLoopStages(db, {
      fileIds: [fileId],
      version: (version as ConsolidatedLoopExtractorVersion | undefined) ?? null,
      limit: 1,
    });
    if (!selection) {
      return c.json({ error: { code: "NOT_FOUND", message: "Loop stage not found" } }, 404);
    }
    const detail = await compareConsolidatedLoopStage(db, selection.file, selection.stage);
    logger.debug({ fileId, alignedCount: detail.aligned.length }, "Loaded loop comparison detail");
    return c.json({ detail });
  });

  return routes;
}
