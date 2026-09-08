import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Try loading .env if not already set
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: resolve(__dirname, '../../../.env') });
}

const connectionString = process.env.DATABASE_URL || 'postgresql://grounded:grounded@localhost:5432/grounded';

// For queries, use max 10 connections for Bun
export const queryClient = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });

export type Database = typeof db;
