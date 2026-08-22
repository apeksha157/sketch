import type { Kysely, Selectable } from "kysely";
import type { ContainersTable, DB } from "../db/schema";

type ContainerRow = Selectable<ContainersTable>;
type SettledClassification = "team" | "time_box" | "ignore";
type SettledStatus = "active" | "historical";

export type ContainerSettlementResult = {
  settled: number;
  cleared: number;
  skippedHumanDecided: number;
};

function settlementFor(row: ContainerRow): { classification: SettledClassification; status: SettledStatus } | null {
  const providerKind = row.provider_typed_kind?.toLowerCase() ?? null;
  let classification: SettledClassification | null = null;
  if (providerKind === "team") classification = "team";
  else if (providerKind === "cycle" || providerKind === "sprint" || (row.level_key === "list" && row.has_dates === 1)) {
    classification = "time_box";
  } else if (providerKind === "doc") {
    classification = "ignore";
  }

  if (row.provider_archived === 1) {
    return { classification: classification ?? "ignore", status: "historical" };
  }
  return classification ? { classification, status: "active" } : null;
}

/**
 * Provider-fact settlement is deliberately not ledgered: typed provider kind,
 * date, and archive facts are re-observed on every sync, so the label can be
 * re-derived from the current container row without a human decision trail.
 */
export async function settleContainersFromProviderFacts(
  db: Kysely<DB>,
  connectorConfigId: string,
): Promise<ContainerSettlementResult> {
  const rows = await db
    .selectFrom("containers")
    .selectAll()
    .where("connector_config_id", "=", connectorConfigId)
    .execute();
  const result: ContainerSettlementResult = { settled: 0, cleared: 0, skippedHumanDecided: 0 };
  for (const row of rows) {
    if (row.verdict_id) {
      result.skippedHumanDecided += 1;
      continue;
    }
    const settlement = settlementFor(row);
    if (!settlement) {
      if (row.classification !== null || row.classification_status !== null) {
        await db
          .updateTable("containers")
          .set({
            classification: null,
            classification_status: null,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", row.id)
          .where("verdict_id", "is", null)
          .execute();
        result.cleared += 1;
      }
      continue;
    }
    if (row.classification === settlement.classification && row.classification_status === settlement.status) {
      continue;
    }
    await db
      .updateTable("containers")
      .set({
        classification: settlement.classification,
        classification_status: settlement.status,
        verdict_id: null,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", row.id)
      .where("verdict_id", "is", null)
      .execute();
    result.settled += 1;
  }
  return result;
}
