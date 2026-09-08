import { resolve } from "node:path";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Try loading .env if not already set
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: resolve(import.meta.dirname, "../../../.env") });
}

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://grounded:grounded@localhost:5432/grounded";

// For queries, use max 10 connections for Bun
export const queryClient = postgres(connectionString, {
  connect_timeout: 10,
  idle_timeout: 20,
  max: 10,
});

export const db = drizzle(queryClient, { schema });

export type Database = typeof db;
