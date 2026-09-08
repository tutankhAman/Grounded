import { resolve } from "node:path";
import {
  type ExtractJob,
  PARSE_QUEUE,
  type ParseJob,
  type ReconcileJob,
  type ResolveJob,
} from "@grounded/db";
import { Worker } from "bullmq";
import dotenv from "dotenv";
import Redis from "ioredis";
import { processExtractJob } from "./consumers/extract";
import { processParseJob } from "./consumers/parse";
import { processReconcileJob } from "./consumers/reconcile";
import { processResolveJob } from "./consumers/resolve";
import { pubRedis } from "./lib/redis";

dotenv.config({ path: resolve(import.meta.dirname, "../../../.env") });

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const documentWorker = new Worker<
  ParseJob | ExtractJob | ResolveJob | ReconcileJob
>(
  PARSE_QUEUE,
  async (job) => {
    console.log(
      `[Worker] Started job ${job.id} (${job.name}) for document ${job.data.documentId}`
    );
    if (job.name === "parse-pdf") {
      const result = await processParseJob(job.data as ParseJob);
      console.log(
        `[Worker] Finished job ${job.id} — parsed ${result.totalPages} pages (${result.totalChunks} chunks)`
      );
      return result;
    }
    if (job.name === "extract-document") {
      const result = await processExtractJob(job.data as ExtractJob);
      console.log(
        `[Worker] Finished job ${job.id} — extracted ${result.factsExtracted} facts (${result.chunksFailed} chunks failed)`
      );
      return result;
    }
    if (job.name === "resolve-document") {
      const result = await processResolveJob(job.data as ResolveJob);
      console.log(
        `[Worker] Finished job ${job.id} — resolved ${result.entitiesResolved} entities (${result.factsLinked} facts linked)`
      );
      return result;
    }
    if (job.name === "reconcile-document") {
      const result = await processReconcileJob(job.data as ReconcileJob);
      console.log(
        `[Worker] Finished job ${job.id} — matched ${result.factsMatched} facts, evaluated ${result.pairsEvaluated} pairs (rule: ${result.ruleResolved}, judge: ${result.judgeCalls}), created ${result.relationshipsCreated} relationships`
      );
      return result;
    }
    return { success: true };
  },
  {
    concurrency: 3,
    connection,
  }
);

documentWorker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed successfully`);
});

documentWorker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
});

console.log(`👷 worker ready — listening on queue: ${PARSE_QUEUE}`);

const shutdown = async (signal: string) => {
  console.log(
    `[Worker] ${signal} received. Closing worker and Redis connections...`
  );
  const shutdownTimer = setTimeout(() => {
    console.error(
      "[Worker] Shutdown deadline exceeded (10s). Forcing termination."
    );
    process.exit(1);
  }, 10_000);
  shutdownTimer.unref();

  try {
    await documentWorker.close();
    await pubRedis.quit();
    await connection.quit();
    clearTimeout(shutdownTimer);
    console.log("[Worker] Graceful shutdown completed.");
    process.exit(0);
  } catch (err) {
    clearTimeout(shutdownTimer);
    console.error("[Worker] Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
