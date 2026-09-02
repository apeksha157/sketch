/**
 * Admin alias management for the entity drawer.
 *
 * Add writes the alias at human_confirmed provenance and clears any standing
 * rejection for that name, so a previously deleted alias can be declared back.
 * Remove deletes every stored variant sharing the same normalized form (the
 * matcher treats them as one name) and records a rejection so the pipeline
 * cannot re-mint it. Edit on the client is remove-then-add.
 */
import type { Kysely } from "kysely";
import { deleteAliasRows, recordAlias } from "../db/repositories/entity-alias-rows";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";
import { isJunkAliasValue, isSelfAliasValue } from "./alias-write-gate";
import { parseAliasesString } from "./materialize-json";
import { normalizeName } from "./name-keys";

export type AliasAdminErrorCode = "ENTITY_NOT_FOUND" | "INVALID_ALIAS" | "DUPLICATE_ALIAS" | "ALIAS_NOT_FOUND";

export class AliasAdminError extends Error {
  constructor(
    public readonly code: AliasAdminErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AliasAdminError";
  }
}

async function getLiveEntity(db: Kysely<DB>, entityId: string) {
  const entity = await db
    .selectFrom("entities")
    .select(["id", "name", "aliases"])
    .where("id", "=", entityId)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .executeTakeFirst();
  if (!entity) throw new AliasAdminError("ENTITY_NOT_FOUND", "Entity not found");
  return entity;
}

export async function addDeclaredAlias(
  db: Kysely<DB>,
  input: { entityId: string; alias: string; userId: string },
): Promise<{ aliases: string[] }> {
  const alias = input.alias.trim();
  const normalized = normalizeName(alias);
  if (!alias || !normalized || isJunkAliasValue(alias)) {
    throw new AliasAdminError("INVALID_ALIAS", "That doesn't look like a usable alias");
  }
  const entity = await getLiveEntity(db, input.entityId);
  if (isSelfAliasValue(alias, entity.name)) {
    throw new AliasAdminError("DUPLICATE_ALIAS", "That is already the entity's name");
  }
  const aliases = parseAliasesString(entity.aliases);
  if (aliases.some((existing) => normalizeName(existing) === normalized)) {
    throw new AliasAdminError("DUPLICATE_ALIAS", "That alias is already on the entity");
  }
  const next = [...aliases, alias];
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("entities")
      .set({ aliases: JSON.stringify(next), updated_at: new Date().toISOString() })
      .where("id", "=", entity.id)
      .execute();
    await recordAlias(trx, {
      entityId: entity.id,
      alias,
      provenance: "human_confirmed",
      createdBy: input.userId,
    });
    await trx
      .deleteFrom("entity_alias_rejections")
      .where("entity_id", "=", entity.id)
      .where("normalized_rejected_name", "=", normalized)
      .execute();
  });
  return { aliases: next };
}

export async function removeAliasEverywhere(
  db: Kysely<DB>,
  input: { entityId: string; alias: string; userId: string },
): Promise<{ removed: string[]; aliases: string[] }> {
  const normalized = normalizeName(input.alias);
  if (!normalized) throw new AliasAdminError("INVALID_ALIAS", "Alias is required");
  const entity = await getLiveEntity(db, input.entityId);
  const aliases = parseAliasesString(entity.aliases);
  const removed = aliases.filter((existing) => normalizeName(existing) === normalized);
  if (removed.length === 0) throw new AliasAdminError("ALIAS_NOT_FOUND", "Alias not found on the entity");
  const next = aliases.filter((existing) => normalizeName(existing) !== normalized);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("entities")
      .set({ aliases: next.length > 0 ? JSON.stringify(next) : null, updated_at: new Date().toISOString() })
      .where("id", "=", entity.id)
      .execute();
    await deleteAliasRows(trx, entity.id, removed);
    await createEntityReviewRepo(trx).addRejection({
      entityId: entity.id,
      rejectedName: removed[0] as string,
      rejectedBy: input.userId,
    });
  });
  return { removed, aliases: next };
}
