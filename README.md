# Webhooks

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Inbound webhook receipts for [Pegma](https://pegma.dev) components: idempotent
dedup, poison quarantine, and retention.

> [!IMPORTANT]
> Webhooks is in early `0.x` development. Its public API is not stable, its
> packages are not published, and it is not ready for production use.

## What it promises — and what it refuses to

Providers deliver webhooks **at least once**: retried, out of order, and
sometimes twice at the same moment. This component gives a receiver the three
things that model actually requires:

- **Dedup** — `begin(eventId, type)` records a receipt exactly once per
  provider event id (`insertIfAbsent` underneath), so a sequential redelivery
  of a processed event short-circuits to an acknowledgement.
- **Poison quarantine** — an event that keeps failing is given up on after a
  bounded number of attempts and acknowledged, so the provider's retry storm
  ends before it gets the endpoint auto-disabled. The quarantined receipt is
  the durable, alert-worthy record for a human.
- **Retention** — receipts are swept after a window that outlives the
  provider's redelivery horizon, with conditional deletes so a receipt touched
  mid-sweep survives.

It deliberately does **not** promise:

- **Exactly-once.** Two *overlapping* deliveries of one event can both see
  `new` and both process — there is no lease, on purpose. Each side effect
  behind your webhook must own its own idempotency. A component that hides
  this behind a lock is lying to you about a crashed lock-holder.
- **Ordering.** "Have we completed this id?" is answered here; "is this event
  newer than what we applied?" is domain logic and belongs in your code.
- **Signature verification.** Your provider's SDK does this well; verify
  first, then hand the event in.

No payload is ever stored — receipts hold ids, types, counters, and
timestamps only.

## Where it fits

`@pegma/webhooks` declares one collection over an injected
[`@pegma/storage-core`](https://github.com/pegma-dev/storage-core) `Store` and
takes time and logging from
[`@pegma/spine`](https://github.com/pegma-dev/spine). Outbound webhooks —
*sending* to someone else's endpoint — are a durable-outbox problem and live
with storage, not here.

The design is extracted from a production Stripe webhook ledger in the
RetireGolden account API, the ecosystem's reference application. See
[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the model, the design
decisions, and the delivery phases.

## License

MIT © RetireGolden, LLC
