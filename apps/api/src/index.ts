import { resolve } from "node:path";
import { cors } from "@elysiajs/cors";
import { db } from "@grounded/db";
import dotenv from "dotenv";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import Redis from "ioredis";
import { closeQueue } from "./lib/queue";
import { documentRoutes } from "./routes/documents";

dotenv.config({ path: resolve(import.meta.dirname, "../../../.env") });

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
  .group("/facts", (group) =>
    group.get("/", () => ({
      message: "Facts listing will be implemented in Phase 2 & 5",
    }))
  )
  .group("/entities", (group) =>
    group.get("/", () => ({
      message: "Entities listing will be implemented in Phase 3 & 5",
    }))
  );

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
    await Promise.allSettled([redis.quit(), closeQueue()]);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export type App = typeof app;
