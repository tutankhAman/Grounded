import { resolve } from "node:path";
import { type ExtractJob, PARSE_QUEUE, type ParseJob } from "@grounded/db";
import { Queue } from "bullmq";
import dotenv from "dotenv";
import Redis from "ioredis";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const workerQueueConnection = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

export const documentProcessingQueue = new Queue<ParseJob | ExtractJob>(
  PARSE_QUEUE,
  {
    connection: workerQueueConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        delay: 2000,
        type: "exponential",
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  }
);

export const addExtractJob = async (job: ExtractJob): Promise<string> => {
  const result = await documentProcessingQueue.add("extract-document", job);
  return result.id ?? "";
};
