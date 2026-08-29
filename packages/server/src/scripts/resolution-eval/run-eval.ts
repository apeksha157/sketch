import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runBaselineAssertions } from "./assertions";
import { dbTargetFromArg, withClient } from "./db";
import { DEFAULT_MANIFEST_PATH, readManifest } from "./manifest";
import { buildEvalReport, writeReportFiles } from "./report";
import { refreshEvalSnapshot } from "./snapshot";

const DEFAULT_EVAL_DB = "sketch_canvas_ai_eval";
const DEFAULT_REPORT_DIR = resolve(fileURLToPath(new URL("./reports", import.meta.url)));

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      db: { type: "string" },
      "source-db": { type: "string" },
      "eval-db": { type: "string" },
      manifest: { type: "string", default: DEFAULT_MANIFEST_PATH },
      set: { type: "string", default: "baseline" },
      "out-dir": { type: "string", default: DEFAULT_REPORT_DIR },
      "refresh-snapshot": { type: "boolean", default: false },
      "force-dump": { type: "boolean", default: false },
    },
  });

  if (parsed.values.set !== "baseline") {
    throw new Error(`Unknown assertion set: ${parsed.values.set}`);
  }

  const evalDb = parsed.values["eval-db"] ?? parsed.values.db ?? DEFAULT_EVAL_DB;
  if (parsed.values["refresh-snapshot"]) {
    const sourceDb = parsed.values["source-db"];
    if (!sourceDb) throw new Error("--refresh-snapshot requires --source-db");
    await refreshEvalSnapshot(sourceDb, {
      evalDatabase: evalDb,
      preferTemplate: parsed.values["force-dump"] !== true,
    });
  }

  const manifest = await readManifest(String(parsed.values.manifest));
  const target = dbTargetFromArg(evalDb, { readOnly: true });
  if (!target.databaseName.endsWith("_eval")) {
    throw new Error(`Refusing to run assertions against non-eval database: ${target.databaseName}`);
  }
  const assertions = await withClient(evalDb, { readOnly: true }, (client) => runBaselineAssertions(client, manifest));
  const report = buildEvalReport({
    database: target.databaseName,
    assertionSet: String(parsed.values.set),
    manifestGeneratedAt: manifest.generatedAt,
    assertions,
  });
  const paths = await writeReportFiles(report, String(parsed.values["out-dir"]));
  process.stdout.write(`${JSON.stringify({ summary: report.summary, paths }, null, 2)}\n`);
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
