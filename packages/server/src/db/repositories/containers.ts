import { randomUUID } from "node:crypto";
import type { Kysely, Selectable, UpdateObject } from "kysely";
import { sql } from "kysely";
import type { ConnectorType } from "../../connectors/types";
import type { ContainersTable, DB } from "../schema";
import { whereLiveEntity } from "./entities";

export type ContainerRow = Selectable<ContainersTable>;

export interface ObserveContainerInput {
  connectorConfigId: string;
  connectorType: ConnectorType;
  externalId: string;
  levelKey: string;
  name: string;
  pathIds: string[];
  pathNames: string[];
  parentExternalId?: string | null;
  itemCount?: number;
  firstItemAt?: string | null;
  lastItemAt?: string | null;
  providerArchived?: boolean;
  providerTypedKind?: string | null;
  hasDates?: boolean;
  observedAt?: string;
}

export function createContainerRepository(db: Kysely<DB>) {
  async function resolveParentContainerId(input: ObserveContainerInput): Promise<string | null> {
    if (!input.parentExternalId) return null;
    const parent = await db
      .selectFrom("containers")
      .select("id")
      .where("connector_config_id", "=", input.connectorConfigId)
      .where("external_id", "=", input.parentExternalId)
      .executeTakeFirst();
    return parent?.id ?? null;
  }

  async function resolveClassifiedEntityId(input: ObserveContainerInput): Promise<string | null> {
    const row = await db
      .selectFrom("entity_source_refs")
      .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
      .select("entities.id")
      .where("entity_source_refs.source", "=", input.connectorType)
      .where("entity_source_refs.source_id", "=", input.externalId)
      .where(whereLiveEntity())
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async function getByExternalId(connectorConfigId: string, externalId: string): Promise<ContainerRow | null> {
    const row = await db
      .selectFrom("containers")
      .selectAll()
      .where("connector_config_id", "=", connectorConfigId)
      .where("external_id", "=", externalId)
      .executeTakeFirst();
    return row ?? null;
  }

  return {
    async observeContainer(input: ObserveContainerInput): Promise<ContainerRow> {
      const observedAt = input.observedAt ?? new Date().toISOString();
      const parentContainerId = await resolveParentContainerId(input);
      const classifiedEntityId = await resolveClassifiedEntityId(input);
      /**
       * On re-observation, a field the caller did not state is left as previously
       * recorded — an emitter pass that walks the hierarchy without counting items
       * must not wipe stats a richer pass wrote earlier.
       */
      const update: UpdateObject<DB, "containers", "containers"> = {
        connector_type: input.connectorType,
        level_key: input.levelKey,
        name: input.name,
        path_ids: JSON.stringify(input.pathIds),
        path_names: JSON.stringify(input.pathNames),
        parent_container_id: parentContainerId,
        last_seen_at: observedAt,
        updated_at: observedAt,
      };
      if (input.itemCount !== undefined) update.item_count = input.itemCount;
      if (input.firstItemAt !== undefined) update.first_item_at = input.firstItemAt;
      if (input.lastItemAt !== undefined) update.last_item_at = input.lastItemAt;
      if (input.providerArchived !== undefined) update.provider_archived = input.providerArchived ? 1 : 0;
      if (input.providerTypedKind !== undefined) update.provider_typed_kind = input.providerTypedKind;
      if (input.hasDates !== undefined) update.has_dates = input.hasDates ? 1 : 0;
      if (classifiedEntityId) {
        update.classified_entity_id = sql`COALESCE(containers.classified_entity_id, ${classifiedEntityId})`;
      }

      await db
        .insertInto("containers")
        .values({
          id: randomUUID(),
          connector_config_id: input.connectorConfigId,
          connector_type: input.connectorType,
          external_id: input.externalId,
          level_key: input.levelKey,
          name: input.name,
          path_ids: JSON.stringify(input.pathIds),
          path_names: JSON.stringify(input.pathNames),
          parent_container_id: parentContainerId,
          item_count: input.itemCount ?? 0,
          first_item_at: input.firstItemAt ?? null,
          last_item_at: input.lastItemAt ?? null,
          provider_archived: input.providerArchived ? 1 : 0,
          provider_typed_kind: input.providerTypedKind ?? null,
          has_dates: input.hasDates ? 1 : 0,
          discovered_at: observedAt,
          last_seen_at: observedAt,
          classified_entity_id: classifiedEntityId,
          created_at: observedAt,
          updated_at: observedAt,
        })
        .onConflict((oc) => oc.columns(["connector_config_id", "external_id"]).doUpdateSet(update))
        .execute();

      const row = await getByExternalId(input.connectorConfigId, input.externalId);
      if (!row) throw new Error("Observed container was not found after upsert");
      return row;
    },

    async listByConnector(connectorConfigId: string): Promise<ContainerRow[]> {
      return db
        .selectFrom("containers")
        .selectAll()
        .where("connector_config_id", "=", connectorConfigId)
        .orderBy("level_key")
        .orderBy("name")
        .execute();
    },

    getByExternalId,
  };
}
