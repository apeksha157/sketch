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

const FILE_ARGUMENTS = new Set(["--body-file", "--env-file", "--input", "--notes-file"]);

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

    const fileOption = FILE_ARGUMENTS.has(lower);
    const fileValue = fileOption
      ? argv[index + 1]
      : lower.startsWith("--body-file=")
        ? arg.slice(arg.indexOf("=") + 1)
        : null;
    if (fileValue && fileValue !== "-") validateWorkspacePath(fileValue, workspaceDir);
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const lower = arg.toLowerCase();
    const fileValue = FILE_ARGUMENTS.has(lower)
      ? argv[index + 1]
      : lower.startsWith("--body-file=")
        ? arg.slice(arg.indexOf("=") + 1)
        : null;
    if (!fileValue || fileValue === "-") continue;
    const candidate = resolve(workspaceDir, fileValue);
    const rel = relative(workspaceDir, candidate);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new GithubCliPolicyError("GitHub CLI file paths must stay inside the Sketch workspace");
    }
    const canonical = await realpath(candidate).catch(() => {
      throw new GithubCliPolicyError("GitHub CLI file path is unavailable");
    });
    const canonicalRel = relative(workspaceDir, canonical);
    if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel)) {
      throw new GithubCliPolicyError("GitHub CLI file paths must stay inside the Sketch workspace");
    }
  }

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (value.startsWith("-") || value.startsWith("http://") || value.startsWith("https://")) continue;
    if (argv[0]?.toLowerCase() === "api" && index === 1) continue;
    const candidate = resolve(workspaceDir, value);
    const lexicalRel = relative(workspaceDir, candidate);
    if (isAbsolute(value) || lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
      throw new GithubCliPolicyError("GitHub CLI file paths must stay inside the Sketch workspace");
    }
    const canonical = await realpath(candidate).catch(() => null);
    if (!canonical) continue;
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
  const blockedEnvKeys = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !blockedEnvKeys.has(key)),
  ) as NodeJS.ProcessEnv;
  env.HOME = params.tempHome;
  env.GH_CONFIG_DIR = params.tempHome;
  env.GH_TOKEN = params.accessToken;

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
