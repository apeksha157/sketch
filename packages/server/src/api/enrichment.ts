import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { EnrichmentSweepService } from "../entities/enrichment-sweep";
import { denyIfNotAdmin } from "./auth-helpers";

const runSchema = z.object({
  apply: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

export interface EnrichmentRouteConfig {
  service?: EnrichmentSweepService | null;
}

export function enrichmentRoutes(routeConfig: EnrichmentRouteConfig, logger: Logger) {
  const routes = new Hono();

  routes.post("/runs", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    if (!routeConfig.service) {
      return c.json(
        {
          error: { code: "ENRICHMENT_SWEEP_UNAVAILABLE", message: "SalesQL enrichment is not running in this process" },
        },
        503,
      );
    }

    const body = c.req.header("content-type")?.includes("application/json") ? await c.req.json() : {};
    const parsed = runSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request" } },
        400,
      );
    }

    const outcome = routeConfig.service.tryRunManual(parsed.data);
    if (!outcome.started) {
      return c.json({ error: { code: "RUN_IN_FLIGHT", message: "An enrichment sweep is already running" } }, 409);
    }
    outcome.completion.catch((err) => logger.error({ err }, "Manual SalesQL enrichment sweep failed"));
    return c.json({ run: { status: "started" } }, 202);
  });

  return routes;
}
