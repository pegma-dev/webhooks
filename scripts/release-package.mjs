import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@pegma/webhooks";
const PACKAGE_DIRECTORY = "packages/webhooks";
const PACKAGE_MANAGER = "npm@11.18.0";
const REPOSITORY_URL = "git+https://github.com/pegma-dev/webhooks.git";
const NODE_RANGE = ">=22";
const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
const REQUIRED_DEPENDENCIES = {
  "@pegma/spine": "0.1.1",
  "@pegma/storage-core": "0.4.0",
};

function fail(message) {
  throw new Error(message);
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    fail(
      `${command} ${arguments_.join(" ")} failed${options.capture ? `:\n${result.stderr}` : ""}`,
    );
  }
  return result;
}

function runNpm(arguments_, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined) {
    return run(process.execPath, [npmExecPath, ...arguments_], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, {
    ...options,
    shell: process.platform === "win32",
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function hashes(bytes) {
  return {
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

function exportTargets(exports) {
  return Object.values(exports).flatMap((entry) =>
    typeof entry === "string" ? [entry] : Object.values(entry),
  );
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const rootManifest = await readJson(join(root, "package.json"));
  const manifest = await readJson(
    join(root, PACKAGE_DIRECTORY, "package.json"),
  );
  const lock = await readJson(join(root, "package-lock.json"));
  const lockEntry = lock.packages?.[PACKAGE_DIRECTORY];
  const packageDirectories = (
    await readdir(join(root, "packages"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (
    rootManifest.name !== "webhooks" ||
    rootManifest.private !== true ||
    rootManifest.packageManager !== PACKAGE_MANAGER ||
    !sameJson(rootManifest.workspaces, ["packages/*"])
  ) {
    fail("the private root workspace metadata is invalid");
  }
  if (!sameJson(packageDirectories.sort(), ["webhooks"])) {
    fail("the public workspace inventory must contain only packages/webhooks");
  }
  if (
    manifest.name !== PACKAGE_NAME ||
    !STABLE_VERSION.test(manifest.version) ||
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.engines?.node !== NODE_RANGE ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== PACKAGE_DIRECTORY
  ) {
    fail(`${PACKAGE_DIRECTORY}/package.json has invalid public metadata`);
  }
  if (
    !sameJson(manifest.dependencies, REQUIRED_DEPENDENCIES) ||
    !sameJson(lockEntry?.dependencies, REQUIRED_DEPENDENCIES)
  ) {
    fail("Pegma runtime dependencies must match the reviewed exact pins");
  }
  if (
    lockEntry?.name !== PACKAGE_NAME ||
    lockEntry.version !== manifest.version ||
    typeof manifest.scripts?.prepack !== "string" ||
    !manifest.scripts.prepack.includes("build")
  ) {
    fail("package manifest, lockfile, or prepack metadata is inconsistent");
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((path) => !path.startsWith("dist/"))
  ) {
    fail("the package must publish only a non-empty dist allowlist");
  }
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail("every export must point into dist");
  }
  for (const filename of ["README.md", "LICENSE"]) {
    const file = await stat(join(root, PACKAGE_DIRECTORY, filename)).catch(
      () => null,
    );
    if (!file?.isFile()) {
      fail(`${PACKAGE_DIRECTORY}/${filename} is required`);
    }
  }
  const packageTsconfig = await readJson(
    join(root, PACKAGE_DIRECTORY, "tsconfig.json"),
  );
  if (!packageTsconfig.exclude?.includes("src/**/*.test.ts")) {
    fail("the package tsconfig must exclude source tests");
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined && releaseTag !== `v${manifest.version}`) {
    fail(`release tag must be v${manifest.version}`);
  }
  if (
    options.releasePrerelease === true ||
    options.releasePrerelease === "true" ||
    process.env.RELEASE_PRERELEASE === "true"
  ) {
    fail("prereleases cannot publish packages");
  }
  if (options.requireClean) {
    const status = run("git", ["status", "--porcelain"], {
      capture: true,
      cwd: root,
    }).stdout;
    if (status.trim() !== "") {
      fail("release preparation requires a clean checkout");
    }
  }
  if (options.requireMainAncestor) {
    const ancestor = run(
      "git",
      ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
      { allowFailure: true, capture: true, cwd: root },
    );
    if (ancestor.status !== 0) {
      fail("the release commit must be contained in origin/main");
    }
  }
  if (options.requireReleaseTag) {
    if (manifest.version === "0.0.0") {
      fail(
        "the 0.0.0 package-name bootstrap must not use the GitHub release workflow",
      );
    }
    validateReleaseTag(root, releaseTag, options.expectedReleaseCommit);
  }
  return { manifest, root };
}

function validateReleaseTag(root, releaseTag, expectedCommit) {
  if (releaseTag === undefined || !/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
    fail("a stable release tag is required");
  }
  if (
    expectedCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedCommit)
  ) {
    fail("an exact release-event commit is required");
  }
  const tagRef = `refs/tags/${releaseTag}`;
  if (
    run("git", ["cat-file", "-t", tagRef], {
      allowFailure: true,
      capture: true,
      cwd: root,
    }).stdout.trim() !== "tag"
  ) {
    fail("the release ref must be an annotated tag object");
  }
  const head = run("git", ["rev-parse", "HEAD"], {
    capture: true,
    cwd: root,
  }).stdout.trim();
  const tagged = run("git", ["rev-parse", `${tagRef}^{commit}`], {
    capture: true,
    cwd: root,
  }).stdout.trim();
  if (!safeEqual(head, tagged) || !safeEqual(head, expectedCommit)) {
    fail("the checkout, signed tag, and release event must name one commit");
  }
  if (
    run("git", ["verify-tag", "--raw", tagRef], {
      allowFailure: true,
      capture: true,
      cwd: root,
    }).status !== 0
  ) {
    fail("the release tag signature is not valid for an approved signer");
  }
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required)) {
      fail(`tarball is missing ${required}`);
    }
  }
  if (
    paths.some(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !path.startsWith("dist/"),
    )
  ) {
    fail("tarball contains a file outside the reviewed allowlist");
  }
  for (const target of exportTargets(manifest.exports)) {
    if (!paths.includes(target.replace(/^\.\//u, ""))) {
      fail(`tarball is missing exported file ${target}`);
    }
  }
}

async function smokeTest(tarball) {
  const directory = await mkdtemp(join(tmpdir(), "pegma-webhooks-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      { capture: true, cwd: directory },
    );
    for (const specifier of [PACKAGE_NAME]) {
      run(
        process.execPath,
        ["--input-type=module", "--eval", `await import("${specifier}")`],
        { capture: true, cwd: directory },
      );
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function prepareRelease(options = {}) {
  const { manifest, root } = await validateRepository(options);
  const output = resolve(root, options.output ?? ".release");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) {
    fail(`release output directory must be empty: ${output}`);
  }
  const packedResult = runNpm(
    [
      "pack",
      join(root, PACKAGE_DIRECTORY),
      "--json",
      "--pack-destination",
      output,
    ],
    { capture: true, cwd: root },
  );
  const [packed] = JSON.parse(packedResult.stdout);
  if (
    packed?.name !== PACKAGE_NAME ||
    packed?.version !== manifest.version ||
    typeof packed.filename !== "string" ||
    !Array.isArray(packed.files)
  ) {
    fail("npm pack returned invalid metadata");
  }
  verifyPackedFiles(manifest, packed.files);
  const tarball = join(output, basename(packed.filename));
  const digest = hashes(await readFile(tarball));
  if (
    !safeEqual(digest.integrity, packed.integrity) ||
    !safeEqual(digest.shasum, packed.shasum)
  ) {
    fail("tarball hashes do not match npm pack metadata");
  }
  await smokeTest(tarball);
  const prepared = {
    schemaVersion: 1,
    gitCommit: run("git", ["rev-parse", "HEAD"], {
      capture: true,
      cwd: root,
    }).stdout.trim(),
    releaseTag: options.releaseTag ?? process.env.RELEASE_TAG ?? null,
    package: {
      name: PACKAGE_NAME,
      version: manifest.version,
      tarball: basename(tarball),
      ...digest,
      files: packed.files
        .map(({ path, size }) => ({ path, size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
  const preparedPath = join(output, "package-manifest.json");
  await writeFile(preparedPath, `${JSON.stringify(prepared, null, 2)}\n`);
  return preparedPath;
}

function registryIntegrity(name, version) {
  const result = runNpm(
    ["view", `${name}@${version}`, "dist.integrity", "--json"],
    {
      allowFailure: true,
      capture: true,
    },
  );
  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout);
    if (typeof integrity !== "string") {
      fail("the registry returned invalid integrity metadata");
    }
    return integrity;
  }
  if (/\bE404\b/u.test(`${result.stdout}\n${result.stderr}`)) {
    return null;
  }
  fail("npm registry lookup failed");
}

function requireTrustedPublishingNpm() {
  const version = runNpm(["--version"], { capture: true }).stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (match === null) {
    fail(`could not parse npm version ${version}`);
  }
  const [, majorText, minorText, patchText] = match;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  if (
    major < 11 ||
    (major === 11 && minor < 5) ||
    (major === 11 && minor === 5 && patch < 1)
  ) {
    fail("trusted publishing requires npm 11.5.1 or newer");
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function confirmRegistryIntegrity(name, version, expected) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const actual = registryIntegrity(name, version);
    if (actual !== null && safeEqual(actual, expected)) {
      return;
    }
    if (attempt < 5) {
      wait(2 ** attempt * 1_000);
    }
  }
  fail(`${name}@${version} did not become visible with expected integrity`);
}

async function verifyPreparedArtifact(options = {}) {
  const path = resolve(
    options.manifest ?? join(".release", "package-manifest.json"),
  );
  const prepared = await readJson(path);
  const sourceManifest = await readJson(
    join(defaultRoot(), PACKAGE_DIRECTORY, "package.json"),
  );
  if (
    prepared.schemaVersion !== 1 ||
    prepared.package?.name !== PACKAGE_NAME ||
    prepared.package.version !== sourceManifest.version ||
    !STABLE_VERSION.test(prepared.package.version) ||
    !/^[0-9a-f]{40,64}$/u.test(prepared.gitCommit) ||
    !(
      prepared.releaseTag === null ||
      prepared.releaseTag === `v${prepared.package.version}`
    ) ||
    !Array.isArray(prepared.package.files)
  ) {
    fail("prepared release metadata is invalid");
  }
  const currentCommit = run("git", ["rev-parse", "HEAD"], {
    capture: true,
    cwd: defaultRoot(),
  }).stdout.trim();
  if (!safeEqual(currentCommit, prepared.gitCommit)) {
    fail("prepared release commit does not match the checkout");
  }
  verifyPackedFiles(sourceManifest, prepared.package.files);
  const expectedTarball = `pegma-webhooks-${prepared.package.version}.tgz`;
  if (prepared.package.tarball !== expectedTarball) {
    fail("prepared tarball name does not match its package version");
  }
  const tarball = resolve(dirname(path), prepared.package.tarball);
  if (dirname(tarball) !== resolve(dirname(path))) {
    fail("the prepared tarball must be beside its manifest");
  }
  const digest = hashes(await readFile(tarball));
  if (
    !safeEqual(digest.integrity, prepared.package.integrity) ||
    !safeEqual(digest.shasum, prepared.package.shasum)
  ) {
    fail("the prepared tarball has changed");
  }
  return { digest, path, prepared, tarball };
}

export async function inspectPreparedRegistry(options = {}) {
  const { digest, prepared } = await verifyPreparedArtifact(options);
  const existing = registryIntegrity(PACKAGE_NAME, prepared.package.version);
  if (existing === null) {
    process.stdout.write(
      `${PACKAGE_NAME}@${prepared.package.version}: absent\n`,
    );
    return "absent";
  }
  if (!safeEqual(existing, digest.integrity)) {
    fail("the registry version exists with different integrity");
  }
  process.stdout.write(`${PACKAGE_NAME}@${prepared.package.version}: exact\n`);
  return "exact";
}

export async function publishPrepared(options = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "release"
  ) {
    fail("release publishing is restricted to a GitHub release workflow");
  }
  requireTrustedPublishingNpm();
  const { digest, path, prepared, tarball } =
    await verifyPreparedArtifact(options);
  const expectedCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (
    prepared.releaseTag !== releaseTag ||
    releaseTag !== `v${prepared.package.version}` ||
    prepared.gitCommit !== expectedCommit ||
    prepared.package.version === "0.0.0"
  ) {
    fail("prepared release metadata does not match the release event");
  }
  const existing = registryIntegrity(PACKAGE_NAME, prepared.package.version);
  if (existing !== null) {
    if (!safeEqual(existing, digest.integrity)) {
      fail("the registry version exists with different integrity");
    }
    process.stdout.write("Registry integrity matches; skipping publish.\n");
    return;
  }
  runNpm(["publish", tarball, "--access", "public", "--provenance"], {
    cwd: dirname(path),
  });
  confirmRegistryIntegrity(
    PACKAGE_NAME,
    prepared.package.version,
    digest.integrity,
  );
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (
      argument === "--require-clean" ||
      argument === "--require-main-ancestor" ||
      argument === "--require-release-tag"
    ) {
      options[
        argument === "--require-clean"
          ? "requireClean"
          : argument === "--require-main-ancestor"
            ? "requireMainAncestor"
            : "requireReleaseTag"
      ] = true;
      continue;
    }
    const key =
      argument === "--output"
        ? "output"
        : argument === "--manifest"
          ? "manifest"
          : argument === "--expected-release-commit"
            ? "expectedReleaseCommit"
            : null;
    if (key === null || arguments_[index + 1] === undefined) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "check") {
    await validateRepository(options);
    process.stdout.write("Release metadata is valid.\n");
  } else if (command === "pack") {
    const path = await prepareRelease(options);
    process.stdout.write(`Prepared release at ${path}.\n`);
  } else if (command === "publish") {
    await publishPrepared(options);
  } else if (command === "registry-check") {
    await inspectPreparedRegistry(options);
  } else {
    fail(
      "usage: release-package.mjs <check|pack|publish|registry-check> [options]",
    );
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
