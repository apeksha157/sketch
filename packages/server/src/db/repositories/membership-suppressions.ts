import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";
import { normalizeContactPointValue } from "./entities";

export interface SuppressMembershipInput {
  connectorConfigId: string;
  email: string;
}

/**
 * Per-connection suppressions remove bot and admin identities from every
 * membership denominator and numerator. The membership pass is a deterministic
 * full recompute from activity plus this list, so changing a row here needs no
 * trigger machinery.
 */
export function createMembershipSuppressionRepository(db: Kysely<DB>) {
  return {
    async suppress(input: SuppressMembershipInput): Promise<void> {
      await db
        .insertInto("membership_suppressions")
        .values({
          id: randomUUID(),
          connector_config_id: input.connectorConfigId,
          suppressed_email: normalizeContactPointValue("email", input.email),
        })
        .onConflict((oc) => oc.columns(["connector_config_id", "suppressed_email"]).doNothing())
        .execute();
    },

    async list(connectorConfigId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("membership_suppressions")
        .select("suppressed_email")
        .where("connector_config_id", "=", connectorConfigId)
        .orderBy("suppressed_email", "asc")
        .execute();
      return rows.map((row) => row.suppressed_email);
    },

    async clear(input: SuppressMembershipInput): Promise<void> {
      await db
        .deleteFrom("membership_suppressions")
        .where("connector_config_id", "=", input.connectorConfigId)
        .where("suppressed_email", "=", normalizeContactPointValue("email", input.email))
        .execute();
    },
  };
}

export type MembershipSuppressionRepository = ReturnType<typeof createMembershipSuppressionRepository>;
