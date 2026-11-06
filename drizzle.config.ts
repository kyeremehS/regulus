import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Drizzle Kit config — migrations generated from db/schema.ts.
// DATABASE_URL comes from .env (loaded via dotenv in package.json scripts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: {
    url: (() => {
      const url = process.env.DATABASE_URL;
      if (!url) {
        throw new Error(
          "DATABASE_URL is not set — copy .env.example to .env and fill it in",
        );
      }
      return url;
    })(),
  },
  strict: true,
  verbose: true,
});
