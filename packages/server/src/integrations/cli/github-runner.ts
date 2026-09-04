import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAX_ARGUMENTS = 24;
const MAX_ARGUMENT_LENGTH = 512;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const TIMEOUT_MS = 120_000;

export interface GithubCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GithubCliTokenProvider = (params?: { forceRefresh?: boolean }) => Promise<{
  accessToken: string;
  expiresAt?: string;
}>;

export class GithubCliPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubCliPolicyError";
  }
}

const LONG_FILE_ARGUMENTS = ["--body-file", "--env-file", "--input", "--notes-file", "--template"] as const;
const SHORT_FILE_ARGUMENTS = ["-T"] as const;
const FIELD_ARGUMENTS = new Set(["-F", "-f", "--field", "--raw-field"]);
const INTERACTIVE_ARGUMENTS = new Set(["-w", "-e", "--web", "--editor"]);

function explicitFileArgumentValue(
  arg: string,
  next: string | undefined,
): { value: string | null; consumesNext: boolean } {
  const lower = arg.toLowerCase();
  if (LONG_FILE_ARGUMENTS.includes(lower as (typeof LONG_FILE_ARGUMENTS)[number])) {
    return { value: next ?? null, consumesNext: next !== undefined };
  }
  for (const option of LONG_FILE_ARGUMENTS) {
    if (lower.startsWith(`${option}=`)) return { value: arg.slice(arg.indexOf("=") + 1), consumesNext: false };
  }
  if (SHORT_FILE_ARGUMENTS.includes(arg as (typeof SHORT_FILE_ARGUMENTS)[number])) {
    return { value: next ?? null, consumesNext: next !== undefined };
  }
  if (arg.startsWith("-T=") || (arg.startsWith("-T") && arg.length > 2)) {
    return { value: arg.slice(arg.startsWith("-T=") ? 3 : 2), consumesNext: false };
  }
  return { value: null, consumesNext: false };
}

/** Every file the CLI would read or write for this argv, including file flags and positional candidates. */
function extractFileReferences(argv: readonly string[], requiredReferences = new Set<string>()): string[] {
  const references: string[] = [];
  const consumedIndexes = new Set<number>();

  for (let index = 0; index < argv.length; index += 1) {
    const { value, consumesNext } = explicitFileArgumentValue(argv[index] ?? "", argv[index + 1]);
    if (value !== null) {
      references.push(value);
      requiredReferences.add(value);
    }
    if (consumesNext) consumedIndexes.add(index + 1);
  }

  for (let index = 1; index < argv.length; index += 1) {
    if (consumedIndexes.has(index)) continue;
    const value = argv[index] ?? "";
    if (value.startsWith("-") || value.startsWith("http://") || value.startsWith("https://")) continue;
    if (argv[0]?.toLowerCase() === "api" && index === 1) continue;
    references.push(value);
  }

  return references;
}

function fieldArgumentValue(argv: readonly string[], index: number): string | null {
  const arg = argv[index] ?? "";
  const lower = arg.toLowerCase();
  if (FIELD_ARGUMENTS.has(arg) || FIELD_ARGUMENTS.has(lower)) return argv[index + 1] ?? null;
  if (arg.startsWith("-F") || arg.startsWith("-f")) return arg.slice(2);
  if (lower.startsWith("--field=") || lower.startsWith("--raw-field=")) return arg.slice(arg.indexOf("=") + 1);
  return null;
}

function validateFieldFileReferences(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const value = fieldArgumentValue(argv, index);
    if (value === null) continue;
    const markerIndex = value.indexOf("=@");
    if (markerIndex >= 0 && value.slice(markerIndex + 2) !== "-") {
      throw new GithubCliPolicyError(
        "GitHub CLI @file field values are not allowed; use --input with a workspace file or pass data on stdin",
      );
    }
  }
}

export function validateGithubCliArguments(argv: readonly string[], workspaceDir: string): void {
  if (argv.length === 0 || argv.length > MAX_ARGUMENTS) {
    throw new GithubCliPolicyError("GitHub CLI command has an invalid argument count");
  }
  if (argv.some((arg) => arg.length === 0 || arg.length > MAX_ARGUMENT_LENGTH || arg.includes("\0"))) {
    throw new GithubCliPolicyError("GitHub CLI command contains an invalid argument");
  }

  const command = argv[0]?.toLowerCase();
  if (command === "auth" || command === "config" || command === "alias" || command === "extension") {
    throw new GithubCliPolicyError(`GitHub CLI command '${command}' is not available through Sketch`);
  }

  validateFieldFileReferences(argv);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const lower = arg.toLowerCase();
    if (
      lower === "--config" ||
      lower.startsWith("--config=") ||
      lower === "--hostname" ||
      lower.startsWith("--hostname=") ||
      lower === "--header" ||
      lower.startsWith("--header=") ||
      arg.startsWith("-H") ||
      lower === "--with-token" ||
      lower === "--password-stdin" ||
      lower === "--token" ||
      lower.startsWith("--token=") ||
      lower === "--oauth-token" ||
      lower.startsWith("--oauth-token=") ||
      lower === "--access-token" ||
      lower.startsWith("--access-token=")
    ) {
      throw new GithubCliPolicyError("GitHub CLI authentication, host, header, and config overrides are not allowed");
    }

    if (isAlternateGithubHost(lower)) {
      throw new GithubCliPolicyError("GitHub CLI alternate hosts are not allowed");
    }

    if (
      INTERACTIVE_ARGUMENTS.has(arg) ||
      INTERACTIVE_ARGUMENTS.has(lower) ||
      lower.startsWith("--web=") ||
      lower.startsWith("--editor=")
    ) {
      throw new GithubCliPolicyError("GitHub CLI browser and editor modes are not available through Sketch");
    }
  }

  for (const fileReference of extractFileReferences(argv)) {
    if (fileReference && fileReference !== "-") validateWorkspacePath(fileReference, workspaceDir);
  }
}

function isAlternateGithubHost(value: string): boolean {
  if (!value.startsWith("http://") && !value.startsWith("https://")) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname !== "github.com" && hostname !== "api.github.com";
  } catch {
    return true;
  }
}

function validateWorkspacePath(value: string, workspaceDir: string): void {
  const workspace = resolve(workspaceDir);
  const candidate = resolve(workspace, value);
  const rel = relative(workspace, candidate);
  if (rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new GithubCliPolicyError("GitHub CLI file paths must stay inside the Sketch workspace");
}

export function isGithubAuthenticationFailure(result: GithubCliResult): boolean {
  if (result.exitCode === 4) return true;
  if (result.exitCode === 0) return false;
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /\b(?:401|bad credentials|invalid token|authentication required|authentication failed|unauthorized)\b/.test(
    text,
  );
}

export async function runGithubCli(params: {
  argv: readonly string[];
  workspaceDir: string;
  stdin?: string;
  getAccessToken: GithubCliTokenProvider;
}): Promise<GithubCliResult> {
  validateGithubCliArguments(params.argv, params.workspaceDir);
  if (params.stdin !== undefined && Buffer.byteLength(params.stdin, "utf8") > MAX_STDIN_BYTES) {
    throw new GithubCliPolicyError("GitHub CLI stdin exceeds the allowed limit");
  }

  const workspace = await realpath(params.workspaceDir).catch(() => {
    throw new GithubCliPolicyError("GitHub CLI workspace is unavailable");
  });
  if (!(await stat(workspace)).isDirectory()) throw new GithubCliPolicyError("GitHub CLI workspace is not a directory");
  await validateGithubCliWorkspaceFiles(params.argv, workspace);

  let result = await executeWithToken(params, false, workspace);
  if (!isGithubAuthenticationFailure(result)) return result;
  result = await executeWithToken(params, true, workspace);
  return result;
}

async function validateGithubCliWorkspaceFiles(argv: readonly string[], workspaceDir: string): Promise<void> {
  const requiredReferences = new Set<string>();
  for (const fileReference of extractFileReferences(argv, requiredReferences)) {
    if (!fileReference || fileReference === "-") continue;
    const candidate = resolve(workspaceDir, fileReference);
    const rel = relative(workspaceDir, candidate);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new GithubCliPolicyError("GitHub CLI file paths must stay inside the Sketch workspace");
    }
    const canonical = await realpath(candidate).catch(() => null);
    if (!canonical) {
      if (requiredReferences.has(fileReference)) {
        throw new GithubCliPolicyError("GitHub CLI file path is unavailable");
      }
      continue;
    }
    const canonicalRel = relative(workspaceDir, canonical);
    if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel)) {
      throw new GithubCliPolicyError("GitHub CLI file paths must stay inside the Sketch workspace");
    }
  }
}

async function executeWithToken(
  params: {
    argv: readonly string[];
    workspaceDir: string;
    stdin?: string;
    getAccessToken: GithubCliTokenProvider;
  },
  forceRefresh: boolean,
  workspace: string,
): Promise<GithubCliResult> {
  const token = await params.getAccessToken({ forceRefresh });
  if (!token.accessToken) throw new Error("Canvas returned an empty GitHub access token");

  const tempHome = await mkdtemp(join(tmpdir(), "sketch-gh-"));
  try {
    return await spawnGithub({ ...params, workspace, tempHome, accessToken: token.accessToken });
  } finally {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  }
}

function redact(value: string, secret: string): string {
  return value.split(secret).join("[REDACTED]");
}

async function spawnGithub(params: {
  argv: readonly string[];
  stdin?: string;
  workspace: string;
  tempHome: string;
  accessToken: string;
}): Promise<GithubCliResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: params.tempHome,
    GH_CONFIG_DIR: params.tempHome,
    GH_TOKEN: params.accessToken,
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
  };
  for (const key of [
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn("gh", [...params.argv], {
      cwd: params.workspace,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputOverflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      outputOverflow = false;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000).unref();
    }, TIMEOUT_MS);
    timer.unref();

    const append = (current: string, chunk: Buffer): string => {
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        outputOverflow = true;
        return current;
      }
      const included = chunk.subarray(0, remaining);
      outputBytes += included.byteLength;
      const text = included.toString("utf8");
      if (included.byteLength < chunk.byteLength) outputOverflow = true;
      return current + text;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      if (outputOverflow && child.exitCode === null) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      if (outputOverflow && child.exitCode === null) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputOverflow) stderr += "\n[GitHub CLI output truncated]";
      if (code === null) stderr += "\n[GitHub CLI timed out or was terminated]";
      resolvePromise({
        stdout: redact(stdout, params.accessToken),
        stderr: redact(stderr, params.accessToken),
        exitCode: code ?? 124,
      });
    });
    if (params.stdin !== undefined) child.stdin.write(params.stdin);
    child.stdin.end();
  });
}
