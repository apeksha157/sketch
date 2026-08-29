import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dbTargetFromArg, withClient } from "./db";
import { DEFAULT_MANIFEST_PATH, buildResolutionEvalManifest, writeManifest } from "./manifest";

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: DEFAULT_MANIFEST_PATH },
      "target-files": { type: "string", default: "100" },
    },
  });
  const dbSpec = parsed.positionals[0];
  if (!dbSpec) {
    throw new Error("Usage: tsx build-manifest.ts <db-name-or-connection-string> [--out eval-manifest.json]");
  }
  const target = dbTargetFromArg(dbSpec, { readOnly: true });
  const manifest = await withClient(dbSpec, { readOnly: true }, (client) =>
    buildResolutionEvalManifest(client, {
      sourceDatabase: target.databaseName,
      targetFileCount: Number(parsed.values["target-files"]),
    }),
  );
  await writeManifest(String(parsed.values.out), manifest);
  process.stdout.write(`Wrote ${manifest.files.length} files to ${parsed.values.out}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
