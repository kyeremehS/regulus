/**
 * Drizzle client — the app's single database connection.
 * Uses node-postgres Pool; safe across Next.js dev hot reloads via globalThis.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { __regulusPool?: Pool };

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env");
  }
  return new Pool({ connectionString, max: 10 });
}

const pool = globalForDb.__regulusPool ?? createPool();
if (process.env.NODE_ENV !== "production") globalForDb.__regulusPool = pool;

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
