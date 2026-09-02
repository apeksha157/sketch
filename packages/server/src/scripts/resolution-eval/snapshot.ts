import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import {
  adminConnectionStringFor,
  connectionStringForDatabaseLike,
  dbTargetFromArg,
  quoteIdentifier,
  withClient,
} from "./db";

export interface SnapshotResult {
  sourceDatabase: string;
  evalDatabase: string;
  method: "template" | "dump_restore";
}

function runPipeline(sourceConnectionString: string, evalConnectionString: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const dump = spawn(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", "--dbname", sourceConnectionString],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const restore = spawn("pg_restore", ["--no-owner", "--no-privileges", "--dbname", evalConnectionString], {
      stdio: ["pipe", "ignore", "pipe"],
    });

    const stderr: string[] = [];
    dump.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    restore.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    dump.stdout.pipe(restore.stdin);

    let dumpCode: number | null = null;
    let restoreCode: number | null = null;
    const maybeDone = (): void => {
      if (dumpCode === null || restoreCode === null) return;
      if (dumpCode === 0 && restoreCode === 0) resolve();
      else reject(new Error(`pg_dump|pg_restore failed: ${stderr.join("").trim()}`));
    };
    dump.on("error", reject);
    restore.on("error", reject);
    dump.on("close", (code) => {
      dumpCode = code;
      maybeDone();
    });
    restore.on("close", (code) => {
      restoreCode = code;
      maybeDone();
    });
  });
}

async function dropEvalDatabase(admin: pg.Client, evalDatabase: string): Promise<void> {
  await admin.query(
    `select pg_terminate_backend(pid)
     from pg_stat_activity
     where datname = $1 and pid <> pg_backend_pid()`,
    [evalDatabase],
  );
  try {
    await admin.query(`drop database if exists ${quoteIdentifier(evalDatabase)} with (force)`);
  } catch {
    await admin.query(`drop database if exists ${quoteIdentifier(evalDatabase)}`);
  }
}

async function createViaTemplate(admin: pg.Client, sourceDatabase: string, evalDatabase: string): Promise<void> {
  await dropEvalDatabase(admin, evalDatabase);
  await admin.query(`create database ${quoteIdentifier(evalDatabase)} template ${quoteIdentifier(sourceDatabase)}`);
}

async function createViaDumpRestore(sourceSpec: string, sourceDatabase: string, evalDatabase: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminConnectionStringFor(sourceSpec) });
  await admin.connect();
  try {
    await dropEvalDatabase(admin, evalDatabase);
    await admin.query(`create database ${quoteIdentifier(evalDatabase)}`);
  } finally {
    await admin.end();
  }
  await runPipeline(
    connectionStringForDatabaseLike(sourceSpec, sourceDatabase, { readOnly: true }),
    connectionStringForDatabaseLike(sourceSpec, evalDatabase),
  );
}

export async function refreshEvalSnapshot(
  sourceSpec: string,
  options: { evalDatabase?: string; preferTemplate?: boolean } = {},
): Promise<SnapshotResult> {
  const source = dbTargetFromArg(sourceSpec, { readOnly: true });
  const evalDatabase = options.evalDatabase ?? `${source.databaseName}_eval`;
  if (evalDatabase === source.databaseName || !evalDatabase.endsWith("_eval")) {
    throw new Error(`Refusing unsafe eval snapshot target: ${evalDatabase}`);
  }

  await withClient(sourceSpec, { readOnly: true }, async (client) => {
    await client.query("select current_database()");
  });

  if (options.preferTemplate === false) {
    await createViaDumpRestore(sourceSpec, source.databaseName, evalDatabase);
    return { sourceDatabase: source.databaseName, evalDatabase, method: "dump_restore" };
  }

  const admin = new pg.Client({ connectionString: adminConnectionStringFor(sourceSpec) });
  await admin.connect();
  try {
    await createViaTemplate(admin, source.databaseName, evalDatabase);
    return { sourceDatabase: source.databaseName, evalDatabase, method: "template" };
  } catch {
    await createViaDumpRestore(sourceSpec, source.databaseName, evalDatabase);
    return { sourceDatabase: source.databaseName, evalDatabase, method: "dump_restore" };
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      "eval-db": { type: "string" },
      "force-dump": { type: "boolean", default: false },
    },
  });
  const sourceSpec = parsed.positionals[0];
  if (!sourceSpec)
    throw new Error("Usage: tsx snapshot.ts <source-db-or-connection-string> [--eval-db sketch_canvas_ai_eval]");
  const result = await refreshEvalSnapshot(sourceSpec, {
    evalDatabase: parsed.values["eval-db"],
    preferTemplate: parsed.values["force-dump"] !== true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
