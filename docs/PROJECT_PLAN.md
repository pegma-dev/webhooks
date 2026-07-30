# Webhooks Project Plan

## Status

**Stage:** Phases 1 through 4 are complete. `@pegma/webhooks@0.1.1` is
published from the protected signed `v0.1.1` release through npm
trusted-publisher OIDC with provenance (`0.x`, public API unstable)

**Initial reference application:** RetireGolden, whose account API supplied the
production-tested implementation this component was extracted from
(`api/src/lib/webhook-events.js` — a Stripe event ledger hardened by real
webhook traffic and a test suite covering the concurrency corners). Its Phase 2
migration now replaces that local module with `@pegma/webhooks`.

**License:** MIT

**Naming and origin:** "Webhooks" here means **inbound** webhook receipt
handling. Outbound delivery — a host calling someone else's webhook — is a
durable-outbox problem and belongs to `@pegma/storage-core`'s durable-events
tier, per `@pegma/spine`'s two-tier event rule. The git history begins at this
extraction; nothing was ever published under another name.

**Storage:** `@pegma/webhooks` declares one collection over an injected
`@pegma/storage-core` `Store`, and takes time from a `@pegma/spine` `Clock`.
Both dependencies are pinned exactly.

## Vision

Every integration a host application has — payments, email, calendars, CI,
signatures — notifies it by webhook, and every provider that matters delivers
those webhooks **at least once**, with retries, out of order, and occasionally
twice at the same moment. Nearly every hand-rolled receiver in the wild is
subtly wrong about replay, double delivery, or poison events, and the failure
modes are quiet: a subscription applied twice, a retry storm that gets the
endpoint auto-disabled, a permanently failing event redelivered for three
days.

One receipt ledger, with one honestly documented concurrency posture, that
every Pegma component and host handles inbound webhooks through — so "did we
already process this?" has the same answer, with the same limits, everywhere.

The pain-relief-per-line here is the highest in the ecosystem's backlog: the
port is four methods, the semantics are the hard-won part, and the reference
implementation already paid for them in production.

## Problem statement

A webhook receiver that simply processes what arrives has three problems it
usually discovers in production:

1. **Double delivery.** Providers retry until acknowledged, and a slow
   response counts as no response. Processing must be deduplicated by the
   provider's event id or side effects happen twice.
2. **Poison events.** An event that always fails is redelivered on the
   provider's schedule (Stripe: ~3 days). Answering 500 every time risks the
   provider auto-disabling the endpoint — which takes down _every_ webhook,
   not just the poisoned one. At some point the receiver must give up,
   acknowledge, and preserve the failure somewhere a human will find it.
3. **False confidence.** The tempting fixes overpromise. A dedup check before
   processing is not exactly-once (the process can die mid-way). A receipt
   ledger is not an ordering guarantee (a later event can be processed before
   an earlier one that is mid-retry). Implementations that blur these lines
   fail rarely and confusingly rather than often and clearly.

The reference implementation solved all three with `@pegma/storage-core`
primitives: `insertIfAbsent` as the deduplication point, an `update` decider
for crash-safe attempt counting, and a versioned conditional sweep for
retention. What it got most right, though, is the documentation of what it
does **not** do — and that documentation is as much of the extraction as the
code.

## Core model

### Receipt

One record per provider event, keyed by the provider's own event id. It holds
the event id, the event type (for triage), a status, an attempt count, and
first/last-seen timestamps. Statuses:

- `new` — recorded, processing may proceed (or is in flight).
- `processed` — completed; a redelivery short-circuits to an acknowledgement.
- `quarantined` — failed past the threshold; acknowledged to stop the retry
  storm; the row is the durable, alert-worthy signal for manual triage.

### Source

A host has more than one webhook provider. Receipts are partitioned by a
host-chosen source name (`stripe`, `postmark`, `github`), so ids cannot
collide across providers, listing and sweeping stay per-source, and one
ledger serves every integration. The reference implementation is
single-source; this is the one deliberate generalization the extraction
makes, and Phase 3 exists to test it against a second real source.

### The port

Four methods, unchanged in spirit from the reference implementation:

- `begin(eventId, type)` — record or look up a receipt before processing.
  Returns the status: `new` means process, anything else means acknowledge
  without processing.
- `markProcessed(eventId)` — record success so redeliveries short-circuit.
- `markFailed(eventId)` — count a failure; reports whether this crossing of
  the threshold quarantined the event (the caller then acknowledges instead
  of failing).
- `purgeExpired(now?)` — sweep receipts past the retention window.

### The data boundary

A receipt never stores a payload fragment. Webhook payloads carry customer
data; deduplication needs only the id. The codec is the boundary — nothing
outside the fields above is ever persisted. This is a hard rule, not a
default.

## Design decisions

### At-least-once, overlap-tolerant — and proud of it

`begin` deduplicates **sequential redeliveries** (the provider retry model:
a failed delivery is re-sent after the prior attempt returned), not
**overlapping deliveries**. There is no lease and no lock; two in-flight
deliveries of one event can both see `new` and both process. This is a
feature being kept, not a limitation being tolerated: a lease would trade a
simple, honest at-least-once contract for a fragile exactly-once impression
that a crashed holder or a clock skew quietly breaks. The contract is that
**each side effect behind the webhook owns its own idempotency** (the
reference application's ledger writes are ordered by domain watermarks,
consents are first-wins, and so on). The component's documentation states
this on the front page, because the most dangerous thing a webhook component
can do is let its adopter believe otherwise.

### Ordering is someone else's job

The ledger answers "have we completed this event id?" — never "is this event
newer than what we have applied?". Ordering arbitration (watermarks,
same-second tie-breaking, snapshot freshness) is domain logic that belongs to
the consumer, and in the ecosystem's future, to a billing component. Bundling
it here would couple every webhook consumer to billing semantics.

### Quarantine, then acknowledge

After a bounded number of failures (default 5 — low enough that a stuck
event surfaces within a day of a provider's retry cadence), the receipt flips
to `quarantined` and the caller acknowledges. The quarantined row is not a
dead letter to be replayed automatically; it is a signal for a human. Attempt
counting runs through an `update` decider, so two concurrent failures cannot
both record attempt _n + 1_ and defer quarantine.

### Signature verification stays with the host

The component takes events the host has already authenticated. Provider SDKs
verify signatures well (`stripe.webhooks.constructEvent` and its peers), the
schemes are provider-specific, and doing it half-well in a shared package
would be worse than not doing it. This mirrors Authorization Core's posture:
provider authenticity is established outside the component, which then
operates on trusted facts. Verifier adapters are an open question, with the
lean answer being no (see Open questions).

### Retention deletes conditionally

Receipts are swept after a retention window (default 30 days) that must
comfortably outlive the provider's redelivery horizon, or dedup silently
stops covering real retries. The sweep is versioned — `listVersioned` plus
`deleteIfUnchanged` — so a receipt touched after enumeration (a concurrent
redelivery) survives rather than being deleted mid-flight.

### Time and logging are injected

The reference implementation calls `new Date()` inline; the component takes a
`@pegma/spine` `Clock` so retention and timestamps are testable without
patching globals, and reports notable transitions (quarantine, sweep counts)
through the spine `Logger` port rather than a console.

## Scope

### In scope

- The receipt ledger: dedup, attempt counting, quarantine, retention.
- Multi-source partitioning within one host.
- Conformance-style tests over `createMemoryStore()`, and the same suite run
  against the Azure Tables adapter (real Azurite, per ecosystem rule).
- Documentation of the concurrency posture as a first-class deliverable.

### Non-goals

- **Exactly-once delivery.** Does not exist; will not be pretended.
- **Ordering guarantees.** Domain logic, deliberately excluded (above).
- **Outbound webhooks.** Sending is a durable-outbox-and-dispatcher problem
  (`@pegma/spine`'s durable-events tier, owned by storage).
- **Payload storage, archival, or replay tooling.** The ledger stores no
  payloads, so it cannot replay them; a host wanting replay keeps payloads on
  its own terms.
- **Signature verification** (v1; open question below).
- **Provider SDK wrapping, endpoint routing, HTTP framework bindings.** The
  host owns its HTTP surface; this component is called from inside it.

## Package architecture

One package: `packages/webhooks` publishing `@pegma/webhooks`. Dependencies:
`@pegma/spine` (Clock, Logger, IsoTimestamp) and `@pegma/storage-core`
(collection definition, injected Store), both pinned exactly. TypeScript,
vitest, the ecosystem's standard repo layout. No second package until
something forces one — verifier adapters are the only candidate, and they are
an open question.

The collection is named `webhookReceipts` ("receipts", not "events": the
records are proof of handling, not the events themselves — and the ecosystem
already uses "events" for two other things). Consequence for the reference
application: its rows live under the old `webhookEvents` collection name
today, and the swap strands them, exactly like the storage migration's key
layout changes. Acceptable for the same reason it was then — the ledger is
disposable idempotency data with a 30-day horizon — and worth stating so the
swap is done knowingly.

## Delivery phases

### Phase 1 — the ledger, extracted

Extract the reference implementation into TypeScript against spine and
storage-core: the four-method port, source partitioning, decider-based
attempt counting, versioned retention sweep, the payload data boundary
enforced by the codec, and the concurrency-posture documentation. Tests over
the memory store and against real Azurite. Exit: the suite passes both ways,
and the README says what the component refuses to promise as prominently as
what it does.

### Phase 2 — first consumer

RetireGolden has swapped `webhook-events.js` for `@pegma/webhooks`. The owner
explicitly waived the storage-soak timing gate on 2026-07-27; this phase no
longer waits for the previously planned soak through approximately 2026-08-03.
The port surface made the swap nearly mechanical, and the application's
existing webhook tests remain the acceptance bar.

RetireGolden migrated before the first advertised release and temporarily
consumes the exact npm-packed artifact built from Webhooks commit
`cae69326d2148e867f05b80843e4a9d506ab061c`. That exercises the package's
published shape without treating the artifact as a release. The registry's
`0.0.0` package-name bootstrap is isolated under the `bootstrap` dist-tag and
is not a consumer release. Post-release consumer cleanup replaces the vendored
artifact with exact `0.1.0`.

The operational exit originally required observing new production Stripe
traffic through that package shape. On 2026-07-29, the owner explicitly
accepted the migrated application's existing webhook suite, the exact packed
artifact integration, and the production-hardened reference behavior as
sufficient first-release evidence, closing Phase 2 without waiting for an
additional live delivery. The old `webhookEvents:event` rows are knowingly
stranded: the new ledger writes and sweeps `webhookReceipts:stripe`, so the old
rows must be removed by RetireGolden's one-time host storage cleanup rather
than by package retention.

### Phase 3 — second source, shape's verdict

Pegma.dev now receives authenticated GitHub release webhooks through
`@pegma/webhooks` on Cloudflare Workers with D1-backed storage. Together with
RetireGolden's Stripe integration on Azure Tables, this exercises a second real
provider, host, runtime, and storage adapter.

This evidence does not exercise two providers through one ledger in the same
host, and GitHub does not automatically retry failed webhook deliveries, so it
does not add provider-driven quarantine evidence. On 2026-07-29, the owner
explicitly accepted the cross-host evidence as sufficient for the first `0.x`
release. Same-host multi-source operation and additional quarantine ergonomics
remain post-release evidence work; the package does not claim either as a
stronger delivery guarantee.

### Phase 4 — publish

`0.1.0` is the first advertised release, with the storage-core and spine
version pins it was verified against. The exact `0.0.0` package-name bootstrap
remains isolated under npm's `bootstrap` dist-tag. The advertised release
publishes only from a protected signed annotated tag through the GitHub release
workflow and npm trusted-publisher OIDC with provenance. Stability follows the
ecosystem rule: breaking changes remain permitted until real consumers say
otherwise.

**Completed 2026-07-29:** protected signed annotated tag `v0.1.0` names
`67861144e0e36cb335f596469b631890fc9200bf`. GitHub release workflow run
`30493801499` prepared and published the exact artifact through OIDC. Registry
integrity is
`sha512-iCz65n860Ty0bHB6RAChah27Is4dM65cpJLkn0yOFm5RbXRqYO3xwD1a3q+KzqjGZUlppUHebzN186ORNZcp+A==`,
SLSA provenance is present, `latest` points to `0.1.0`, and `bootstrap`
remains at `0.0.0`.

## Open questions

**Verifier adapters.** Should a `@pegma/webhooks-verify-stripe` (etc.) exist
so hosts without the provider SDK get verification? Lean **no**: the SDKs do
this well, the schemes churn on the provider's schedule, and shipping
security-critical verification code is a maintenance promise out of
proportion to the component. Revisit only if a real consumer arrives without
an SDK to lean on.

**Quarantine surfacing.** A quarantined receipt is alert-worthy, but the
component has no opinion on alerting. Phase 3 did not add provider-driven
quarantine evidence because GitHub does not automatically retry failed
deliveries. Keep the current spine `Logger` warning and durable row; revisit an
EventBus notification only when a real consumer shows that those signals go
unnoticed.

**Overlap lease.** Should `begin` optionally lease an event so overlapping
deliveries serialize? Lean **no** — it changes the concurrency contract from
honest at-least-once to almost-exactly-once, which is the exact false
confidence this component exists to avoid. Revisit only with evidence of a
consumer whose side effects genuinely cannot own their idempotency.

**Threshold and retention configuration.** Defaults of 5 and 30 days come
from the reference implementation and Stripe's retry model. GitHub's manual
redelivery model supplied no evidence that another configuration surface is
needed. Keep the defaults and defer per-source configuration until a consumer
with a different automatic retry model requires it; per-event-type
configuration remains out of scope.

## Near-term backlog

- [x] Repository scaffolding to the ecosystem standard (package, tsconfig set,
      vitest, CI workflow mirroring storage-core's).
- [x] Phase 1 extraction with the conformance-style suite.
- [x] A README front section that leads with the at-least-once contract.
- [x] Implement the Phase 2 RetireGolden consumer migration (storage-soak
      timing gate explicitly waived by the owner on 2026-07-27).
- [x] Close Phase 2 on the owner's explicit acceptance of the migrated suite,
      exact packed artifact integration, and production-hardened reference
      behavior (2026-07-29).
- [x] Exercise a second real provider through Pegma.dev's GitHub release
      integration and accept the cross-host evidence for the first `0.x`
      release (2026-07-29).
- [x] Prepare `@pegma/webhooks@0.1.0` and the protected signed-tag OIDC release
      path.
- [x] Publish `@pegma/webhooks@0.1.0` from the protected `v0.1.0` GitHub
      release and verify registry integrity and provenance (2026-07-29).
- [ ] After release, exercise same-host multi-source operation and additional
      provider-driven quarantine behavior when a suitable consumer arrives.
