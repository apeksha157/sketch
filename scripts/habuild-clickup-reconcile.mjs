import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

function readFlag(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function readRepeatedFlags(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function parseExpectedRevision(value) {
  const separator = value.lastIndexOf("=");
  if (separator <= 0) throw new Error(`Expected revision must use workflow-id=revision: ${value}`);
  const id = value.slice(0, separator);
  const revision = Number(value.slice(separator + 1));
  if (!Number.isInteger(revision) || revision < 0)
    throw new Error(`Expected revision is not a non-negative integer: ${value}`);
  return [id, revision];
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function workflowRows(snapshot) {
  if (!Array.isArray(snapshot.workflows)) throw new Error("snapshot.workflows must be an array");
  return snapshot.workflows.map((workflow, index) => {
    const row = assertObject(workflow, `snapshot.workflows[${index}]`);
    if (typeof row.id !== "string" || !row.id) throw new Error(`snapshot.workflows[${index}].id is required`);
    if (!Number.isInteger(row.revision) || row.revision < 0) {
      throw new Error(`snapshot.workflows[${index}].revision must be a non-negative integer`);
    }
    if (typeof row.status !== "string" || !row.status) {
      throw new Error(`snapshot.workflows[${index}].status is required`);
    }
    return row;
  });
}

function buildReport(manifest, snapshot, expectedOverrides) {
  const rows = workflowRows(snapshot);
  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.id)) throw new Error(`snapshot contains duplicate workflow ID ${row.id}`);
    byId.set(row.id, row);
  }

  const expected = new Map((manifest.workflowInventory ?? []).map((workflow) => [workflow.id, workflow]));
  for (const [id, revision] of expectedOverrides) {
    const workflow = expected.get(id);
    if (!workflow) throw new Error(`--expected-revision names an ID outside the manifest: ${id}`);
    expected.set(id, { ...workflow, expectedRevision: revision });
  }

  const checks = [...expected.values()].map((workflow) => {
    const actual = byId.get(workflow.id);
    if (!actual) {
      return {
        id: workflow.id,
        state: "missing",
        expectedRevision: workflow.expectedRevision,
        expectedStatus: workflow.expectedStatus,
      };
    }
    const revisionMatches = actual.revision === workflow.expectedRevision;
    const statusMatches = actual.status === workflow.expectedStatus;
    return {
      id: workflow.id,
      state: revisionMatches && statusMatches ? "ready_for_review" : "drift",
      expectedRevision: workflow.expectedRevision,
      actualRevision: actual.revision,
      expectedStatus: workflow.expectedStatus,
      actualStatus: actual.status,
      sourceTrigger: workflow.sourceTrigger,
      replacement: workflow.replacement,
      wouldChange: true,
    };
  });

  return {
    artifactVersion: manifest.artifactVersion,
    mode: "dry-run",
    productionMutation: false,
    sourceSnapshot: snapshot.source ?? null,
    checks,
    summary: {
      checked: checks.length,
      readyForReview: checks.filter((check) => check.state === "ready_for_review").length,
      drifted: checks.filter((check) => check.state === "drift").length,
      missing: checks.filter((check) => check.state === "missing").length,
    },
    nextStep:
      "Supply approved replacement definitions, protected backups, and fresh expected revisions to the authorized persistence workflow.",
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--apply") || args.includes("--execute")) {
    throw new Error("This utility is preflight-only; use the approved persistence workflow for any authorized apply.");
  }
  const manifestPath = resolve(
    root,
    readFlag(args, "--manifest") ?? "docs/habuild-clickup/reconciliation-manifest.json",
  );
  const snapshotPath = readFlag(args, "--snapshot");
  const manifest = assertObject(JSON.parse(await readFile(manifestPath, "utf8")), "manifest");
  const expectedOverrides = new Map(readRepeatedFlags(args, "--expected-revision").map(parseExpectedRevision));
  const snapshot = snapshotPath
    ? assertObject(JSON.parse(await readFile(resolve(snapshotPath), "utf8")), "snapshot")
    : { source: { kind: "none" }, workflows: [] };
  const report = buildReport(manifest, snapshot, expectedOverrides);
  const backupDir = readFlag(args, "--backup-dir");
  if (backupDir && snapshotPath) {
    await mkdir(resolve(backupDir), { recursive: true });
    const backupPath = resolve(backupDir, `${basename(snapshotPath, ".json")}.preflight-backup.json`);
    const safeBackup = {
      source: snapshot.source ?? null,
      workflows: workflowRows(snapshot).map(({ id, revision, status, schedule_type, schedule_value }) => ({
        id,
        revision,
        status,
        ...(schedule_type === undefined ? {} : { schedule_type }),
        ...(schedule_value === undefined ? {} : { schedule_value }),
      })),
    };
    await writeFile(backupPath, `${JSON.stringify(safeBackup, null, 2)}\n`, { flag: "wx" });
    report.localBackup = backupPath;
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.drifted > 0 || report.summary.missing > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
