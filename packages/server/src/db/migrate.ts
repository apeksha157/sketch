/**
 * Programmatic migration runner using static imports.
 * Static imports instead of FileMigrationProvider so it works with tsdown bundling.
 */
import { Migrator } from "kysely";
import type { Kysely } from "kysely";
import * as m001 from "./migrations/001-initial";
import * as m002 from "./migrations/002-channels";
import * as m003 from "./migrations/003-whatsapp-auth";
import * as m004 from "./migrations/004-settings";
import * as m005 from "./migrations/005-settings-slack-llm";
import * as m006 from "./migrations/006-settings-jwt-secret";
import * as m007 from "./migrations/007-connectors";
import * as m008 from "./migrations/008-user-provider-identities";
import * as m009 from "./migrations/009-file-access";
import * as m010 from "./migrations/010-settings-extended";
import * as m011 from "./migrations/011-semantic-search";
import * as m012 from "./migrations/012-settings-smtp";
import * as m013 from "./migrations/013-email-verification";
import * as m014 from "./migrations/014-magic-link-tokens";
import * as m015 from "./migrations/015-mcp-servers";
import * as m016a from "./migrations/016-mcp-server-mode";
import * as m016b from "./migrations/016-user-description";
import * as m017a from "./migrations/017-chat-sessions";
import * as m017b from "./migrations/017-outreach-messages";
import * as m018a from "./migrations/018-scheduled-tasks";
import * as m018b from "./migrations/018-user-type-role-hierarchy";
import * as m019 from "./migrations/019-chat-sessions-thread-key-sentinel";
import * as m020 from "./migrations/020-whatsapp-groups";
import * as m021 from "./migrations/021-settings-enrichment";
import * as m025 from "./migrations/025-agent-usage";
import * as m026 from "./migrations/026-normalize-created-at";
import * as m027 from "./migrations/027-entities";
import type { DB } from "./schema";

export async function runMigrations(db: Kysely<DB>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return {
          "001-initial": m001,
          "002-channels": m002,
          "003-whatsapp-auth": m003,
          "004-settings": m004,
          "005-settings-slack-llm": m005,
          "006-settings-jwt-secret": m006,
          "007-connectors": m007,
          "008-user-provider-identities": m008,
          "009-file-access": m009,
          "010-settings-extended": m010,
          "011-semantic-search": m011,
          "012-settings-smtp": m012,
          "013-email-verification": m013,
          "014-magic-link-tokens": m014,
          "015-mcp-servers": m015,
          "016-mcp-server-mode": m016a,
          "016-user-description": m016b,
          "017-chat-sessions": m017a,
          "017-outreach-messages": m017b,
          "018-scheduled-tasks": m018a,
          "018-user-type-role-hierarchy": m018b,
          "019-chat-sessions-thread-key-sentinel": m019,
          "020-whatsapp-groups": m020,
          "021-settings-enrichment": m021,
          "025-agent-usage": m025,
          "026-normalize-created-at": m026,
          "027-entities": m027,
        };
      },
    },
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === "Success") {
      console.log(`Migration applied: ${result.migrationName}`);
    } else if (result.status === "Error") {
      console.error(`Migration failed: ${result.migrationName}`);
    }
  }

  if (error) {
    console.error("Migration run failed:", error);
    process.exit(1);
  }
}
