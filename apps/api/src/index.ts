import { resolve } from "node:path";
import { cors } from "@elysiajs/cors";
import {
  type DocumentProgressEvent,
  type DocumentStatus,
  db,
  documents,
  eq,
} from "@grounded/db";
import dotenv from "dotenv";
import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import Redis from "ioredis";
import { isTerminalStatus } from "./lib/events";
import {
  closePubSub,
  subscribeToDocument,
  unsubscribeFromDocument,
} from "./lib/pubsub";
import { closeQueue } from "./lib/queue";
import { documentRoutes } from "./routes/documents";
import { entityRoutes } from "./routes/entities";
import { factRoutes } from "./routes/facts";
import { relationshipRoutes } from "./routes/relationships";

dotenv.config({ path: resolve(import.meta.dirname, "../../../.env") });

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const port = Number(process.env.PORT) || 3000;
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

export const app = new Elysia()
  .use(cors())
  .decorate("db", db)
  .decorate("redis", redis)
  // Health check endpoint verifying DB (Postgres) and Redis connectivity
  .get("/health", async ({ set }) => {
    let pgOk = false;
    let redisOk = false;

    try {
      await db.execute(sql`SELECT 1`);
      pgOk = true;
    } catch (e) {
      console.error("Postgres health check failed:", e);
      pgOk = false;
    }

    try {
      if (redis.status === "wait") {
        await redis.connect();
      }
      const pong = await redis.ping();
      redisOk = pong === "PONG";
    } catch (e) {
      console.error("Redis health check failed:", e);
      redisOk = false;
    }

    const healthy = pgOk && redisOk;
    if (!healthy) {
      set.status = 503;
    }

    return {
      pg: pgOk,
      redis: redisOk,
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
    };
  })
  // Root summary endpoint
  .get("/", () => ({
    name: "Grounded Fact Knowledge Layer API",
    status: "running",
    version: "0.1.0",
  }))
  .use(documentRoutes)
  .use(factRoutes)
  .use(entityRoutes)
  .use(relationshipRoutes)
  .ws("/documents/:id/status", {
    async close(ws) {
      const documentId = ws.data.params?.id;
      if (documentId && UUID_REGEX.test(documentId)) {
        await unsubscribeFromDocument(documentId, ws);
      }
    },
    async open(ws) {
      const documentId = ws.data.params.id;
      if (!UUID_REGEX.test(documentId)) {
        ws.send(JSON.stringify({ error: "Invalid document ID format" }));
        // 4400 is an application-specific WebSocket close code for bad request UUID
        ws.close(4400, "Invalid document UUID");
        return;
      }

      // Subscribe to Redis pubsub BEFORE querying the DB snapshot to prevent
      // a race condition where a status event published during the query is dropped.
      // A failed subscription is surfaced (never ghosted): the socket is only
      // useful with live delivery, so close it with an actionable code.
      const subscribed = await subscribeToDocument(documentId, ws);
      if (!subscribed) {
        ws.send(
          JSON.stringify({
            error: "Live updates unavailable — reconnect to retry",
          })
        );
        ws.close(4413, "Subscription unavailable");
        return;
      }

      const [doc] = await db
        .select({
          errorMessage: documents.errorMessage,
          pageCount: documents.pageCount,
          status: documents.status,
        })
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      if (!doc) {
        await unsubscribeFromDocument(documentId, ws);
        ws.send(JSON.stringify({ error: `Document ${documentId} not found` }));
        // 4404 is an application-specific WebSocket close code for missing resource
        ws.close(4404, "Document not found");
        return;
      }

      const isDone = doc.status === "done";
      const initialEvent: DocumentProgressEvent = {
        errorMessage: doc.errorMessage,
        progress: {
          current: isDone ? (doc.pageCount ?? 1) : 0,
          total: doc.pageCount ?? 1,
        },
        status: doc.status as DocumentStatus,
      };
      ws.send(JSON.stringify(initialEvent));

      if (isTerminalStatus(doc.status)) {
        await unsubscribeFromDocument(documentId, ws);
        ws.close(1000, "Document in terminal state");
      }
    },
    params: t.Object({
      id: t.String(),
    }),
  });

if (import.meta.main) {
  const maxUploadMb = Number(process.env.MAX_UPLOAD_MB) || 100;
  const maxRequestBodySize = maxUploadMb * 1024 * 1024;

  app.listen({
    maxRequestBodySize,
    port,
  });
  console.log(
    `🦊 Elysia API is running at http://${app.server?.hostname}:${app.server?.port}`
  );

  const shutdown = async () => {
    console.log("Shutting down API server...");
    await Promise.allSettled([redis.quit(), closeQueue(), closePubSub()]);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export type App = typeof app;
