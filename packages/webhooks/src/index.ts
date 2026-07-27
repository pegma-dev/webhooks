import {
  noopLogger,
  systemClock,
  type Clock,
  type IsoTimestamp,
  type Logger,
} from "@pegma/spine";
import {
  defineCollection,
  type CollectionDefinition,
  type EntityKey,
  type Store,
  type StoredRecord,
  type StoredValue,
} from "@pegma/storage-core";

const SAFE_KEY_PART = /^[A-Za-z0-9|_.:@-]{1,256}$/;
const CANONICAL_ISO_TIMESTAMP =
  /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const QUARANTINE_THRESHOLD = 5;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type WebhookReceiptStatus = "new" | "processed" | "quarantined";

export interface WebhookReceipt {
  readonly eventId: string;
  readonly type: string | null;
  readonly status: WebhookReceiptStatus;
  readonly attempts: number;
  readonly firstSeenAt: IsoTimestamp;
  readonly lastSeenAt: IsoTimestamp;
}

export interface WebhookBeginResult {
  readonly status: WebhookReceiptStatus;
  readonly attempts: number;
}

export interface WebhookFailureResult {
  readonly attempts: number;
  readonly quarantined: boolean;
}

export interface WebhookLedger {
  begin(eventId: string, type: string): Promise<WebhookBeginResult>;
  markProcessed(eventId: string): Promise<void>;
  markFailed(eventId: string): Promise<WebhookFailureResult>;
  purgeExpired(now?: IsoTimestamp): Promise<number>;
}

export interface WebhookLedgerOptions {
  readonly store: Store;
  readonly source: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

function assertSafeSource(source: string): string {
  if (typeof source !== "string" || !SAFE_KEY_PART.test(source)) {
    throw new TypeError(
      "Unsupported webhook source: expected 1-256 safe key characters.",
    );
  }
  return source;
}

function assertSafeEventId(eventId: string): string {
  if (typeof eventId !== "string" || !SAFE_KEY_PART.test(eventId)) {
    throw new TypeError(
      "Unsupported webhook event id: expected 1-256 safe key characters.",
    );
  }
  return eventId;
}

function canonicalTimestampMilliseconds(timestamp: unknown): number | null {
  if (
    typeof timestamp !== "string" ||
    !CANONICAL_ISO_TIMESTAMP.test(timestamp)
  ) {
    return null;
  }
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== timestamp
  ) {
    return null;
  }
  return milliseconds;
}

function timestampMilliseconds(timestamp: unknown): number {
  const milliseconds = canonicalTimestampMilliseconds(timestamp);
  if (milliseconds === null) {
    throw new TypeError(
      "Invalid webhook timestamp: expected a canonical UTC ISO timestamp with milliseconds.",
    );
  }
  return milliseconds;
}

function toStatus(value: unknown): WebhookReceiptStatus {
  return value === "processed" || value === "quarantined" ? value : "new";
}

function toAttempts(value: unknown): number {
  const attempts = Number(value ?? 0);
  return Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;
}

type EncodedWebhookReceipt = Record<keyof WebhookReceipt, StoredValue>;

function encodeWebhookReceipt(value: WebhookReceipt): EncodedWebhookReceipt {
  return {
    eventId: value.eventId,
    type: value.type,
    status: value.status,
    attempts: value.attempts,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
  };
}

function decodeWebhookReceipt(record: StoredRecord): WebhookReceipt {
  return {
    eventId: String(record["eventId"] ?? ""),
    type: record["type"] == null ? null : String(record["type"]),
    status: toStatus(record["status"]),
    attempts: toAttempts(record["attempts"]),
    firstSeenAt: String(record["firstSeenAt"] ?? ""),
    lastSeenAt: String(record["lastSeenAt"] ?? ""),
  };
}

export function webhookReceiptKey(source: string, eventId: string): EntityKey {
  return {
    partition: assertSafeSource(source),
    id: assertSafeEventId(eventId),
  };
}

export function webhookReceiptCollection(
  source: string,
): CollectionDefinition<WebhookReceipt> {
  const partition = assertSafeSource(source);
  return defineCollection({
    name: "webhookReceipts",
    key: (value) => webhookReceiptKey(partition, value.eventId),
    codec: {
      encode: encodeWebhookReceipt,
      decode: decodeWebhookReceipt,
    },
  });
}

function isExpired(receipt: WebhookReceipt, nowMilliseconds: number): boolean {
  const lastSeen = canonicalTimestampMilliseconds(receipt.lastSeenAt);
  if (lastSeen === null) {
    return true;
  }
  return nowMilliseconds - lastSeen >= RETENTION_MS;
}

export function createWebhookLedger(
  options: WebhookLedgerOptions,
): WebhookLedger {
  const source = assertSafeSource(options.source);
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? noopLogger;
  const definition = webhookReceiptCollection(source);
  const receipts = options.store.collection(definition);
  const key = (eventId: string) => webhookReceiptKey(source, eventId);

  const missingReceipt = (
    eventId: string,
    now: IsoTimestamp,
  ): WebhookReceipt => ({
    eventId,
    type: null,
    status: "new",
    attempts: 0,
    firstSeenAt: now,
    lastSeenAt: now,
  });

  return {
    async begin(eventId, type) {
      assertSafeEventId(eventId);
      const now = clock.now();
      timestampMilliseconds(now);
      const { value } = await receipts.insertIfAbsent({
        eventId,
        type,
        status: "new",
        attempts: 0,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      return { status: value.status, attempts: value.attempts };
    },

    async markProcessed(eventId) {
      assertSafeEventId(eventId);
      const now = clock.now();
      timestampMilliseconds(now);
      await receipts.update(key(eventId), (current) => {
        const base = current ?? missingReceipt(eventId, now);
        return {
          action: "write",
          value: { ...base, status: "processed", lastSeenAt: now },
        };
      });
    },

    async markFailed(eventId) {
      assertSafeEventId(eventId);
      const now = clock.now();
      timestampMilliseconds(now);
      let transitionedToQuarantined = false;
      const result = await receipts.update(key(eventId), (current) => {
        const base = current ?? missingReceipt(eventId, now);
        const attempts = base.attempts + 1;
        const quarantined = attempts > QUARANTINE_THRESHOLD;
        transitionedToQuarantined =
          quarantined && base.status !== "quarantined";
        return {
          action: "write",
          value: {
            ...base,
            status: quarantined ? "quarantined" : base.status,
            attempts,
            lastSeenAt: now,
          },
        };
      });
      if (result.value === null) {
        throw new Error("Webhook receipt failure was not persisted.");
      }
      const outcome = {
        attempts: result.value.attempts,
        quarantined: result.value.attempts > QUARANTINE_THRESHOLD,
      };
      if (transitionedToQuarantined) {
        logger.log("warn", "Webhook receipt quarantined", {
          source,
          eventId,
          attempts: outcome.attempts,
        });
      }
      return outcome;
    },

    async purgeExpired(now) {
      const timestamp = now === undefined ? clock.now() : now;
      const nowMilliseconds = timestampMilliseconds(timestamp);
      const rows = await receipts.listVersioned(source);
      let purged = 0;
      for (const row of rows) {
        if (!isExpired(row.value, nowMilliseconds)) {
          continue;
        }
        if (!SAFE_KEY_PART.test(row.value.eventId)) {
          logger.log("warn", "Webhook receipt sweep skipped corrupt row", {
            source,
          });
          continue;
        }
        if (
          await receipts.deleteIfUnchanged(
            definition.key(row.value),
            row.version,
          )
        ) {
          purged += 1;
        }
      }
      logger.log("info", "Webhook receipt retention sweep completed", {
        source,
        purged,
      });
      return purged;
    },
  };
}
