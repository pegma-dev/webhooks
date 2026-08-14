# Webhooks

[![CI](https://github.com/pegma-dev/webhooks/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/webhooks/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Inbound webhook receipt handling for
[Pegma](https://pegma.dev) components: sequential deduplication, poison
quarantine, and retention.

> [!IMPORTANT]
> `@pegma/webhooks@0.1.0` is the first advertised release. It publishes only
> from a protected signed tag through npm trusted-publisher OIDC with
> provenance. The public API remains unstable while the package is in `0.x`.

## What it promises — and what it refuses to

Providers deliver webhooks at least once: retried, out of order, and sometimes
twice at the same moment. This ledger provides:

- **Sequential deduplication.** A redelivery of a processed provider event id
  short-circuits to an acknowledgement.
- **Poison quarantine.** Five failures remain retryable; the sixth and later
  failures quarantine the receipt so the caller can acknowledge while leaving
  a durable signal for a human.
- **Retention.** Receipts untouched for 30 days are swept with versioned
  conditional deletes.

It deliberately refuses to promise:

- **Exactly-once processing.** Two overlapping deliveries of one event may
  both see `new` and both process. Each side effect behind the webhook must own
  its own idempotency.
- **Ordering.** The ledger answers “have we completed this id?”, never “is this
  event newer than what we applied?”. Ordering is consumer domain logic.
- **Payload storage or replay.** No payload ever enters the receipt codec, so
  the ledger cannot replay one.
- **Signature verification, provider SDK wrapping, or HTTP handling.** The
  host authenticates and parses an event before calling the ledger.
- **Outbound webhook delivery.** Sending belongs to storage’s durable-outbox
  tier.

## Use

Construct one ledger per provider or source. The source is bound once and
partitions every key:

```ts
import { createWebhookLedger } from "@pegma/webhooks";
import { createMemoryStore } from "@pegma/storage-core";

const ledger = createWebhookLedger({
  store: createMemoryStore(),
  source: "stripe",
});

const receipt = await ledger.begin(event.id, event.type);
if (receipt.status === "new") {
  try {
    await applyEvent(event);
    await ledger.markProcessed(event.id);
  } catch (error) {
    const failure = await ledger.markFailed(event.id);
    if (!failure.quarantined) throw error;
  }
}
```

`clock` and `logger` are optional and default to `systemClock` and
`noopLogger` from `@pegma/spine`. Source names and event ids must match
`^[A-Za-z0-9|_.:@-]{1,256}$`; unsupported storage-key characters are rejected
with a `TypeError`.

The event type is provider-supplied triage data and never a storage key, so it
is bounded rather than rejected: it is truncated to 256 characters, and a
non-string value is stored as `null`. Truncation and a non-nullish non-string
each log a `warn`; an absent type (`null` or `undefined`) is recorded as `null`
silently. A malformed type therefore cannot fail `begin` and leave the event
without a receipt to count attempts against.

Clock values and explicit sweep timestamps must use the canonical UTC ISO form
with milliseconds produced by `Date.toISOString()`. Calling
`purgeExpired()` or `purgeExpired(undefined)` uses the injected clock; other
runtime values, including `null`, are rejected before storage is accessed.

`markProcessed` and `markFailed` defensively create a missing receipt.
`markFailed` counts inside the storage update decider, so concurrent failures
do not lose an increment. `purgeExpired(now?)` uses an explicit timestamp when
provided, otherwise the injected clock, and preserves a row changed after it
was listed.

For inspection and triage, `webhookReceiptKey(source, eventId)` and
`webhookReceiptCollection(source)` expose the same source-bound key and
collection definition used by the ledger. The collection is named
`webhookReceipts`; a stored receipt has exactly `eventId`, `type`, `status`,
`attempts`, `firstSeenAt`, and `lastSeenAt`.

The behavior suite runs unchanged over `createMemoryStore()` and the Azure
Tables adapter against real Azurite.

See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the design decisions and
delivery phases.

## Development

Requires Node.js 22 or newer. Stock Node ships Corepack but not a pnpm shim,
so enable it before the first `pnpm` command:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
```

## License

MIT © RetireGolden, LLC
