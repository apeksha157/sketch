import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGithubCli } from "./github-runner";

const PASSTHROUGH_ENV_KEYS = [
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
] as const;

describe("GitHub CLI child process", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("passes only the approved environment and preserves argv", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sketch-fake-gh-"));
    tempRoots.push(tempRoot);
    const binDir = join(tempRoot, "bin");
    const workspaceDir = join(tempRoot, "workspace");
    const recordingPath = join(tempRoot, "recording.json");
    const fakeGithubPath = join(binDir, "gh");
    await mkdir(binDir);
    await mkdir(workspaceDir);
    await writeFile(
      fakeGithubPath,
      `#!/bin/sh
unset PWD SHLVL __CF_USER_TEXT_ENCODING
exec ${process.execPath} - "$@" <<'SKETCH_FAKE_GH'
const { writeFileSync } = require("node:fs");
delete process.env.SHLVL;
delete process.env.__CF_USER_TEXT_ENCODING;
writeFileSync(${JSON.stringify(recordingPath)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
SKETCH_FAKE_GH
`,
    );
    await chmod(fakeGithubPath, 0o755);

    const previousPath = process.env.PATH;
    const previousFakeSecret = process.env.FAKE_SECRET;
    process.env.PATH = binDir;
    process.env.FAKE_SECRET = "must-not-reach-gh";

    try {
      const result = await runGithubCli({
        argv: ["version", "--json", "version"],
        workspaceDir,
        getAccessToken: async () => ({ accessToken: "github-test-token" }),
      });

      expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      const recording = JSON.parse(await readFile(recordingPath, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
      };
      const expectedKeys = [
        "PATH",
        "HOME",
        "GH_CONFIG_DIR",
        "GH_TOKEN",
        "GH_NO_UPDATE_NOTIFIER",
        "GH_PROMPT_DISABLED",
        "NO_COLOR",
        ...PASSTHROUGH_ENV_KEYS.filter((key) => process.env[key]),
      ].sort();

      expect(recording.argv).toEqual(["version", "--json", "version"]);
      expect(Object.keys(recording.env).sort()).toEqual(expectedKeys);
      expect(recording.env).toMatchObject({
        PATH: binDir,
        GH_TOKEN: "github-test-token",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
      });
      expect(recording.env.HOME).toBe(recording.env.GH_CONFIG_DIR);
      expect(recording.env.FAKE_SECRET).toBeUndefined();
    } finally {
      if (previousPath === undefined) process.env.PATH = undefined;
      else process.env.PATH = previousPath;
      if (previousFakeSecret === undefined) process.env.FAKE_SECRET = undefined;
      else process.env.FAKE_SECRET = previousFakeSecret;
    }
  });
});
