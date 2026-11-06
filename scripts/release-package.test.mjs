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

const { prepareRelease, publishPrepared, validateRepository } =
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
const REVIEWED_DEPENDENCIES = {
  "@pegma/spine": "0.1.2",
  "@pegma/storage-core": "0.4.0",
};
const PUBLISH_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "CI",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_SERVER_URL",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_REF",
  "RUNNER_ENVIRONMENT",
  ...(process.platform === "win32" ? ["SystemRoot", "ComSpec"] : []),
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_USERCONFIG",
];
const PROVENANCE_ENVIRONMENT = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example.test/id-token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "workflow-token",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "release",
  GITHUB_REF: "refs/tags/v0.1.1",
  GITHUB_REPOSITORY: "pegma-dev/webhooks",
  GITHUB_REPOSITORY_ID: "1234",
  GITHUB_REPOSITORY_OWNER_ID: "5678",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "9012",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_SHA: COMMIT,
  GITHUB_WORKFLOW_REF:
    "pegma-dev/webhooks/.github/workflows/publish.yml@refs/tags/v0.1.1",
  RUNNER_ENVIRONMENT: "github-hosted",
};
const DISCARDED_ENVIRONMENT = {
  ALL_PROXY: "http://proxy.example.test",
  HTTP_PROXY: "http://proxy.example.test",
  HTTPS_PROXY: "http://proxy.example.test",
  NODE_EXTRA_CA_CERTS: "C:/untrusted/ca.pem",
  NODE_OPTIONS: "--require=C:/untrusted/setup.cjs",
  NO_PROXY: "registry.example.test",
  NPM_CONFIG_CACHE: "C:/untrusted/cache",
  NPM_TOKEN: "ambient-token",
  npm_config_registry: "https://registry.example.invalid/",
  UNRELATED_RELEASE_VALUE: "discarded",
};
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

function workflowStep(workflow, name) {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) {
    throw new Error(`workflow step not found: ${name}`);
  }
  const stepIndent = /^\s*/u.exec(lines[start])[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== "" && /^\s*/u.exec(line)[0].length <= stepIndent) {
      break;
    }
    end += 1;
  }
  return lines.slice(start, end);
}

function blockScalarValues(step, key) {
  const start = step.findIndex((line) => line.trim() === `${key}: |`);
  if (start === -1) {
    throw new Error(`workflow block not found: ${key}`);
  }
  const keyIndent = /^\s*/u.exec(step[start])[0].length;
  const values = [];
  for (const line of step.slice(start + 1)) {
    if (line.trim() === "") {
      continue;
    }
    if (/^\s*/u.exec(line)[0].length <= keyIndent) {
      break;
    }
    values.push(line.trim());
  }
  return values;
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

function writePreparedArtifact(
  directory,
  { manifestName = "package-manifest.json" } = {},
) {
  mkdirSync(directory, { recursive: true });
  const tarball = join(directory, TARBALL_NAME);
  const bytes = Buffer.from("prepared release tarball\n");
  const digest = hashes(bytes);
  writeFileSync(tarball, bytes);
  const manifest = join(directory, manifestName);
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

function lockDependenciesFromPins(pins) {
  return Object.fromEntries(
    Object.entries(pins).map(([name, pin]) => [
      name,
      { specifier: pin, version: pin },
    ]),
  );
}

function writeRepositoryFixture({
  manifestDependencies = REVIEWED_DEPENDENCIES,
  lockDependencies = lockDependenciesFromPins(manifestDependencies),
} = {}) {
  const fixtureRoot = makeTemporaryDirectory();
  const packageRoot = join(fixtureRoot, "packages/webhooks");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(fixtureRoot, "package.json"),
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  writeFileSync(
    join(fixtureRoot, "pnpm-workspace.yaml"),
    readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8"),
  );
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      { ...PACKAGE_MANIFEST, dependencies: manifestDependencies },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(packageRoot, "README.md"), "# Fixture\n");
  writeFileSync(join(packageRoot, "LICENSE"), "MIT\n");
  writeFileSync(
    join(packageRoot, "tsconfig.json"),
    '{"exclude":["src/**/*.test.ts"]}\n',
  );
  const lockEntries = Object.entries(lockDependencies)
    .map(
      ([name, { specifier, version }]) =>
        `      '${name}':\n        specifier: ${specifier}\n        version: ${version}`,
    )
    .join("\n");
  writeFileSync(
    join(fixtureRoot, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\n\nimporters:\n\n  packages/webhooks:\n    dependencies:\n${lockEntries}\n`,
  );
  return fixtureRoot;
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

describe("release dependency pins", () => {
  it("rejects matching package and lock pins outside the reviewed set", async () => {
    const dependencies = {
      ...REVIEWED_DEPENDENCIES,
      "@pegma/spine": "0.1.3",
    };
    const root = writeRepositoryFixture({
      manifestDependencies: dependencies,
      lockDependencies: lockDependenciesFromPins(dependencies),
    });

    await expect(validateRepository({ root })).rejects.toThrow(
      /must match the reviewed exact pins/u,
    );
  });

  it("rejects a lock pin that differs from the reviewed set", async () => {
    const lockDependencies = lockDependenciesFromPins(REVIEWED_DEPENDENCIES);
    lockDependencies["@pegma/spine"] = {
      specifier: "0.1.3",
      version: "0.1.3",
    };
    const root = writeRepositoryFixture({ lockDependencies });

    await expect(validateRepository({ root })).rejects.toThrow(
      /must match the reviewed exact pins/u,
    );
  });

  it("rejects a non-exact package pin", async () => {
    const dependencies = {
      ...REVIEWED_DEPENDENCIES,
      "@pegma/spine": "^0.1.2",
    };
    const lockDependencies = lockDependenciesFromPins(REVIEWED_DEPENDENCIES);
    lockDependencies["@pegma/spine"] = {
      specifier: "^0.1.2",
      version: "0.1.2",
    };
    const root = writeRepositoryFixture({
      manifestDependencies: dependencies,
      lockDependencies,
    });

    await expect(validateRepository({ root })).rejects.toThrow(
      /must match the reviewed exact pins/u,
    );
  });
});

describe("release preparation", () => {
  it("rejects a non-empty output directory before packing", async () => {
    const fixtureRoot = makeTemporaryDirectory();
    const output = join(fixtureRoot, "artifact");
    mkdirSync(output);
    writeFileSync(join(output, "notes.txt"), "existing\n");

    await expect(prepareRelease({ root: ROOT, output })).rejects.toThrow(
      /release output directory must be empty/u,
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
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
        /expected regular files .* found/u,
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
      ).rejects.toThrow(/expected regular files .* found/u);

      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  }
});

describe("prepared publishing", () => {
  it("requires the canonical prepared manifest name", async () => {
    useReleaseEnvironment();
    const fixtureRoot = makeTemporaryDirectory();
    const artifact = join(fixtureRoot, "artifact");
    const { manifest } = writePreparedArtifact(artifact, {
      manifestName: "prepared.json",
    });

    await expect(
      publishPrepared({
        expectedReleaseCommit: COMMIT,
        manifest,
        releaseTag: RELEASE_TAG,
      }),
    ).rejects.toThrow(
      /prepared manifest must be named package-manifest\.json/u,
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("uses a clean working directory and controlled npm configuration", async () => {
    useReleaseEnvironment();
    for (const [name, value] of Object.entries(PROVENANCE_ENVIRONMENT)) {
      vi.stubEnv(name, value);
    }
    for (const [name, value] of Object.entries(DISCARDED_ENVIRONMENT)) {
      vi.stubEnv(name, value);
    }
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
          environment: { ...options.env },
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
    expect(
      Object.keys(publishCall.environment).filter(
        (name) => !PUBLISH_ENVIRONMENT_NAMES.includes(name),
      ),
    ).toEqual([]);
    for (const [name, value] of Object.entries(PROVENANCE_ENVIRONMENT)) {
      expect(publishCall.environment[name]).toBe(value);
    }
    for (const name of Object.keys(DISCARDED_ENVIRONMENT)) {
      expect(publishCall.environment).not.toHaveProperty(name);
    }
    expect(publishCall.environment).not.toHaveProperty("RELEASE_COMMIT");
    expect(publishCall.environment).not.toHaveProperty("RELEASE_TAG");
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
    const uploadStep = workflowStep(
      publishWorkflow,
      "Upload the prepared release",
    );
    expect(blockScalarValues(uploadStep, "path")).toEqual([
      ".release/package-manifest.json",
      "${{ steps.prepare-release.outputs.tarball }}",
    ]);
    expect(uploadStep.join("\n")).not.toContain("include-hidden-files");
  });

  it("uses the release commit and an external artifact directory", () => {
    const checkoutStep = workflowStep(
      publishWorkflow,
      "Check out the release commit",
    );
    expect(checkoutStep.join("\n")).toContain("ref: ${{ github.sha }}");
    expect(checkoutStep.join("\n")).toContain("persist-credentials: false");

    const downloadStep = workflowStep(
      publishWorkflow,
      "Download the prepared release",
    );
    expect(downloadStep.join("\n")).toContain(
      "path: ${{ runner.temp }}/webhooks-release-${{ github.run_id }}",
    );

    const invocationStep = workflowStep(
      publishWorkflow,
      "Create a clean Node invocation directory",
    );
    expect(invocationStep.join("\n")).toContain(
      "id: node-invocation-directory",
    );

    const publishStep = workflowStep(
      publishWorkflow,
      "Publish the verified prepared tarball",
    );
    expect(publishStep.join("\n")).toContain(
      "working-directory: ${{ steps.node-invocation-directory.outputs.path }}",
    );
    expect(publishStep.join("\n")).toContain(
      'node "${GITHUB_WORKSPACE}/scripts/release-package.mjs" publish',
    );
  });

  it("uses string CI flags and one registry URL", () => {
    const setupStep = workflowStep(publishWorkflow, "Set up Node.js");
    expect(setupStep.join("\n")).toContain(`registry-url: ${NPM_REGISTRY}`);
    expect(ciWorkflow).toContain('CI: "1"');
    expect(publishWorkflow).toContain('CI: "1"');
  });

  it("runs the release metadata check in CI", () => {
    const releaseCheckStep = workflowStep(ciWorkflow, "Check release metadata");
    expect(releaseCheckStep.join("\n")).toContain(
      "run: pnpm run release:check",
    );
  });
});
