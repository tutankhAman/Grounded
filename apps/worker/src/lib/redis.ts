import { resolve } from "node:path";
import { waitForRedisReady } from "@grounded/db";
import dotenv from "dotenv";
import Redis from "ioredis";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const pubRedis = new Redis(redisUrl, {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

export type { DocumentProgressEvent } from "@grounded/db";

export const publishDocumentProgress = (
  documentId: string,
  event: import("@grounded/db").DocumentProgressEvent
): void => {
  // Fire-and-forget by design (worker never awaits WS delivery), but no
  // longer silent: wait for a ready connection (covers the first publish
  // racing client startup and concurrent publishes during reconnects),
  // and log failures so dropped progress is visible in worker logs.
  // Fire-and-forget by design (worker never awaits WS delivery). The inner
  // try/catch reports every failure path, so the trailing catch only guards
  // the floating promise itself and is unreachable in practice.
  const pendingPublish = (async (): Promise<void> => {
    try {
      if (pubRedis.status === "wait" || pubRedis.status === "close") {
        pubRedis.connect().catch(() => {
          // Readiness is verified below; a failed kickoff just means waiting.
        });
      }
      if (!(await waitForRedisReady(pubRedis))) {
        console.warn(
          `[redis] progress publish skipped for ${documentId}: client not ready (status=${pubRedis.status})`
        );
        return;
      }
      await pubRedis.publish(`doc:${documentId}:status`, JSON.stringify(event));
    } catch (err: unknown) {
      console.warn(
        `[redis] progress publish failed for ${documentId}:`,
        err instanceof Error ? err.message : err
      );
    }
  })();
  pendingPublish.catch(() => {
    // Unreachable: every path above is handled. Guards the float.
  });
};
