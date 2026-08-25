import { describe, expect, it } from "vitest";
import { GithubCliPolicyError, isGithubAuthenticationFailure, validateGithubCliArguments } from "./github-runner";

describe("GitHub CLI runner policy", () => {
  it("allows ordinary GitHub commands and help", () => {
    expect(() => validateGithubCliArguments(["pr", "list", "--repo", "owner/repo", "-h"], "/workspace")).not.toThrow();
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

  it("blocks file inputs outside the workspace", () => {
    expect(() => validateGithubCliArguments(["issue", "create", "--body-file", "../../secret"], "/workspace")).toThrow(
      GithubCliPolicyError,
    );
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
