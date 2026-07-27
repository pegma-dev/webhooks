# Webhooks Project Plan

## Status

**Stage:** planning; nothing extracted yet
(`0.x`, public API unstable, unpublished)

**Initial reference application:** RetireGolden, whose account API carries the
production-tested implementation this component is extracted from
(`api/src/lib/webhook-events.js` — a Stripe event ledger hardened by real
webhook traffic and a test suite covering the concurrency corners).

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
   provider auto-disabling the endpoint — which takes down *every* webhook,
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
both record attempt *n + 1* and defer quarantine.

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

RetireGolden swaps `webhook-events.js` for `@pegma/webhooks`. **Timing gate:
after its storage migration's stage-soak week closes and the production
deploy lands** (soak runs through ~2026-08-03) — swapping the code under soak
would invalidate the soak. The port surface is designed to make this swap
nearly mechanical; the application's existing webhook tests carry over as the
acceptance bar. Exit: production Stripe traffic through the published-shape
package, old collection rows knowingly stranded and swept by retention.

### Phase 3 — second source, shape's verdict

A second real provider through the same ledger in one host — the likely
candidate is the support desk's inbound mail provider callbacks, whichever
provider that lands on. This phase judges the multi-source generalization
(the one thing Phase 1 adds beyond the reference implementation) and the
quarantine ergonomics: does a quarantined row actually get found and triaged,
or does it need a surfacing hook (see Open questions)?

### Phase 4 — publish

First public `0.x` alongside the rest of the ecosystem's publishing wave,
with the storage-core and spine version pins it was verified against.
Stability follows the ecosystem rule: breaking changes permitted until real
consumers say otherwise.

## Open questions

**Verifier adapters.** Should a `@pegma/webhooks-verify-stripe` (etc.) exist
so hosts without the provider SDK get verification? Lean **no**: the SDKs do
this well, the schemes churn on the provider's schedule, and shipping
security-critical verification code is a maintenance promise out of
proportion to the component. Revisit only if a real consumer arrives without
an SDK to lean on.

**Quarantine surfacing.** A quarantined receipt is alert-worthy, but the
component has no opinion on alerting. Options: nothing (hosts poll or check
logs), a spine `Logger` warn (cheap, already planned), or a spine EventBus
notification (best-effort is acceptable for alerting — a missed notification
still leaves the durable row). Lean: Logger warn now, EventBus notification
if Phase 3 shows quarantines going unnoticed.

**Overlap lease.** Should `begin` optionally lease an event so overlapping
deliveries serialize? Lean **no** — it changes the concurrency contract from
honest at-least-once to almost-exactly-once, which is the exact false
confidence this component exists to avoid. Revisit only with evidence of a
consumer whose side effects genuinely cannot own their idempotency.

**Threshold and retention configuration.** Defaults of 5 and 30 days come
from the reference implementation and Stripe's retry model. Per-source
configuration is trivially justifiable; per-event-type is probably
over-engineering. Decide in Phase 3 when a second provider's retry model is
on the table.

## Near-term backlog

1. Repository scaffolding to the ecosystem standard (package, tsconfig set,
   vitest, CI workflow mirroring storage-core's).
2. Phase 1 extraction with the conformance-style suite.
3. A README front section that leads with the at-least-once contract.
4. Coordinate Phase 2 timing against RetireGolden's storage-soak calendar.
