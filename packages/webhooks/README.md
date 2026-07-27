# @pegma/webhooks

Inbound webhook receipts for [Pegma](https://pegma.dev) components: idempotent
dedup, poison quarantine, and retention.

> [!IMPORTANT]
> Webhooks is in early `0.x` development. Its public API is not stable, it is
> not published, and it is not ready for production use.

## What it promises — and what it refuses to

Providers deliver webhooks **at least once**: retried, out of order, and
sometimes twice at the same moment. This package will give a receiver the three
things that model actually requires:

- **Dedup** — sequential redeliveries of a processed provider event id
  short-circuit to an acknowledgement.
- **Poison quarantine** — an event that keeps failing is eventually
  acknowledged, while its durable receipt remains an alert-worthy record for a
  human.
- **Retention** — receipts are swept after a window that outlives the
  provider's redelivery horizon, using conditional deletes.

It deliberately does **not** promise:

- **Exactly-once.** Two _overlapping_ deliveries of one event may both process;
  there is no lease, on purpose. Each side effect behind your webhook must own
  its own idempotency.
- **Ordering.** "Have we completed this id?" belongs here; "is this event newer
  than what we applied?" is consumer domain logic.
- **Signature verification.** Verify with the provider's SDK before handing
  the event to this package.

No payload is ever stored. Receipts hold only event ids, types, statuses,
attempt counts, and timestamps.

## Where it fits

`@pegma/webhooks` will declare one collection over an injected
[`@pegma/storage-core`](https://github.com/pegma-dev/storage-core) `Store` and
take time and logging from
[`@pegma/spine`](https://github.com/pegma-dev/spine). Outbound webhooks —
_sending_ to someone else's endpoint — are a durable-outbox problem and live
with storage, not here.

The scaffold is established, but ledger behavior has not been extracted yet.
See the
[project plan](https://github.com/pegma-dev/webhooks/blob/main/docs/PROJECT_PLAN.md)
for the model, design decisions, and delivery phases.

## License

MIT © RetireGolden, LLC
