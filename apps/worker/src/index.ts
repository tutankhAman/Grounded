import { resolve } from "node:path";
import { PARSE_QUEUE, type ParseJob } from "@grounded/db";
import { Worker } from "bullmq";
import dotenv from "dotenv";
import Redis from "ioredis";
import { processParseJob, pubRedis } from "./consumers/parse";

dotenv.config({ path: resolve(import.meta.dirname, "../../../.env") });

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const documentWorker = new Worker<ParseJob>(
  PARSE_QUEUE,
  async (job) => {
    console.log(
      `[Worker] Started job ${job.id} (${job.name}) for document ${job.data.documentId}`
    );
    if (job.name === "parse-pdf") {
      const result = await processParseJob(job.data);
      console.log(
        `[Worker] Finished job ${job.id} — parsed ${result.totalPages} pages (${result.totalChunks} chunks)`
      );
      return result;
    }
    return { success: true };
  },
  {
    concurrency: 2,
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
  try {
    await documentWorker.close();
    await pubRedis.quit();
    await connection.quit();
    console.log("[Worker] Graceful shutdown completed.");
    process.exit(0);
  } catch (err) {
    console.error("[Worker] Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
