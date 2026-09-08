import { resolve } from "node:path";
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
  if (pubRedis.status === "wait") {
    pubRedis.connect().catch(() => {
      // Ignored: best-effort connection
    });
  }
  pubRedis
    .publish(`doc:${documentId}:status`, JSON.stringify(event))
    .catch(() => {
      // Ignored: fire-and-forget
    });
};
