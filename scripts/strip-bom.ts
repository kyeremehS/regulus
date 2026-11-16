/**
 * Strip UTF-8 BOMs from generated migration files.
 * drizzle-kit generate has emitted .sql files with a leading BOM
 * (0xEF 0xBB 0xBF) on this Windows setup — PostgreSQL rejects a leading BOM
 * with a syntax error, and `drizzle-kit migrate` swallows the real error
 * behind its spinner (seen 2026-11-16). Runs after db:generate as a guard;
 * idempotent — files without a BOM are untouched.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function stripDir(dir: string): Promise<number> {
  let stripped = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stripped += await stripDir(full);
      continue;
    }
    if (!entry.name.endsWith(".sql") && !entry.name.endsWith(".json")) continue;
    const buf = await readFile(full);
    if (buf.length >= 3 && buf.subarray(0, 3).equals(BOM)) {
      await writeFile(full, buf.subarray(3));
      console.log(`BOM stripped: ${path.relative(ROOT, full)}`);
      stripped += 1;
    }
  }
  return stripped;
}

async function main(): Promise<void> {
  const n = await stripDir(MIGRATIONS_DIR);
  console.log(n ? `${n} file(s) de-BOM'd` : "no BOMs found");
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
})();
if (isDirectRun) void main();
