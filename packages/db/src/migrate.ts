import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../../../.env') });

const connectionString = process.env.DATABASE_URL || 'postgresql://grounded:grounded@localhost:5432/grounded';

async function runMigrations() {
  console.log('Running database migrations...');
  const migrationClient = postgres(connectionString, { max: 1 });

  try {
    // 1. Ensure vector extension is enabled before anything else
    console.log('Ensuring pgvector extension exists...');
    await migrationClient`CREATE EXTENSION IF NOT EXISTS vector;`;
    console.log('pgvector extension enabled.');

    // 2. Run drizzle migrations
    const db = drizzle(migrationClient);
    const migrationsFolder = resolve(__dirname, '../drizzle');
    console.log(`Applying migrations from: ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log('Database migrations applied successfully.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await migrationClient.end();
  }
}

runMigrations();
