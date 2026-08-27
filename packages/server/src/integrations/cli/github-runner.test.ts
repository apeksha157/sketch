import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GithubCliPolicyError,
  isGithubAuthenticationFailure,
  runGithubCli,
  validateGithubCliArguments,
} from "./github-runner";

describe("GitHub CLI runner policy", () => {
  let tempRoot: string;
  let workspaceDir: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sketch-github-runner-"));
    workspaceDir = join(tempRoot, "workspace");
    await mkdir(workspaceDir);
    await writeFile(join(workspaceDir, "notes.md"), "release notes");
    const outsideFile = join(tempRoot, "outside.md");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, join(workspaceDir, "outside-link.md"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    { argv: ["api", "/gists", "-F", "content=@/etc/hosts"], hole: "field file expansion" },
    { argv: ["api", "/gists", "--field", "content=@/etc/hosts"], hole: "long field file expansion" },
    { argv: ["api", "/gists", "-f", "content=@/etc/hosts"], hole: "raw field file expansion" },
    { argv: ["api", "/gists", "--raw-field", "content=@../../.env"], hole: "long raw field file expansion" },
    { argv: ["api", "/gists", "-Fcontent=@/etc/hosts"], hole: "attached field file expansion" },
    { argv: ["pr", "create", "--body-file", "/etc/hosts"], hole: "body file outside workspace" },
    { argv: ["api", "--input=/etc/hosts"], hole: "inline input file outside workspace" },
    { argv: ["workflow", "run", "x", "--env-file=/abs/path"], hole: "inline env file outside workspace" },
    { argv: ["release", "create", "v1", "--notes-file=/abs/path"], hole: "inline notes file outside workspace" },
    { argv: ["pr", "create", "--template=/etc/hosts"], hole: "inline template outside workspace" },
    { argv: ["pr", "create", "-T", "/abs/path"], hole: "short template outside workspace" },
    { argv: ["pr", "create", "--web"], hole: "browser mode" },
    { argv: ["issue", "create", "--editor"], hole: "editor mode" },
    { argv: ["pr", "create", "--body-file", "../outside.md"], hole: "parent traversal" },
    { argv: ["pr", "create", "--body-file", "outside-link.md"], hole: "symlink escape" },
  ])("rejects $hole", async ({ argv }) => {
    const getAccessToken = vi.fn().mockRejectedValue(new Error("token lookup must not run for rejected arguments"));

    await expect(runGithubCli({ argv, workspaceDir, getAccessToken })).rejects.toBeInstanceOf(GithubCliPolicyError);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ["api", "-F", "key=value"],
    ["api", "-F", "key=@-"],
    ["api", "--input", "-"],
    ["pr", "create", "--body-file", "notes.md"],
    ["repo", "view", "owner/repo", "--json", "name"],
  ])("allows ordinary arguments: %s", (...argv) => {
    expect(() => validateGithubCliArguments(argv, workspaceDir)).not.toThrow();
  });

  it.each([["auth"], ["config"], ["alias"], ["extension"], ["api", "--hostname", "github.example.com"]])(
    "blocks credential and host administration: %s",
    (...argv) => {
      expect(() => validateGithubCliArguments(argv, "/workspace")).toThrow(GithubCliPolicyError);
    },
  );

  it("blocks token and header overrides", () => {
    expect(() => validateGithubCliArguments(["api", "--header", "Authorization: token x"], "/workspace")).toThrow(
      GithubCliPolicyError,
    );
    expect(() => validateGithubCliArguments(["api", "--token", "x"], "/workspace")).toThrow(GithubCliPolicyError);
  });
});

describe("GitHub authentication failure detection", () => {
  it.each([
    { exitCode: 4, stderr: "command failed", expected: true },
    { exitCode: 1, stderr: "HTTP 401: Bad credentials", expected: true },
    { exitCode: 1, stderr: "HTTP 403: Resource not accessible", expected: false },
    { exitCode: 1, stderr: "repository not found", expected: false },
    { exitCode: 0, stderr: "updated issue 401", expected: false },
  ])("classifies $stderr", ({ exitCode, stderr, expected }) => {
    expect(isGithubAuthenticationFailure({ stdout: "", stderr, exitCode })).toBe(expected);
  });
});
