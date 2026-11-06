import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

const { prepareRelease, publishPrepared } =
  await import("./release-package.mjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "packages/webhooks/package.json"), "utf8"),
);
const PACKAGE_VERSION = PACKAGE_MANIFEST.version;
const TARBALL_NAME = `pegma-webhooks-${PACKAGE_VERSION}.tgz`;
const RELEASE_TAG = `v${PACKAGE_VERSION}`;
const COMMIT = "a".repeat(40);
const NPM_REGISTRY = "https://registry.npmjs.org/";
const PACKED_FILES = [
  { path: "LICENSE", size: 1 },
  { path: "README.md", size: 1 },
  { path: "dist/index.d.ts", size: 1 },
  { path: "dist/index.js", size: 1 },
  { path: "package.json", size: 1 },
];
const INVENTORY_CASES = [
  { label: "a hidden config file", kind: "file", name: ".npmrc" },
  { label: "package metadata", kind: "file", name: "package.json" },
  { label: "an extra regular file", kind: "file", name: "notes.txt" },
  { label: "a subdirectory", kind: "directory", name: "nested" },
  { label: "a linked entry", kind: "link", name: "linked-entry" },
];

const temporaryDirectories = [];

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "webhooks-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function hashes(bytes) {
  return {
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

function processResult({ status = 0, stdout = "", stderr = "" } = {}) {
  return { status, stdout, stderr };
}

function isNpmCommand(command) {
  return /(^|[\\/])npm(?:\.cmd)?$/iu.test(String(command));
}

function addInventoryEntry(directory, fixtureRoot, fixture) {
  const path = join(directory, fixture.name);
  if (fixture.kind === "file") {
    writeFileSync(path, "extra\n");
    return;
  }
  if (fixture.kind === "directory") {
    mkdirSync(path);
    return;
  }
  const target = join(fixtureRoot, `target-${fixture.name}`);
  mkdirSync(target);
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function writePreparedArtifact(directory) {
  mkdirSync(directory, { recursive: true });
  const tarball = join(directory, TARBALL_NAME);
  const bytes = Buffer.from("prepared release tarball\n");
  const digest = hashes(bytes);
  writeFileSync(tarball, bytes);
  const manifest = join(directory, "package-manifest.json");
  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gitCommit: COMMIT,
        releaseTag: RELEASE_TAG,
        package: {
          name: "@pegma/webhooks",
          version: PACKAGE_VERSION,
          tarball: TARBALL_NAME,
          ...digest,
          files: PACKED_FILES,
        },
      },
      null,
      2,
    )}\n`,
  );
  return { digest, manifest, tarball };
}

function useReleaseEnvironment() {
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_EVENT_NAME", "release");
  vi.stubEnv("RELEASE_COMMIT", COMMIT);
  vi.stubEnv("RELEASE_TAG", RELEASE_TAG);
}

function installPrepareProcessDouble(output, addEntry) {
  let smokeInstallRan = false;
  spawnSyncMock.mockImplementation((command, arguments_) => {
    if (isNpmCommand(command) && arguments_[0] === "pack") {
      const destination =
        arguments_[arguments_.indexOf("--pack-destination") + 1];
      expect(resolve(destination)).toBe(resolve(output));
      const bytes = Buffer.from("packed release tarball\n");
      const digest = hashes(bytes);
      writeFileSync(join(output, TARBALL_NAME), bytes);
      return processResult({
        stdout: JSON.stringify([
          {
            name: "@pegma/webhooks",
            version: PACKAGE_VERSION,
            filename: TARBALL_NAME,
            files: PACKED_FILES,
            ...digest,
          },
        ]),
      });
    }
    if (isNpmCommand(command) && arguments_[0] === "install") {
      smokeInstallRan = true;
      addEntry();
      return processResult();
    }
    if (
      command === process.execPath &&
      arguments_[0] === "--input-type=module"
    ) {
      return processResult();
    }
    if (
      command === "git" &&
      arguments_[0] === "rev-parse" &&
      arguments_[1] === "HEAD"
    ) {
      return processResult({ stdout: `${COMMIT}\n` });
    }
    throw new Error(
      `unexpected process call: ${command} ${arguments_.join(" ")}`,
    );
  });
  return () => smokeInstallRan;
}

beforeEach(() => {
  spawnSyncMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("release artifact inventory", () => {
  for (const fixture of INVENTORY_CASES) {
    it(`rejects ${fixture.label} after preparation`, async () => {
      const fixtureRoot = makeTemporaryDirectory();
      const output = join(fixtureRoot, "artifact");
      const smokeInstallRan = installPrepareProcessDouble(output, () => {
        addInventoryEntry(output, fixtureRoot, fixture);
      });

      await expect(prepareRelease({ root: ROOT, output })).rejects.toThrow(
        /must contain only regular files/u,
      );

      expect(smokeInstallRan()).toBe(true);
      expect(existsSync(join(output, "package-manifest.json"))).toBe(true);
    });

    it(`rejects ${fixture.label} before publishing`, async () => {
      useReleaseEnvironment();
      const fixtureRoot = makeTemporaryDirectory();
      const artifact = join(fixtureRoot, "artifact");
      const { manifest } = writePreparedArtifact(artifact);
      addInventoryEntry(artifact, fixtureRoot, fixture);

      await expect(
        publishPrepared({
          expectedReleaseCommit: COMMIT,
          manifest,
          releaseTag: RELEASE_TAG,
        }),
      ).rejects.toThrow(/must contain only regular files/u);

      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  }
});

describe("prepared publishing", () => {
  it("uses a clean working directory and controlled npm configuration", async () => {
    useReleaseEnvironment();
    vi.stubEnv("npm_config_registry", "https://registry.example.invalid/");
    vi.stubEnv("NPM_CONFIG_CACHE", join(makeTemporaryDirectory(), "cache"));
    const fixtureRoot = makeTemporaryDirectory();
    const artifact = join(fixtureRoot, "artifact");
    const { digest, manifest, tarball } = writePreparedArtifact(artifact);
    let registryLookupCount = 0;
    let publishCall;

    spawnSyncMock.mockImplementation((command, arguments_, options) => {
      if (
        command === "git" &&
        arguments_[0] === "rev-parse" &&
        arguments_[1] === "HEAD"
      ) {
        return processResult({ stdout: `${COMMIT}\n` });
      }
      if (isNpmCommand(command) && arguments_[0] === "--version") {
        return processResult({ stdout: "11.18.0\n" });
      }
      if (isNpmCommand(command) && arguments_[0] === "view") {
        registryLookupCount += 1;
        if (registryLookupCount === 1) {
          return processResult({ status: 1, stderr: "E404\n" });
        }
        return processResult({
          stdout: `${JSON.stringify(digest.integrity)}\n`,
        });
      }
      if (isNpmCommand(command) && arguments_[0] === "publish") {
        const npmConfigKeys = Object.keys(options.env)
          .filter((name) => /^npm_config_/iu.test(name))
          .sort();
        publishCall = {
          arguments: [...arguments_],
          cwd: options.cwd,
          cwdEntries: readdirSync(options.cwd),
          globalconfig: options.env.NPM_CONFIG_GLOBALCONFIG,
          globalconfigContents: readFileSync(
            options.env.NPM_CONFIG_GLOBALCONFIG,
            "utf8",
          ),
          npmConfigKeys,
          userconfig: options.env.NPM_CONFIG_USERCONFIG,
          userconfigContents: readFileSync(
            options.env.NPM_CONFIG_USERCONFIG,
            "utf8",
          ),
        };
        return processResult();
      }
      throw new Error(
        `unexpected process call: ${command} ${arguments_.join(" ")}`,
      );
    });

    await publishPrepared({
      expectedReleaseCommit: COMMIT,
      manifest,
      releaseTag: RELEASE_TAG,
    });

    expect(publishCall).toBeDefined();
    expect(publishCall.arguments).toEqual([
      "publish",
      resolve(tarball),
      "--access",
      "public",
      "--provenance",
      "--ignore-scripts",
      "--registry",
      NPM_REGISTRY,
    ]);
    expect(publishCall.cwdEntries).toEqual([]);
    expect(resolve(publishCall.cwd)).not.toBe(resolve(artifact));
    expect(
      resolve(publishCall.cwd).startsWith(`${resolve(artifact)}${sep}`),
    ).toBe(false);
    expect(publishCall.npmConfigKeys).toEqual([
      "NPM_CONFIG_GLOBALCONFIG",
      "NPM_CONFIG_USERCONFIG",
    ]);
    expect(publishCall.userconfigContents).toBe("");
    expect(publishCall.globalconfigContents).toBe("");
    expect(dirname(publishCall.userconfig)).toBe(dirname(publishCall.cwd));
    expect(dirname(publishCall.globalconfig)).toBe(dirname(publishCall.cwd));
    expect(publishCall.userconfig).not.toBe(publishCall.globalconfig);
    expect(registryLookupCount).toBe(2);
  });
});

describe("release workflow invariants", () => {
  const publishWorkflow = readFileSync(
    join(ROOT, ".github/workflows/publish.yml"),
    "utf8",
  );
  const ciWorkflow = readFileSync(
    join(ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );

  it("uploads only the named manifest and tarball", () => {
    const uploadStep = publishWorkflow.match(
      /- name: Upload the prepared release[\s\S]*?retention-days: 30/u,
    )?.[0];
    expect(uploadStep).toBeDefined();
    const uploadPaths = uploadStep
      .match(/path: \|\r?\n((?:\s{12}.+\r?\n){2})/u)?.[1]
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim());
    expect(uploadPaths).toEqual([
      ".release/package-manifest.json",
      "${{ steps.prepare-release.outputs.tarball }}",
    ]);
    expect(uploadStep).not.toContain("include-hidden-files");
  });

  it("uses the release commit and an external artifact directory", () => {
    const publishJob = publishWorkflow.slice(
      publishWorkflow.indexOf("  publish:"),
    );
    expect(publishJob).toContain("ref: ${{ github.sha }}");
    expect(publishJob).toContain("persist-credentials: false");
    expect(publishJob).toContain(
      "path: ${{ runner.temp }}/webhooks-release-${{ github.run_id }}",
    );
    expect(publishJob).toContain(
      "working-directory: ${{ steps.publisher-directory.outputs.path }}",
    );
    expect(publishJob).toContain(
      'node "${GITHUB_WORKSPACE}/scripts/release-package.mjs" publish',
    );
  });

  it("runs the release metadata check in CI", () => {
    expect(ciWorkflow).toContain("run: pnpm run release:check");
  });
});
