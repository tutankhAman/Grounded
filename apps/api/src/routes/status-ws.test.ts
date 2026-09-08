import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  type DocumentProgressEvent,
  db,
  documents,
  eq,
  sql,
} from "@grounded/db";
import Redis from "ioredis";
import { closePubSub, getSubscriberCount } from "../lib/pubsub";

mock.module("../lib/queue", () => ({
  addParseJob: mock(async () => "mock-job-id"),
  closeQueue: mock(async () => {
    // No-op queue close in unit tests
  }),
}));

const { app } = await import("../index");

let dbAvailable = false;
try {
  await db.execute(sql`SELECT 1`);
  dbAvailable = true;
} catch {
  console.warn("⚠️ Skipping status WS tests: Postgres is not reachable.");
  dbAvailable = false;
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
let testRedisPublisher: Redis;

describe.skipIf(!dbAvailable)("WS /documents/:id/status", () => {
  let server: ReturnType<typeof app.listen>;
  let port: number;
  let pendingDocId: string;
  let doneDocId: string;

  beforeAll(async () => {
    testRedisPublisher = new Redis(redisUrl, { lazyConnect: true });
    await testRedisPublisher.connect();

    // Start Elysia on ephemeral port
    server = app.listen(0);
    port = server.server?.port as number;

    // Seed pending document
    const [pDoc] = await db
      .insert(documents)
      .values({
        filename: "live_status_test.pdf",
        filePath: "/tmp/live_status_test.pdf",
        pageCount: 3,
        status: "pending",
      })
      .returning();
    pendingDocId = pDoc.id;

    // Seed done document
    const [dDoc] = await db
      .insert(documents)
      .values({
        filename: "completed_doc.pdf",
        filePath: "/tmp/completed_doc.pdf",
        pageCount: 10,
        status: "done",
      })
      .returning();
    doneDocId = dDoc.id;
  });

  afterAll(async () => {
    if (server) {
      server.stop();
    }
    await closePubSub();
    if (testRedisPublisher) {
      await testRedisPublisher.quit();
    }
    if (pendingDocId) {
      await db.delete(documents).where(eq(documents.id, pendingDocId));
    }
    if (doneDocId) {
      await db.delete(documents).where(eq(documents.id, doneDocId));
    }
  });

  it("rejects invalid document UUID with 4400 close code", async () => {
    const ws = new WebSocket(
      `ws://localhost:${port}/documents/not-a-uuid/status`
    );

    const closePromise = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        ws.onclose = (event) => {
          resolve({ code: event.code, reason: event.reason });
        };
      }
    );

    const { code } = await closePromise;
    expect(code).toBe(4400);
  });

  it("closes with 4404 when document does not exist", async () => {
    const ws = new WebSocket(
      `ws://localhost:${port}/documents/00000000-0000-0000-0000-000000000000/status`
    );

    const closePromise = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        ws.onclose = (event) => {
          resolve({ code: event.code, reason: event.reason });
        };
      }
    );

    const { code } = await closePromise;
    expect(code).toBe(4404);
  });

  it("sends initial snapshot and closes with 1000 for terminal (done) document", async () => {
    const ws = new WebSocket(
      `ws://localhost:${port}/documents/${doneDocId}/status`
    );

    const messages: DocumentProgressEvent[] = [];
    const messagePromise = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        messages.push(JSON.parse(String(event.data)));
        resolve();
      };
    });

    const closePromise = new Promise<number>((resolve) => {
      ws.onclose = (event) => {
        resolve(event.code);
      };
    });

    await messagePromise;
    const code = await closePromise;

    expect(messages.length).toBe(1);
    expect(messages[0].status).toBe("done");
    expect(messages[0].progress.current).toBe(10);
    expect(messages[0].progress.total).toBe(10);
    expect(code).toBe(1000);
  });

  it("sends snapshot and forwards live Redis events to active document", async () => {
    const ws = new WebSocket(
      `ws://localhost:${port}/documents/${pendingDocId}/status`
    );

    const messages: DocumentProgressEvent[] = [];

    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        messages.push(JSON.parse(String(event.data)));
        resolve();
      };
    });

    // 1. Initial snapshot received
    expect(messages.length).toBe(1);
    expect(messages[0].status).toBe("pending");
    expect(messages[0].progress.current).toBe(0);
    expect(messages[0].progress.total).toBe(3);

    // Wait briefly for Redis subscribe registration to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(getSubscriberCount(pendingDocId)).toBe(1);

    // 2. Publish live progress event via Redis
    const liveEvent: DocumentProgressEvent = {
      progress: { current: 1, total: 3 },
      stage: "extract",
      status: "extracting",
    };

    const nextMessagePromise = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        messages.push(JSON.parse(String(event.data)));
        resolve();
      };
    });

    const t0 = Date.now();
    await testRedisPublisher.publish(
      `doc:${pendingDocId}:status`,
      JSON.stringify(liveEvent)
    );

    await nextMessagePromise;
    expect(Date.now() - t0).toBeLessThan(2000);

    expect(messages.length).toBe(2);
    expect(messages[1].status).toBe("extracting");
    expect(messages[1].stage).toBe("extract");
    expect(messages[1].progress.current).toBe(1);

    // 3. Close connection and verify clean unsubscription
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(getSubscriberCount(pendingDocId)).toBe(0);
  });

  it("closes with 1000 after delivering a terminal event (no error, no leak)", async () => {
    const ws = new WebSocket(
      `ws://localhost:${port}/documents/${pendingDocId}/status`
    );

    const messages: DocumentProgressEvent[] = [];

    // Snapshot first
    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        messages.push(JSON.parse(String(event.data)));
        resolve();
      };
    });
    expect(messages[0].status).toBe("pending");

    // Terminal event must be delivered AND followed by a clean close —
    // the client must never show a reconnect error for a finished pipeline.
    const terminalEvent: DocumentProgressEvent = {
      progress: { current: 3, total: 3 },
      stage: "extract",
      status: "done",
    };

    const terminalMessagePromise = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        const payload = JSON.parse(String(event.data));
        // Snapshot assertion errors carry { error }; terminal events don't.
        if (!("error" in payload)) {
          messages.push(payload);
          resolve();
        }
      };
    });
    const closePromise = new Promise<number>((resolve) => {
      ws.onclose = (event) => {
        resolve(event.code);
      };
    });

    await testRedisPublisher.publish(
      `doc:${pendingDocId}:status`,
      JSON.stringify(terminalEvent)
    );

    await terminalMessagePromise;
    const code = await closePromise;

    expect(messages.at(-1)?.status).toBe("done");
    expect(code).toBe(1000);
    expect(getSubscriberCount(pendingDocId)).toBe(0);
  });
});
