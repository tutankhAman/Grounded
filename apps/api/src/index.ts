import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import Redis from 'ioredis';
import { db } from '@grounded/db';
import { sql } from 'drizzle-orm';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../../../.env') });

const port = Number(process.env.PORT) || 3000;
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

export const app = new Elysia()
  .use(cors())
  .decorate('db', db)
  .decorate('redis', redis)
  // Health check endpoint verifying DB (Postgres) and Redis connectivity
  .get('/health', async ({ set }) => {
    let pgOk = false;
    let redisOk = false;

    try {
      await db.execute(sql`SELECT 1`);
      pgOk = true;
    } catch (e) {
      console.error('Postgres health check failed:', e);
      pgOk = false;
    }

    try {
      if (redis.status === 'wait') {
        await redis.connect();
      }
      const pong = await redis.ping();
      redisOk = pong === 'PONG';
    } catch (e) {
      console.error('Redis health check failed:', e);
      redisOk = false;
    }

    const healthy = pgOk && redisOk;
    if (!healthy) {
      set.status = 503;
    }

    return {
      status: healthy ? 'ok' : 'degraded',
      pg: pgOk,
      redis: redisOk,
      timestamp: new Date().toISOString(),
    };
  })
  // Root summary endpoint
  .get('/', () => ({
    name: 'Grounded Fact Knowledge Layer API',
    version: '0.1.0',
    status: 'running',
  }))
  // Placeholder route groups for subsequent phases
  .group('/documents', (app) =>
    app.get('/', () => ({ message: 'Document listing will be implemented in Phase 1' }))
  )
  .group('/facts', (app) =>
    app.get('/', () => ({ message: 'Facts listing will be implemented in Phase 2 & 5' }))
  )
  .group('/entities', (app) =>
    app.get('/', () => ({ message: 'Entities listing will be implemented in Phase 3 & 5' }))
  )
  .listen(port);

console.log(`🦊 Elysia API is running at http://${app.server?.hostname}:${app.server?.port}`);

export type App = typeof app;
