import { resolve } from "node:path";
import { Queue } from "bullmq";
import dotenv from "dotenv";
import Redis from "ioredis";
import {
  type ExtractJob,
  PARSE_QUEUE,
  type ParseJob,
  RECONCILE_JOB_NAME,
  RESOLVE_JOB_NAME,
  type ReconcileJob,
  type ResolveJob,
} from "./jobs";

dotenv.config({ path: resolve(import.meta.dirname, "../../../.env") });

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const queueConnection = new Redis(redisUrl, {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

export const documentProcessingQueue = new Queue<
  ParseJob | ExtractJob | ResolveJob | ReconcileJob
>(PARSE_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      delay: 2000,
      type: "exponential",
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

export const parseQueue = documentProcessingQueue;

export const addParseJob = async (job: ParseJob): Promise<string> => {
  const result = await documentProcessingQueue.add("parse-pdf", job);
  return result.id ?? "";
};

export const addExtractJob = async (job: ExtractJob): Promise<string> => {
  const result = await documentProcessingQueue.add("extract-document", job);
  return result.id ?? "";
};

export const addResolveJob = async (job: ResolveJob): Promise<string> => {
  const result = await documentProcessingQueue.add(RESOLVE_JOB_NAME, job);
  return result.id ?? "";
};

export const addReconcileJob = async (job: ReconcileJob): Promise<string> => {
  const result = await documentProcessingQueue.add(RECONCILE_JOB_NAME, job);
  return result.id ?? "";
};

export const closeQueue = async (): Promise<void> => {
  await documentProcessingQueue.close();
  queueConnection.disconnect();
};
