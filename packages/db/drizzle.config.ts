import { resolve } from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://grounded:grounded@localhost:5432/grounded",
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema.ts",
  strict: true,
  verbose: true,
});
