import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { automationBuilderSaveRequestSchema } from "@sketch/shared";
import {
  AutomationValidationError,
  buildAutomationDefinition,
  validateAutomationBuilderSaveRequest,
} from "../packages/server/src/automation/definition";

/** Validates protected offline exports without contacting or changing any production system. */
async function main() {
  const bundleDir = process.argv[2];
  if (!bundleDir) throw new Error("Usage: tsx scripts/habuild-clickup-validate.ts /protected/replacements");
  const root = resolve(bundleDir);
  const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error("No replacement bundles found");
  const report = [];
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  for (const name of names) {
    const bundle = JSON.parse(await readFile(resolve(root, name), "utf8"));
    if (
      bundle.taskId !== bundle.row.id ||
      bundle.ownerId !== bundle.row.created_by ||
      bundle.expectedRevision !== bundle.row.revision
    ) {
      throw new Error(`Identity or revision mismatch: ${name}`);
    }
    const definition = buildAutomationDefinition({
      row: bundle.row,
      stepContentRows: bundle.contents,
      runRows: [],
      includeWebhookMetadata: false,
    });
    const request = automationBuilderSaveRequestSchema.parse({
      ...definition,
      expectedRevision: bundle.expectedRevision,
    });
    validateAutomationBuilderSaveRequest({ request, brokerCapable: false, validateScheduleFuture: false });
    if (request.status !== "paused") throw new Error(`Replacement is not paused: ${name}`);
    for (const content of Object.values(request.stepContent)) {
      if (content.contentType !== "script") continue;
      if (/CANVAS_CLI|INTEGRATION_CLI|ctx\.integrations|file_content_base64/.test(content.content))
        throw new Error(`Legacy action remains: ${name}`);
      new AsyncFunction("input", "ctx", "signal", content.content);
    }
    bundle.request = request;
    const encoded = `${JSON.stringify(bundle, null, 2)}\n`;
    await writeFile(resolve(root, name), encoded, { mode: 0o600 });
    report.push({
      taskId: bundle.taskId,
      expectedRevision: bundle.expectedRevision,
      paused: true,
      steps: request.steps.length,
      sha256: createHash("sha256").update(encoded).digest("hex"),
    });
  }
  process.stdout.write(`${JSON.stringify({ mode: "offline", definitions: report }, null, 2)}\n`);
}

main().catch((error) => {
  if (error instanceof AutomationValidationError)
    process.stderr.write(`${JSON.stringify(error.issues.map(({ code, path }) => ({ code, path })))}\n`);
  process.stderr.write(`Offline validation failed: ${error instanceof Error ? error.name : "unknown"}\n`);
  process.exitCode = 1;
});
