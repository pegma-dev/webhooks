# Webhooks

[![CI](https://github.com/pegma-dev/webhooks/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/webhooks/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Inbound webhook receipts for [Pegma](https://pegma.dev) components: idempotent
dedup, poison quarantine, and retention.

> [!IMPORTANT]
> Webhooks is in early `0.x` development. Its public API is not stable, its
> packages are not published, and it is not ready for production use.

## What it promises — and what it refuses to

Providers deliver webhooks **at least once**: retried, out of order, and
sometimes twice at the same moment. Once extracted, this component will give a
receiver the three things that model actually requires:

- **Dedup** — sequential redeliveries of a processed provider event id will
  short-circuit to an acknowledgement.
- **Poison quarantine** — an event that keeps failing will eventually be
  acknowledged, while its durable receipt remains an alert-worthy record for a
  human.
- **Retention** — receipts will be swept after a window that outlives the
  provider's redelivery horizon, using conditional deletes.

It deliberately does **not** promise:

- **Exactly-once.** Two _overlapping_ deliveries of one event can both see
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

`@pegma/webhooks` will declare one collection over an injected
[`@pegma/storage-core`](https://github.com/pegma-dev/storage-core) `Store` and
will take time and logging from
[`@pegma/spine`](https://github.com/pegma-dev/spine). Outbound webhooks —
_sending_ to someone else's endpoint — are a durable-outbox problem and live
with storage, not here.

The scaffold is established, but ledger behavior has not been extracted yet.
The design is extracted from a production Stripe webhook ledger in the
RetireGolden account API, the ecosystem's reference application. See
[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the model, the design
decisions, and the delivery phases.

## License

MIT © RetireGolden, LLC
