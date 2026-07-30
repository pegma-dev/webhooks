# Security Scan Report

**Repository:** webhooks (Pegma inbound-webhook receipt ledger)
**Date:** 2026-07-28
**Scope:** Repository-wide security review
**Status:** Complete — all findings dispositioned 2026-07-29 (3 resolved,
2 disputed)

---

## Summary

**No Critical or High vulnerabilities found in shipped code.** Five findings:
one Medium (F-01, vulnerable dev-only transitive dependencies), two Low
(F-02 CI detection gap, F-03 unvalidated `type` field), two Informational
(F-04 well-known emulator key, F-05 sweep memory profile). The first three are
fixed; the two Informational findings are disputed as non-findings.

The ledger's core security posture is strong: the payload data boundary is
enforced by the codec and tested, storage keys are strictly validated,
attempt counting is race-safe by construction, and CI follows least-privilege
and pinning practices. Dynamic verification: `npm test` passes 43/43
(including the payload-drop, key-rejection, and concurrent-increment tests)
against both the memory store and real Azurite.

| ID   | Severity      | Title                                                            | Disposition            |
| ---- | ------------- | ---------------------------------------------------------------- | ---------------------- |
| F-01 | Medium        | Vulnerable transitive dependencies via `azurite` (dev-only)      | ✅ Resolved 2026-07-29 |
| F-02 | Low           | No automated dependency/secret scanning in CI                    | ✅ Resolved 2026-07-29 |
| F-03 | Low           | `begin` stores `type` without runtime validation or length bound | ✅ Resolved 2026-07-29 |
| F-04 | Informational | Well-known Azure Storage emulator key in test file               | ⚠️ Disputed 2026-07-29 |
| F-05 | Informational | Retention sweep buffers entire partition                         | ⚠️ Disputed 2026-07-29 |

**Remediation round 2026-07-29:** the three actionable findings are fixed; the
two Informational findings are disputed as non-findings (see each entry).
`npm audit` now reports 0 vulnerabilities across the whole tree, and the suite
passes 45/45 against the memory store and real Azurite.

---

## Methodology

Static review of all source, test, configuration, and CI/CD files. Findings are
logged as they are discovered, with severity, evidence, exploitability, and
file references.

**Severity scale:** Critical / High / Medium / Low / Informational

---

## Findings

### F-01 — Vulnerable transitive dependencies via `azurite` (dev-only)

- **Status:** ✅ Resolved 2026-07-29 — root `overrides` raise
  `brace-expansion`, `uuid`, and `@opentelemetry/core` to patched floors,
  clearing all 12 advisories with Azurite still starting and the suite green.
- **Severity:** Medium (High advisories, dev-only exposure)
- **Evidence:** `npm audit` reports 12 vulnerabilities (5 high, 7 moderate).
  All are reachable only through the devDependency `azurite@3.36.0`:
  - `brace-expansion@1.1.16` — **High**, GHSA-mh99-v99m-4gvg: DoS via
    unbounded expansion (CWE-400/CWE-770, CVSS 7.5). Chain:
    `azurite → rimraf@3.0.2 → glob@7.2.3 → minimatch@3.1.5 → brace-expansion`.
  - `uuid@8.3.2` — **Moderate**, GHSA-w5hq-g745-h8pq: missing buffer bounds
    check in v3/v5/v6 when `buf` is provided (CWE-787, CVSS 7.5). Chain:
    `azurite → sequelize@6.37.8 / @azure/ms-rest-js@2.7.0 → uuid`.
  - `@opentelemetry/core@1.30.1` — **Moderate**, GHSA-8988-4f7v-96qf:
    unbounded memory allocation in W3C Baggage propagation (CWE-770,
    CVSS 5.3). Chain:
    `azurite → applicationinsights@2.9.8 → @opentelemetry/sdk-trace-base → @opentelemetry/core`.
- **Exploitability:** Low in practice. `azurite` is a devDependency used only
  to emulate Azure Table Storage during `npm test`; it never ships in the
  published `@pegma/webhooks` package (`files` in
  `packages/webhooks/package.json` lists only built `dist` artifacts), and it is
  not installed by consumers. Exploitation requires running the test suite
  against attacker-influenced input (e.g., a malicious glob pattern or crafted
  baggage header reaching the emulator), which is not part of the test
  harness's attack surface in normal use. The production dependency tree
  (`@pegma/spine@0.1.1`, `@pegma/storage-core@0.3.0`) audits clean.
- **File references:** `package.json` (devDependencies, line 26),
  `package-lock.json`.
- **Recommendation:** Track upstream Azurite releases; bump `azurite` when a
  release clears the `rimraf`/`sequelize`/`applicationinsights` chains.
  Consider `npm audit --omit=dev` gating for production-dependency
  regressions in CI (see F-02).
- **Resolution note:** `azurite@3.36.0` is the latest published release and
  still carries every flagged chain, so bumping it was not an option and
  `npm audit fix --force` proposes a _downgrade_ to `azurite@3.33.0`. The three
  root `overrides` in `package.json` instead raise each transitive package to
  the first patched version as a caret floor; `package-lock.json` records the
  exact resolutions, so `npm ci` stays reproducible while the floors keep
  documenting _why_ the constraint exists. Because the emulator is
  load-bearing for the suite (`AGENTS.md`:
  "Test against the real backend"), the overrides were verified empirically —
  Azurite starts and all 45 tests pass over both the memory store and real
  Azure Tables — rather than assumed safe from semver alone.

### F-02 — No automated dependency/secret scanning in CI

- **Status:** ✅ Resolved 2026-07-29 — added `.github/dependabot.yml` (npm +
  github-actions, weekly) and an `npm audit --omit=dev --audit-level=low` gate
  to `ci.yml`.
- **Severity:** Low
- **Evidence:** `.github/workflows/ci.yml` runs format, typecheck, and tests
  only. There is no `npm audit` step, no Dependabot/Renovate configuration
  (no `.github/dependabot.yml`), and no secret-scanning configuration.
- **Exploitability:** Not directly exploitable; it is a detection gap. The
  vulnerabilities in F-01 would persist unnoticed without manual audits.
- **File references:** `.github/workflows/ci.yml`.
- **Recommendation:** Add Dependabot (or equivalent) for npm and GitHub
  Actions ecosystems, and consider an `npm audit --omit=dev` CI step so
  production-dependency advisories fail the build while dev-only noise
  (F-01) does not block development.
- **Resolution note:** the gate is deliberately scoped with `--omit=dev`. A
  whole-tree gate would turn every future dev-only advisory into a red build on
  unrelated pull requests; the production tree is what reaches consumers of
  `@pegma/webhooks`. Dependabot covers the dev tree on its own cadence. GitHub
  secret scanning is a repository setting rather than a committed file, so it is
  not part of this diff (see F-04: the only secret-shaped string in the tree is
  a public emulator constant).

### F-03 — `begin(eventId, type)` stores `type` without runtime validation or a length bound

- **Status:** ✅ Resolved 2026-07-29 — `begin` now normalizes `type` at the
  boundary (truncate at 256 characters, non-string to `null`, `warn` on each
  anomaly) so a hostile value can neither fail the insert nor break round-trip
  identity.
- **Severity:** Low
- **Evidence:** `packages/webhooks/src/index.ts` line 188: `begin` validates
  `eventId` (`assertSafeEventId`) but passes `type` straight into the receipt.
  `encodeWebhookReceipt` (lines 114-123) stores it verbatim. There is no
  `typeof type === "string"` check and no length cap, unlike the strict
  key-part and timestamp validation elsewhere in the same file.
- **Exploitability:** The `type` value originates from the webhook event the
  host has already authenticated (signature verification is explicitly the
  host's responsibility per `docs/PROJECT_PLAN.md`), so this is not reachable
  by an unauthenticated attacker in a correctly integrated host. Impact if a
  hostile or buggy value does arrive:
  1. An oversized `type` exceeds the Azure Tables string-property limit
     (~32 KB), so `insertIfAbsent` throws, `begin` rejects, the host returns
     5xx, and the provider keeps retrying — the retry-storm failure mode this
     component exists to prevent.
  2. A non-string `type` (from a JS caller bypassing TypeScript) is stored
     as-is and coerced by `String(...)` on decode, so a round trip is not
     identity (`{...}` in, `"[object Object]"` out).
     The value is never used as a storage key and never logged, so there is no
     key-injection or log-injection path.
- **File references:** `packages/webhooks/src/index.ts` lines 45
  (`begin(eventId: string, type: string)`), 188-201, 114-123.
- **Recommendation:** Reject non-string and over-length `type` values at the
  `begin` boundary (e.g., a few-hundred-character cap — provider event types
  are short classification strings), mirroring the existing key/timestamp
  guards.
- **Resolution note — the fix bounds rather than rejects.** The recommendation
  above was not followed literally, because rejecting does not fix the harm this
  finding identifies. A `TypeError` from `begin` produces exactly the outcome
  described in impact 1: the host answers 5xx and the provider retries. It is
  strictly worse than the storage throw it replaces, because _no receipt is ever
  written_, so `attempts` never increments and the quarantine that exists to
  stop poison events can never engage — the event retries forever. The existing
  key and timestamp guards reject correctly because `source`, `eventId`, and the
  clock are host-supplied configuration where failing fast surfaces a programmer
  error. `type` is provider-supplied triage data (`docs/PROJECT_PLAN.md`: "the
  event type (for triage)") and never a storage key, so bounding it keeps the
  ledger able to do its one job. Truncation and a non-nullish non-string each
  log a `warn` carrying only `source` and `eventId`, so the anomaly is
  observable without widening the payload boundary; an absent type is recorded
  as `null` silently, since a provider omitting a type is not an anomaly. The 256-character cap matches `SAFE_KEY_PART`'s bound;
  real provider event types are well under 60 characters. Documented in both
  READMEs per `AGENTS.md` ("Documentation asserting a limit is load-bearing").
  Covered by "bounds the stored event type instead of failing the receipt",
  which runs against the memory store and real Azurite.

### F-04 — Well-known Azure Storage emulator key committed in test file

- **Status:** ⚠️ Disputed 2026-07-29 — not a valid finding: the string is
  Microsoft's published `devstoreaccount1` constant, identical in every Azurite
  installation and documented in public Azure docs. It is a fixture value, not a
  credential — it authenticates to nothing but a loopback-bound emulator this
  repo starts itself on an ephemeral port. There is no secret to rotate and no
  attacker-reachable resource, so no code change was made. The finding's own
  evidence concedes "Exploitability: None"; the only cost is scanner triage
  noise, which is a tooling preference rather than a security defect.
- **Severity:** Informational
- **Evidence:** `packages/webhooks/src/index.test.ts` lines 31-33 contain
  `AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==`.
  This is Microsoft's publicly documented `devstoreaccount1` key, identical
  in every Azurite/Azure Storage Emulator installation worldwide; it
  authenticates only to the local emulator bound to `127.0.0.1`.
- **Exploitability:** None — it is not a credential to any real resource.
  The only cost is noise: automated secret scanners will flag it, and an
  inattentive reader could mistake it for a leaked key. Note the file is
  excluded from the published npm package, whose `files` field lists only built
  `dist` artifacts.
- **File references:** `packages/webhooks/src/index.test.ts` lines 31-39.
- **Recommendation:** No action required for security. Optionally add a
  comment citing the Microsoft docs URL for the well-known key, and/or a
  secret-scanner allowlist entry, to silence future triage.

### F-05 — Retention sweep loads the entire partition into memory

- **Status:** ⚠️ Disputed 2026-07-29 — not a valid finding: this is a capacity
  characteristic, not a vulnerability. `purgeExpired` is host-scheduled and takes
  no attacker input; partition size is bounded by 30-day retention times a
  source's legitimate event volume, and each row is six small scalar fields
  (no payloads, per the data boundary), so a very busy source measures in
  megabytes. There is no amplification an attacker controls — flooding the
  partition requires already-authenticated webhook deliveries the host chose to
  accept. Paginating would mean adding continuation-token support to the
  `@pegma/storage-core` contract, a cross-repo design change that
  `AGENTS.md` routes through `docs/PROJECT_PLAN.md`; doing it here under a
  security banner would be unjustified scope. The finding's own evidence
  concedes "Not attacker-reachable" and its recommendation is "Acceptable as-is
  for the stated scale."
- **Severity:** Informational
- **Evidence:** `purgeExpired` (lines 254-283) calls
  `receipts.listVersioned(source)` and iterates the full result set. A
  partition's size is naturally bounded by 30-day retention and per-source
  event volume, but a high-volume source produces a large single allocation
  per sweep.
- **Exploitability:** Not attacker-reachable; sweep cadence and source volume
  are host-operational concerns. Worst case is memory pressure in the sweeper
  process.
- **File references:** `packages/webhooks/src/index.ts` lines 254-283.
- **Recommendation:** Acceptable as-is for the stated scale. If a future
  high-volume source appears, paginate the listing (continuation tokens)
  rather than buffering the partition.

## Verified strengths (no action needed)

These were specifically probed and found sound:

1. **Payload data boundary.** `encodeWebhookReceipt` writes exactly the six
   receipt fields; a cast-in `payload` field is dropped (test:
   "encodes exactly the six receipt fields and drops cast-in payload data").
   Log statements carry only `source`, `eventId`, `attempts`, `purged` — the
   suite asserts serialized logs contain no payload.
2. **Storage-key injection resistance.** `source` and `eventId` are
   constrained to `^[A-Za-z0-9|_.:@-]{1,256}$` at every public boundary
   (`createWebhookLedger`, `webhookReceiptCollection`, `webhookReceiptKey`,
   `begin`, `markProcessed`, `markFailed`), blocking Azure Tables
   partition/row-key metacharacters (`/`, `\`, `#`, `?`) and control
   characters. The retention sweep re-validates listed event ids before
   issuing deletes and skips corrupt rows. The regex is a bounded character
   class — no ReDoS surface.
3. **Race-safe attempt counting.** `markFailed` increments inside the
   store's `update` decider (re-run against freshly read state under
   optimistic concurrency), not read-then-write; the suite proves concurrent
   failures record distinct attempt numbers and log the quarantine
   transition exactly once.
4. **Race-safe retention.** The sweep uses `listVersioned` +
   `deleteIfUnchanged` (versioned conditional delete); a receipt touched
   after enumeration survives (tested).
5. **Timestamp validation.** Clock and sweep timestamps must round-trip
   through `Date.toISOString()` exactly; invalid values are rejected before
   any storage access (tested with a counting store). The canonical-timestamp
   regex has no nested quantifiers (no ReDoS).
6. **CI hygiene.** `permissions: contents: read` (least privilege), actions
   pinned by full-length SHA, no `pull_request_target`, no secrets used, no
   interpolated user-controlled input in `run` steps, `npm ci` verifies
   lockfile integrity hashes.
7. **Lockfile integrity.** `lockfileVersion: 3`; all 413 remote packages
   carry `resolved` + `integrity` fields (only the workspace root link lacks
   one, as expected).
8. **No dangerous sinks.** No `eval`, `Function()` constructor, `JSON.parse`
   on external input, prototype-pollution patterns, or shell-string process
   spawns in shipped code. `test/azurite.ts` spawns Azurite via argv array
   (no shell) with a fixed path and binds the emulator to `127.0.0.1` only.
9. **Error paths.** Storage failures propagate to the caller (tested); no
   swallowed exceptions, no fallback-to-insecure behavior.
10. **Docs/code contract.** README and `docs/PROJECT_PLAN.md` claims match
    the code: at-least-once posture (no lease/lock anywhere), quarantine at
    the 6th failure, 30-day retention, six-field receipt, key regex.

---

## Files reviewed

- `AGENTS.md`, `README.md`, `LICENSE`
- `docs/PROJECT_PLAN.md`
- `package.json`, `package-lock.json` (lockfile v3, 414 entries)
- `packages/webhooks/package.json`, `packages/webhooks/README.md`,
  `packages/webhooks/LICENSE`
- `packages/webhooks/src/index.ts` (core ledger — full line-by-line review)
- `packages/webhooks/src/index.test.ts` (902-line conformance suite)
- `test/azurite.ts` (test emulator lifecycle)
- `vitest.config.ts`, `tsconfig.json`, `tsconfig.base.json`,
  `tsconfig.test.json`, `packages/webhooks/tsconfig.json`
- `.github/workflows/ci.yml`, `.gitignore`, `.gitattributes`
- Git history (10 commits) scanned for committed secrets — none found

**Dynamic verification performed:** `npm ci` (clean install), `npm test`
(43/43 passing, memory store + real Azurite), `npm audit` (see F-01).

**Scan completed:** 2026-07-28.

**Remediation completed:** 2026-07-29. Each finding was re-derived from the code
before acting. F-01, F-02, and F-03 were fixed; F-04 and F-05 were disputed as
non-findings with reasoning recorded on each entry. Post-fix verification:
`npm run format:check`, `npm run check`, `npm test` (45/45 over the memory store
and real Azurite), `npm audit` (0 vulnerabilities), `npm run release:check`.
