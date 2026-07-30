import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { fixedClock, type IsoTimestamp, type Logger } from "@pegma/spine";
import { spawn as spawnChild } from "node:child_process";
import { createServer } from "node:net";
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from "@pegma/storage-core";
import { describe, expect, inject, it } from "vitest";

import {
  allocateAvailablePort,
  waitForStartup,
} from "../../../test/azurite.js";
import {
  createWebhookLedger,
  webhookReceiptCollection,
  webhookReceiptKey,
  type WebhookReceipt,
} from "./index.js";

declare module "vitest" {
  export interface ProvidedContext {
    azuriteTablePort: number;
  }
}

const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONNECTION_STRING = [
  "DefaultEndpointsProtocol=http",
  `AccountName=${ACCOUNT}`,
  `AccountKey=${KEY}`,
  `TableEndpoint=http://127.0.0.1:${inject("azuriteTablePort")}/${ACCOUNT};`,
].join(";");
const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = "2026-07-27T12:00:00.000Z";

let tableCounter = 0;

function freshAzureStore(): Store {
  tableCounter += 1;
  const table = `webhooks${process.pid}t${tableCounter}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
  });
  return createAzureTablesStore({ client });
}

function receipt(
  eventId: string,
  overrides: Partial<WebhookReceipt> = {},
): WebhookReceipt {
  return {
    eventId,
    type: "provider.event",
    status: "new",
    attempts: 0,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function clockSequence(...timestamps: IsoTimestamp[]) {
  let index = 0;
  return {
    now(): IsoTimestamp {
      const value = timestamps[Math.min(index, timestamps.length - 1)];
      index += 1;
      if (value === undefined) {
        throw new Error("Clock sequence requires at least one timestamp.");
      }
      return value;
    },
  };
}

function synchronizeFirstTwoUpdates(store: Store): Store {
  let arrivals = 0;
  let release = () => {};
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const delegate = store.collection(definition);
      if (definition.name !== "webhookReceipts") {
        return delegate;
      }
      return {
        ...delegate,
        update: (key, decide, options) =>
          delegate.update(
            key,
            async (current) => {
              arrivals += 1;
              if (arrivals <= 2) {
                if (arrivals === 2) {
                  release();
                }
                await bothArrived;
              }
              return decide(current);
            },
            options,
          ),
      };
    },
  };
}

function afterFirstList(store: Store, touch: () => Promise<void>): Store {
  let touched = false;
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const delegate = store.collection(definition);
      if (definition.name !== "webhookReceipts") {
        return delegate;
      }
      const wrapped: CollectionStore<T> = {
        ...delegate,
        async listVersioned(partition) {
          const rows = await delegate.listVersioned(partition);
          if (!touched) {
            touched = true;
            await touch();
          }
          return rows;
        },
      };
      return wrapped;
    },
  };
}

function withCorruptRowListedFirst(store: Store): Store {
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const delegate = store.collection(definition);
      if (definition.name !== "webhookReceipts") {
        return delegate;
      }
      return {
        ...delegate,
        async listVersioned(partition) {
          const rows = await delegate.listVersioned(partition);
          const corrupt = receipt("", {
            lastSeenAt: "2020-01-01T00:00:00.000Z",
          });
          return [
            { value: corrupt as unknown as T, version: "opaque-corrupt-row" },
            ...rows,
          ];
        },
      };
    },
  };
}

function trackLedgerStorage(store: Store) {
  const calls = {
    insertIfAbsent: 0,
    update: 0,
    listVersioned: 0,
    deleteIfUnchanged: 0,
  };
  const tracked: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const delegate = store.collection(definition);
      return {
        ...delegate,
        async insertIfAbsent(value) {
          calls.insertIfAbsent += 1;
          return delegate.insertIfAbsent(value);
        },
        async update(key, decide, options) {
          calls.update += 1;
          return delegate.update(key, decide, options);
        },
        async listVersioned(partition) {
          calls.listVersioned += 1;
          return delegate.listVersioned(partition);
        },
        async deleteIfUnchanged(key, version) {
          calls.deleteIfUnchanged += 1;
          return delegate.deleteIfUnchanged(key, version);
        },
      };
    },
  };
  return { calls, store: tracked };
}

function failingInsertStore(error: Error): Store {
  const store = createMemoryStore();
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const delegate = store.collection(definition);
      return {
        ...delegate,
        async insertIfAbsent() {
          throw error;
        },
      };
    },
  };
}

function ledgerConformance(name: string, freshStore: () => Store): void {
  describe(name, () => {
    it("records a new receipt and leaves a repeated new receipt untouched", async () => {
      const store = freshStore();
      const clock = clockSequence(NOW, "2026-07-28T12:00:00.000Z");
      const ledger = createWebhookLedger({
        store,
        source: "stripe",
        clock,
      });

      expect(await ledger.begin("evt_repeat", "first.type")).toEqual({
        status: "new",
        attempts: 0,
      });
      expect(await ledger.begin("evt_repeat", "second.type")).toEqual({
        status: "new",
        attempts: 0,
      });

      const stored = await store
        .collection(webhookReceiptCollection("stripe"))
        .get(webhookReceiptKey("stripe", "evt_repeat"));
      expect(stored).toEqual(
        receipt("evt_repeat", {
          type: "first.type",
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        }),
      );
    });

    it("short-circuits processed and quarantined redeliveries", async () => {
      const store = freshStore();
      const receipts = store.collection(webhookReceiptCollection("stripe"));
      await receipts.put(receipt("evt_processed", { status: "processed" }));
      await receipts.put(
        receipt("evt_quarantined", {
          status: "quarantined",
          attempts: 6,
        }),
      );
      const ledger = createWebhookLedger({
        store,
        source: "stripe",
        clock: fixedClock(NOW),
      });

      expect(await ledger.begin("evt_processed", "ignored")).toEqual({
        status: "processed",
        attempts: 0,
      });
      expect(await ledger.begin("evt_quarantined", "ignored")).toEqual({
        status: "quarantined",
        attempts: 6,
      });
    });

    it("allows overlapping begins to see new while storing one row", async () => {
      const store = freshStore();
      const ledger = createWebhookLedger({
        store,
        source: "stripe",
        clock: fixedClock(NOW),
      });

      expect(
        await Promise.all([
          ledger.begin("evt_overlap", "a"),
          ledger.begin("evt_overlap", "b"),
        ]),
      ).toEqual([
        { status: "new", attempts: 0 },
        { status: "new", attempts: 0 },
      ]);
      expect(
        await store
          .collection(webhookReceiptCollection("stripe"))
          .list("stripe"),
      ).toHaveLength(1);
    });

    it("quarantines on the sixth failure", async () => {
      const ledger = createWebhookLedger({
        store: freshStore(),
        source: "stripe",
        clock: fixedClock(NOW),
      });
      await ledger.begin("evt_poison", "invoice.failed");

      for (let attempts = 1; attempts <= 5; attempts += 1) {
        expect(await ledger.markFailed("evt_poison")).toEqual({
          attempts,
          quarantined: false,
        });
      }
      expect(await ledger.markFailed("evt_poison")).toEqual({
        attempts: 6,
        quarantined: true,
      });
    });

    it("preserves the reference's direct status transitions", async () => {
      const store = freshStore();
      const ledger = createWebhookLedger({
        store,
        source: "stripe",
        clock: fixedClock(NOW),
      });
      await ledger.markProcessed("evt_direct");
      for (let attempts = 1; attempts <= 6; attempts += 1) {
        await ledger.markFailed("evt_direct");
      }
      expect(await ledger.begin("evt_direct", "ignored")).toEqual({
        status: "quarantined",
        attempts: 6,
      });

      await ledger.markProcessed("evt_direct");
      expect(await ledger.begin("evt_direct", "ignored")).toEqual({
        status: "processed",
        attempts: 6,
      });
    });

    it("does not lose concurrent failure increments", async () => {
      const base = freshStore();
      const ledger = createWebhookLedger({
        store: synchronizeFirstTwoUpdates(base),
        source: "stripe",
        clock: fixedClock(NOW),
      });
      const results = await Promise.all([
        ledger.markFailed("evt_concurrent"),
        ledger.markFailed("evt_concurrent"),
      ]);

      expect(results.map((result) => result.attempts).sort()).toEqual([1, 2]);
      const stored = await base
        .collection(webhookReceiptCollection("stripe"))
        .get(webhookReceiptKey("stripe", "evt_concurrent"));
      expect(stored?.attempts).toBe(2);
    });

    it("logs one quarantine transition when concurrent failures cross the threshold", async () => {
      const base = freshStore();
      await base
        .collection(webhookReceiptCollection("stripe"))
        .put(receipt("evt_concurrent_quarantine", { attempts: 5 }));
      const entries: Array<{
        level: string;
        fields?: Readonly<Record<string, unknown>>;
      }> = [];
      const logger: Logger = {
        log(level, _message, fields) {
          entries.push({
            level,
            ...(fields === undefined ? {} : { fields }),
          });
        },
      };
      const ledger = createWebhookLedger({
        store: synchronizeFirstTwoUpdates(base),
        source: "stripe",
        clock: fixedClock(NOW),
        logger,
      });

      const results = await Promise.all([
        ledger.markFailed("evt_concurrent_quarantine"),
        ledger.markFailed("evt_concurrent_quarantine"),
      ]);
      expect(results.map((result) => result.attempts).sort()).toEqual([6, 7]);
      expect(entries).toEqual([
        {
          level: "warn",
          fields: {
            source: "stripe",
            eventId: "evt_concurrent_quarantine",
            attempts: 6,
          },
        },
      ]);
    });

    it("preserves the whole receipt across status and timestamp writes", async () => {
      const store = freshStore();
      const ledger = createWebhookLedger({
        store,
        source: "stripe",
        clock: clockSequence(
          NOW,
          "2026-07-27T13:00:00.000Z",
          "2026-07-27T14:00:00.000Z",
        ),
      });
      await ledger.begin("evt_preserve", "checkout.completed");
      await ledger.markFailed("evt_preserve");
      await ledger.markProcessed("evt_preserve");

      expect(
        await store
          .collection(webhookReceiptCollection("stripe"))
          .get(webhookReceiptKey("stripe", "evt_preserve")),
      ).toEqual(
        receipt("evt_preserve", {
          type: "checkout.completed",
          status: "processed",
          attempts: 1,
          firstSeenAt: NOW,
          lastSeenAt: "2026-07-27T14:00:00.000Z",
        }),
      );
    });

    it("records marks that arrive before begin", async () => {
      const ledger = createWebhookLedger({
        store: freshStore(),
        source: "stripe",
        clock: fixedClock(NOW),
      });

      expect(await ledger.markFailed("evt_failed_first")).toEqual({
        attempts: 1,
        quarantined: false,
      });
      await ledger.markProcessed("evt_processed_first");
      expect(await ledger.begin("evt_processed_first", "ignored")).toEqual({
        status: "processed",
        attempts: 0,
      });
    });

    it("isolates the same event id across sources", async () => {
      const store = freshStore();
      const stripe = createWebhookLedger({
        store,
        source: "stripe",
        clock: fixedClock(NOW),
      });
      const github = createWebhookLedger({
        store,
        source: "github",
        clock: fixedClock(NOW),
      });
      await stripe.begin("shared_id", "stripe.type");
      await stripe.markProcessed("shared_id");

      expect(await github.begin("shared_id", "github.type")).toEqual({
        status: "new",
        attempts: 0,
      });
      expect(
        await store
          .collection(webhookReceiptCollection("stripe"))
          .list("stripe"),
      ).toHaveLength(1);
      expect(
        await store
          .collection(webhookReceiptCollection("github"))
          .list("github"),
      ).toHaveLength(1);
    });

    it("rejects unsafe sources and event ids at every public key boundary", async () => {
      const store = freshStore();
      expect(() =>
        createWebhookLedger({ store, source: "bad/source" }),
      ).toThrow(TypeError);
      expect(() => createWebhookLedger({ store, source: "" })).toThrow(
        /source/,
      );
      expect(() =>
        createWebhookLedger({ store, source: "s".repeat(257) }),
      ).toThrow(/source/);
      expect(() => webhookReceiptCollection("bad#source")).toThrow(/source/);
      expect(() => webhookReceiptKey("stripe", "bad/event")).toThrow(
        /event id/,
      );
      expect(() => webhookReceiptKey("stripe", "e".repeat(257))).toThrow(
        /event id/,
      );
      const ledger = createWebhookLedger({ store, source: "stripe" });
      await expect(ledger.begin("bad?event", "type")).rejects.toThrow(
        /event id/,
      );
      await expect(ledger.markProcessed("bad\\event")).rejects.toThrow(
        /event id/,
      );
      await expect(ledger.markFailed("")).rejects.toThrow(/event id/);
    });

    it("bounds the stored event type instead of failing the receipt", async () => {
      const store = freshStore();
      const entries: Array<{
        level: string;
        fields?: Readonly<Record<string, unknown>>;
      }> = [];
      const logger: Logger = {
        log(level, _message, fields) {
          entries.push({
            level,
            ...(fields === undefined ? {} : { fields }),
          });
        },
      };
      const ledger = createWebhookLedger({
        store,
        source: "stripe",
        clock: fixedClock(NOW),
        logger,
      });
      const receipts = store.collection(webhookReceiptCollection("stripe"));
      const storedType = async (eventId: string) =>
        (await receipts.get(webhookReceiptKey("stripe", eventId)))?.type;

      expect(await ledger.begin("evt_long_type", "t".repeat(300))).toEqual({
        status: "new",
        attempts: 0,
      });
      expect(await storedType("evt_long_type")).toBe("t".repeat(256));

      expect(
        await ledger.begin("evt_object_type", {
          toString: () => "surprise",
        } as unknown as string),
      ).toEqual({ status: "new", attempts: 0 });
      expect(await storedType("evt_object_type")).toBeNull();

      expect(
        await ledger.begin("evt_absent_type", null as unknown as string),
      ).toEqual({ status: "new", attempts: 0 });
      expect(await storedType("evt_absent_type")).toBeNull();

      expect(await ledger.begin("evt_exact_type", "t".repeat(256))).toEqual({
        status: "new",
        attempts: 0,
      });
      expect(await storedType("evt_exact_type")).toBe("t".repeat(256));

      // Truncating mid-surrogate-pair would store an unpaired half.
      expect(
        await ledger.begin("evt_surrogate_type", `${"t".repeat(255)}\u{1F600}`),
      ).toEqual({ status: "new", attempts: 0 });
      expect(await storedType("evt_surrogate_type")).toBe("t".repeat(255));

      expect(entries).toEqual([
        {
          level: "warn",
          fields: { source: "stripe", eventId: "evt_long_type" },
        },
        {
          level: "warn",
          fields: { source: "stripe", eventId: "evt_object_type" },
        },
        {
          level: "warn",
          fields: { source: "stripe", eventId: "evt_surrogate_type" },
        },
      ]);
    });

    it("rejects invalid clock timestamps before a mark can persist", async () => {
      const base = freshStore();
      const tracked = trackLedgerStorage(base);

      for (const [index, invalid] of [
        "0",
        "07/27/2026",
        "2026-07-27",
      ].entries()) {
        const ledger = createWebhookLedger({
          store: tracked.store,
          source: "stripe",
          clock: fixedClock(invalid),
        });
        await expect(
          ledger.begin(`evt_bad_begin_time_${index}`, "type"),
        ).rejects.toThrow(/timestamp/);
      }

      const ledger = createWebhookLedger({
        store: tracked.store,
        source: "stripe",
        clock: fixedClock("not-a-timestamp"),
      });

      await expect(
        ledger.markProcessed("evt_bad_processed_time"),
      ).rejects.toThrow(/timestamp/);
      await expect(ledger.markFailed("evt_bad_failed_time")).rejects.toThrow(
        /timestamp/,
      );
      expect(tracked.calls).toEqual({
        insertIfAbsent: 0,
        update: 0,
        listVersioned: 0,
        deleteIfUnchanged: 0,
      });
      expect(
        await base
          .collection(webhookReceiptCollection("stripe"))
          .list("stripe"),
      ).toEqual([]);
    });

    it("purges inclusively at 30 days and handles malformed, future, and source-scoped rows", async () => {
      const store = freshStore();
      const stripeReceipts = store.collection(
        webhookReceiptCollection("stripe"),
      );
      const githubReceipts = store.collection(
        webhookReceiptCollection("github"),
      );
      await stripeReceipts.put(
        receipt("evt_boundary", {
          lastSeenAt: "2026-06-27T12:00:00.000Z",
        }),
      );
      await stripeReceipts.put(
        receipt("evt_inside", {
          lastSeenAt: "2026-06-27T12:00:00.001Z",
        }),
      );
      await stripeReceipts.put(
        receipt("evt_malformed", { lastSeenAt: "not-a-date" }),
      );
      await stripeReceipts.put(
        receipt("evt_noncanonical", { lastSeenAt: "9999" }),
      );
      await stripeReceipts.put(
        receipt("evt_future", {
          lastSeenAt: "2026-07-28T12:00:00.000Z",
        }),
      );
      await githubReceipts.put(
        receipt("evt_other_source", {
          lastSeenAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      const ledger = createWebhookLedger({
        store,
        source: "stripe",
        clock: fixedClock("2030-01-01T00:00:00.000Z"),
      });

      expect(await ledger.purgeExpired(NOW)).toBe(3);
      const remaining = await stripeReceipts.list("stripe");
      expect(remaining.map((row) => row.eventId).sort()).toEqual([
        "evt_future",
        "evt_inside",
      ]);
      expect(
        await githubReceipts.get(
          webhookReceiptKey("github", "evt_other_source"),
        ),
      ).not.toBeNull();
    });

    it("uses the clock for a sweep when explicit now is absent", async () => {
      const store = freshStore();
      const receipts = store.collection(webhookReceiptCollection("stripe"));
      await receipts.put(
        receipt("evt_clock", { lastSeenAt: "2026-01-01T00:00:00.000Z" }),
      );
      const ledger = createWebhookLedger({
        store,
        source: "stripe",
        clock: fixedClock(NOW),
      });

      expect(await ledger.purgeExpired(undefined)).toBe(1);
    });

    it("rejects invalid explicit and clock sweep timestamps before storage or logging", async () => {
      const base = freshStore();
      const receipts = base.collection(webhookReceiptCollection("stripe"));
      await receipts.put(
        receipt("evt_invalid_sweep", {
          lastSeenAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      const entries: string[] = [];
      const logger: Logger = {
        log(level) {
          entries.push(level);
        },
      };
      const tracked = trackLedgerStorage(base);
      const validClockLedger = createWebhookLedger({
        store: tracked.store,
        source: "stripe",
        clock: fixedClock(NOW),
        logger,
      });
      const invalidClockLedger = createWebhookLedger({
        store: tracked.store,
        source: "stripe",
        clock: fixedClock("2026-07-27"),
        logger,
      });

      for (const invalid of ["0", "07/27/2026", "2026-07-27"]) {
        await expect(validClockLedger.purgeExpired(invalid)).rejects.toThrow(
          /timestamp/,
        );
      }
      await expect(
        validClockLedger.purgeExpired(null as unknown as IsoTimestamp),
      ).rejects.toThrow(TypeError);
      await expect(invalidClockLedger.purgeExpired()).rejects.toThrow(
        TypeError,
      );
      expect(entries).toEqual([]);
      expect(tracked.calls).toEqual({
        insertIfAbsent: 0,
        update: 0,
        listVersioned: 0,
        deleteIfUnchanged: 0,
      });
      expect(
        await receipts.get(webhookReceiptKey("stripe", "evt_invalid_sweep")),
      ).not.toBeNull();
    });

    it("preserves a receipt touched after versioned listing", async () => {
      const base = freshStore();
      const direct = createWebhookLedger({
        store: base,
        source: "stripe",
        clock: fixedClock(NOW),
      });
      const receipts = base.collection(webhookReceiptCollection("stripe"));
      await receipts.put(
        receipt("evt_touch", { lastSeenAt: "2020-01-01T00:00:00.000Z" }),
      );
      const sweeping = createWebhookLedger({
        store: afterFirstList(base, () => direct.markProcessed("evt_touch")),
        source: "stripe",
        clock: fixedClock(NOW),
      });

      expect(await sweeping.purgeExpired()).toBe(0);
      expect(
        await receipts.get(webhookReceiptKey("stripe", "evt_touch")),
      ).toMatchObject({
        status: "processed",
        lastSeenAt: NOW,
      });
    });

    it("skips a corrupt listed event id and continues purging valid rows", async () => {
      const base = freshStore();
      const receipts = base.collection(webhookReceiptCollection("stripe"));
      await receipts.put(
        receipt("evt_valid_after_corrupt", {
          lastSeenAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      const entries: Array<{
        level: string;
        message: string;
        fields?: Readonly<Record<string, unknown>>;
      }> = [];
      const logger: Logger = {
        log(level, message, fields) {
          entries.push({
            level,
            message,
            ...(fields === undefined ? {} : { fields }),
          });
        },
      };
      const ledger = createWebhookLedger({
        store: withCorruptRowListedFirst(base),
        source: "stripe",
        clock: fixedClock(NOW),
        logger,
      });

      expect(await ledger.purgeExpired()).toBe(1);
      expect(
        await receipts.get(
          webhookReceiptKey("stripe", "evt_valid_after_corrupt"),
        ),
      ).toBeNull();
      expect(entries).toEqual([
        {
          level: "warn",
          message: "Webhook receipt sweep skipped corrupt row",
          fields: { source: "stripe" },
        },
        {
          level: "info",
          message: "Webhook receipt retention sweep completed",
          fields: { source: "stripe", purged: 1 },
        },
      ]);
    });

    it("logs quarantine and completed sweeps without payload fields", async () => {
      const entries: Array<{
        level: string;
        message: string;
        fields?: Readonly<Record<string, unknown>>;
      }> = [];
      const logger: Logger = {
        log(level, message, fields) {
          entries.push({
            level,
            message,
            ...(fields === undefined ? {} : { fields }),
          });
        },
      };
      const ledger = createWebhookLedger({
        store: freshStore(),
        source: "stripe",
        clock: fixedClock(NOW),
        logger,
      });
      for (let attempts = 1; attempts <= 8; attempts += 1) {
        await ledger.markFailed("evt_logged");
      }
      await ledger.purgeExpired(NOW);

      expect(entries).toEqual([
        {
          level: "warn",
          message: "Webhook receipt quarantined",
          fields: { source: "stripe", eventId: "evt_logged", attempts: 6 },
        },
        {
          level: "info",
          message: "Webhook receipt retention sweep completed",
          fields: { source: "stripe", purged: 0 },
        },
      ]);
      expect(JSON.stringify(entries)).not.toContain("payload");
    });

    it("propagates storage failures", async () => {
      const failure = new Error("backend unavailable");
      const ledger = createWebhookLedger({
        store: failingInsertStore(failure),
        source: "stripe",
      });
      await expect(ledger.begin("evt_error", "type")).rejects.toBe(failure);
    });
  });
}

ledgerConformance("webhook ledger / memory", createMemoryStore);
ledgerConformance("webhook ledger / Azure Tables", freshAzureStore);

describe("Azurite test lifecycle", () => {
  it("rejects when the child process cannot start", async () => {
    const missing = spawnChild(
      `missing-azurite-executable-${process.pid}-${Date.now()}`,
    );

    await expect(waitForStartup(missing, 65_534, 1_000)).rejects.toThrow();
  });

  it("allocates around an occupied loopback port", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not inspect the occupied test port.");
    }

    try {
      expect(await allocateAvailablePort()).not.toBe(address.port);
      expect(inject("azuriteTablePort")).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("does not mistake an unrelated listener for the spawned service", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not inspect the unrelated listener port.");
    }
    const unrelated = spawnChild(process.execPath, [
      "-e",
      "setTimeout(() => {}, 5000)",
    ]);

    try {
      await expect(
        waitForStartup(unrelated, address.port, 300),
      ).rejects.toThrow(/within 300ms/);
    } finally {
      unrelated.kill();
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});

describe("webhook receipt codec", () => {
  const codec = webhookReceiptCollection("stripe").codec;

  it("encodes exactly the six receipt fields and drops cast-in payload data", () => {
    const value = {
      ...receipt("evt_boundary"),
      payload: { customer: "secret" },
      source: "must-not-be-a-record-field",
    };

    expect(codec.encode(value)).toEqual({
      eventId: "evt_boundary",
      type: "provider.event",
      status: "new",
      attempts: 0,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
  });

  it("decodes unknown and malformed fields to safe values", () => {
    expect(
      codec.decode({
        eventId: "evt_junk",
        status: "unknown",
        attempts: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      eventId: "evt_junk",
      type: null,
      status: "new",
      attempts: 0,
      firstSeenAt: "",
      lastSeenAt: "",
    });
    expect(codec.decode({ attempts: -3.8 }).attempts).toBe(0);
    expect(codec.decode({ attempts: 2.8 }).attempts).toBe(2);
  });
});
