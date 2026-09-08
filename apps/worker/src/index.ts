import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../../../.env') });

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const documentQueue = new Queue('document-processing', { connection });

export const documentWorker = new Worker(
  'document-processing',
  async (job) => {
    console.log(`Processing job ${job.id} of type ${job.name}...`);
    return { success: true };
  },
  { connection }
);

documentWorker.on('completed', (job) => {
  console.log(`Job ${job.id} has completed!`);
});

documentWorker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} has failed with ${err.message}`);
});

console.log('👷 worker ready — listening on queue: document-processing');

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down worker...');
  await documentWorker.close();
  await connection.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down worker...');
  await documentWorker.close();
  await connection.quit();
  process.exit(0);
});
