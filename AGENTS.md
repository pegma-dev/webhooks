# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Webhooks is the inbound-webhook receipt ledger of **Pegma**, a family of
MIT-licensed packages a host application composes. Shared contracts live in
`@pegma/spine`; persistence in `@pegma/storage-core`; identity and permissions
in `@pegma/authorization-core`. They publish under the `@pegma` scope, one
repository per component.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

## Hard rules

**The concurrency posture is the product.** This component is at-least-once
and overlap-tolerant: `begin` dedupes sequential redeliveries, there is no
lease, and overlapping deliveries of one event may both process. Do not add a
lock, a lease, or any wording that implies exactly-once — that false
confidence is the failure mode this component exists to prevent. Changes to
the posture are design decisions for `docs/PROJECT_PLAN.md`, not refactors.

**No payload ever touches storage.** Receipts hold event ids, types, statuses,
attempt counts, and timestamps — nothing else. Webhook payloads carry customer
data. The codec is the enforcement point; a field added to the codec is a
data-boundary decision, not a convenience.

**Counting runs inside deciders.** Attempt counts and status transitions go
through `update` deciders re-run against freshly read state; sweeps use
versioned conditional deletes. A read-then-write around the store re-creates
the races the reference implementation already fixed.

**Ordering is out of scope.** The ledger answers "have we completed this id?".
Anything answering "is this newer than what we applied?" belongs to the
consumer's domain logic. Refuse it here regardless of how convenient it looks.

**Test against the real backend.** The suite runs over `createMemoryStore()`
and against the Azure Tables adapter with real Azurite. A fake client only
proves the code agrees with its author.

**Documentation asserting a limit is load-bearing.** The README's "refuses to
promise" section and the plan's design decisions are part of the public
contract. If code and those documents disagree, the change is wrong until they
agree again.

## Reference implementation

The design is extracted from `api/src/lib/webhook-events.js` in the
RetireGolden account API (production Stripe traffic). When behaviour here is
ambiguous, that implementation and its tests are the precedent.

## Release safety

`@pegma/webhooks@0.1.0` is the first advertised release. The exact `0.0.0`
package-name bootstrap remains isolated under npm's `bootstrap` dist-tag.

Normal releases start from a protected signed annotated `vX.Y.Z` tag already
on `origin/main`, followed by a verified GitHub release. The unprivileged
preparation job runs the complete gate, checks package metadata and inventory,
packs and smoke-tests the exact artifact, and records its hashes. Only the
minimal publish job receives OIDC authority. There is no npm token or manual
workflow fallback. See `docs/RELEASING.md`.
