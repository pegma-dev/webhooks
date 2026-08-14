# Release operations

`@pegma/webhooks` publishes only from reviewed artifacts. Merging a pull
request never publishes. A release starts from a stable GitHub release whose
tag was already created as a protected, signed annotated tag.

The exact `0.0.0` package-name bootstrap was published manually on 2026-07-29
under npm's `bootstrap` dist-tag so npm trusted publishing could be configured.
Do not repeat, move, unpublish, or reuse that version. npm also assigned
`latest` to the initial version; publishing `0.1.0` moved `latest` to the first
advertised release.

The registry records source commit
`1e36bd17289c14c75aa222c989d95b06b7875271` and integrity
`sha512-d/SvLJqd7CInzsDKLM6goI8yXh08jMBBzpHlvy3TMYyRmmbthJpkurJda3jZ2aGvrqbW/Rx3nAyxf1ZZhB20Zw==`.

## Release invariants

The release tool verifies the sole public workspace, stable package version,
exact Pegma dependency pins, matching lockfile, public metadata, package-local
README and LICENSE, prepack build, test exclusion, dist-only allowlist, and
exports. Packing builds once, checks every packed file and hash, and imports
the package from a clean consumer installation.

For a GitHub release, preparation additionally requires a stable annotated
`vX.Y.Z` tag signed by an approved signer. The tag must match the package
version, name the release-event commit, and be contained in `origin/main`.

## Required external configuration

- npm trusted publisher: `pegma-dev/webhooks`, workflow `publish.yml`,
  environment `npm-publish`, allowed action `npm publish`.
- GitHub environment: `npm-publish`; no npm secret or token.
- Repository Actions variable `RELEASE_ALLOWED_SIGNERS`: the reviewed SSH
  allowed-signers entry.
- Active `v*` tag ruleset requiring signatures and preventing updates,
  deletion, and non-fast-forward changes.

## First advertised release

**Completed 2026-07-29.** Protected signed annotated tag `v0.1.0` names
`67861144e0e36cb335f596469b631890fc9200bf`. GitHub release workflow run
`30493801499` published through trusted-publisher OIDC. The registry artifact
matches the workflow-prepared manifest exactly, carries SLSA provenance, and
has integrity
`sha512-iCz65n860Ty0bHB6RAChah27Is4dM65cpJLkn0yOFm5RbXRqYO3xwD1a3q+KzqjGZUlppUHebzN186ORNZcp+A==`.

The reviewed release-preparation pull request changes the public workspace and
lockfile to `0.1.0`, documents the release, and passes:

```sh
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
pnpm run release:check
pnpm run release:pack -- --output .release
```

After merge, create and verify the tag before creating the GitHub release:

```sh
git fetch origin
git switch --detach origin/main
git config gpg.format ssh
git config user.signingkey ~/.ssh/pegma-release-signing-key
git config gpg.ssh.allowedSignersFile ~/.ssh/pegma-release-allowed-signers
git tag --sign v0.1.0 --message "Webhooks v0.1.0" HEAD
git verify-tag v0.1.0
git push origin refs/tags/v0.1.0
gh release create v0.1.0 --verify-tag --title "@pegma/webhooks v0.1.0" --generate-notes
```

Do not let `gh release create` create the tag. Never move or recreate a release
tag; if any byte must change, prepare a new version.

## Workflow and recovery

The preparation job checks out the tag, fetches `origin/main`, configures the
reviewed signer, installs Node 24, the reviewed pnpm via Corepack, and
npm@11.18.0, runs the full gate, and uploads the exact packed artifact. Only
the environment-scoped publish job has `id-token: write`; it installs no
dependencies and does not download pnpm before publishing the prepared
artifact with provenance. Pack, registry lookup, and `npm publish` stay on
the npm CLI so trusted-publisher OIDC and pack metadata stay identical.

If a hardened release fails, rerun its failed jobs against the unchanged tag:

- absent version: publish the prepared tarball;
- existing version with identical integrity: verify and skip;
- existing version with different integrity: stop; or
- any registry error other than `E404`: stop.

After success, download the prepared artifact from the unique successful
release run and use `release:registry:check` against its
`package-manifest.json`. Require `@pegma/webhooks@0.1.0: exact`, confirm
`latest` points to `0.1.0`, and retain `bootstrap` at `0.0.0`.
