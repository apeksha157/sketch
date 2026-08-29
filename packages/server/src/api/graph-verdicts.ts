import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import {
  type GraphVerdictRow,
  type GraphVerdictRunRollup,
  createGraphVerdictRepository,
} from "../db/repositories/graph-verdicts";
import type { DB } from "../db/schema";
import { GraphVerdictApplyError, applyGraphVerdict, revertGraphVerdict } from "../entities/verdict-apply";

function requireAdmin(c: Context) {
  if (c.get("role") !== "admin") {
    return { error: { code: "FORBIDDEN", message: "Admin access required" } };
  }
  return null;
}

function parseJson(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function serializeRun(row: GraphVerdictRunRollup) {
  return {
    id: row.id,
    source: row.source,
    proposedByUserId: row.proposed_by_user_id,
    tokenId: row.token_id,
    note: row.note,
    verdictsProposed: row.verdicts_proposed,
    verdictsStored: row.verdicts_stored,
    verdictsBounced: row.verdicts_bounced,
    createdAt: row.created_at,
    rollups: row.rollups,
  };
}

function serializeVerdict(row: GraphVerdictRow) {
  return {
    id: row.id,
    runId: row.run_id,
    action: row.action,
    subjectEntityId: row.subject_entity_id,
    subjectContainerId: row.subject_container_id,
    subjectName: row.subject_name,
    subjectEntityType: row.subject_entity_type,
    targetEntityId: row.target_entity_id,
    resolvedTargetEntityId: row.resolved_target_entity_id,
    targetName: row.target_name,
    reason: row.reason,
    evidence: parseJson(row.evidence_json),
    evidenceFingerprint: row.evidence_fingerprint,
    validationStatus: row.validation_status,
    validationReason: row.validation_reason,
    wouldChange: parseJson(row.would_change_json),
    status: row.status,
    supersededAt: row.superseded_at,
    decidedAt: row.decided_at,
    decidedByUserId: row.decided_by_user_id,
    appliedLedgerRef: row.applied_ledger_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type")?.includes("application/json")) return {};
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorResponse(c: Context, err: unknown) {
  if (err instanceof GraphVerdictApplyError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "INVALID_VERDICT_STATE" ? 400 : 409;
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, status);
  }
  throw err;
}

/**
 * Admin-gated with no dev-tools flag: graph verdicts are the product review
 * surface (Your Org), matching the project-minting verdict routes' posture.
 */
export function graphVerdictRoutes(db: Kysely<DB>, logger: Logger) {
  const routes = new Hono();
  const verdicts = createGraphVerdictRepository(db);

  routes.get("/", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const statuses = (c.req.query("status") ?? "").split(",").filter(Boolean);
    const allowed = new Set(["awaiting_human", "approved"]);
    if (statuses.length === 0 || statuses.some((status) => !allowed.has(status))) {
      return c.json(
        {
          error: {
            code: "UNSUPPORTED_FILTER",
            message: "status must be a comma-separated subset of: awaiting_human, approved",
          },
        },
        400,
      );
    }
    const rows = await verdicts.listByStatuses(statuses as ("awaiting_human" | "approved")[]);
    return c.json({ verdicts: rows.map(serializeVerdict) });
  });

  routes.get("/runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    return c.json({ runs: (await verdicts.listRunsWithRollups()).map(serializeRun) });
  });

  routes.get("/runs/:id/verdicts", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    return c.json({ verdicts: (await verdicts.listByRun(c.req.param("id"))).map(serializeVerdict) });
  });

  routes.post("/:id/approval", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const id = c.req.param("id");
    const won = await verdicts.markApproved({ id, actorUserId: c.get("sub") });
    const row = await verdicts.findById(id);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Graph verdict not found" } }, 404);
    if (!won && row.status === "awaiting_human") {
      return c.json({ error: { code: "APPLY_CONFLICT", message: "Graph verdict approval lost" } }, 409);
    }
    return c.json({ verdict: serializeVerdict(row) });
  });

  routes.post("/:id/rejection", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const id = c.req.param("id");
    const won = await verdicts.markRejected({ id, actorUserId: c.get("sub") });
    const row = await verdicts.findById(id);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Graph verdict not found" } }, 404);
    if (!won && row.status === "awaiting_human") {
      return c.json({ error: { code: "APPLY_CONFLICT", message: "Graph verdict rejection lost" } }, 409);
    }
    return c.json({ verdict: serializeVerdict(row) });
  });

  routes.post("/:id/application", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    try {
      const body = await readJsonObject(c);
      const application = await applyGraphVerdict(db, {
        verdictId: c.req.param("id"),
        actorUserId: c.get("sub"),
        dryRun: body.dryRun === true,
      });
      return c.json({ application });
    } catch (err) {
      logger.warn({ err, verdictId: c.req.param("id") }, "Graph verdict application failed");
      return errorResponse(c, err);
    }
  });

  routes.post("/:id/reversion", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    try {
      const reversion = await revertGraphVerdict(db, { verdictId: c.req.param("id"), actorUserId: c.get("sub") });
      return c.json({ reversion });
    } catch (err) {
      logger.warn({ err, verdictId: c.req.param("id") }, "Graph verdict reversion failed");
      return errorResponse(c, err);
    }
  });

  return routes;
}
