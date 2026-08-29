import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AssertionResult {
  id: string;
  title: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  details?: string[];
}

export interface EvalReport {
  runId: string;
  generatedAt: string;
  manifestGeneratedAt: string;
  database: string;
  assertionSet: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  assertions: AssertionResult[];
}

export function buildEvalReport(input: {
  database: string;
  assertionSet: string;
  manifestGeneratedAt: string;
  assertions: AssertionResult[];
  now?: Date;
}): EvalReport {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const passed = input.assertions.filter((assertion) => assertion.passed).length;
  const failed = input.assertions.length - passed;
  return {
    runId: generatedAt.replace(/[:.]/g, "-"),
    generatedAt,
    manifestGeneratedAt: input.manifestGeneratedAt,
    database: input.database,
    assertionSet: input.assertionSet,
    summary: { total: input.assertions.length, passed, failed },
    assertions: input.assertions,
  };
}

function fencedJson(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

export function renderMarkdownReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Resolution Eval ${report.runId}`);
  lines.push("");
  lines.push(`Database: \`${report.database}\``);
  lines.push(`Assertion set: \`${report.assertionSet}\``);
  lines.push(`Generated: \`${report.generatedAt}\``);
  lines.push(`Manifest: \`${report.manifestGeneratedAt}\``);
  lines.push("");
  lines.push(`Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed.`);
  lines.push("");
  for (const assertion of report.assertions) {
    lines.push(`## ${assertion.passed ? "PASS" : "FAIL"} ${assertion.id}`);
    lines.push("");
    lines.push(assertion.title);
    if (assertion.details && assertion.details.length > 0) {
      lines.push("");
      for (const detail of assertion.details) lines.push(`- ${detail}`);
    }
    lines.push("");
    lines.push("Expected:");
    lines.push(fencedJson(assertion.expected));
    lines.push("");
    lines.push("Actual:");
    lines.push(fencedJson(assertion.actual));
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeReportFiles(
  report: EvalReport,
  outDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, `${report.runId}.json`);
  const markdownPath = join(outDir, `${report.runId}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, renderMarkdownReport(report));
  return { jsonPath, markdownPath };
}
