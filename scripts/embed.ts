/**
 * Stage 5: Embed — DESIGN.md §5 step 5.
 * Loads the enriched corpus, embeds every chunk through the gateway
 * (`openai/text-embedding-3-small` via OpenRouter — decided 2026-11-26; see
 * gateway DEFAULT_MODELS), and writes documents + chunks into Postgres:
 * vectors into the pgvector column, plus the full-text GIN index for keyword
 * search (used by Phase 3 hybrid retrieval).
 *
 * Versioning (§5 step 6): chunk IDs are content-addressed, so re-ingesting
 * changed content yields new IDs while old rows are marked supersededAt —
 * never deleted. Re-running this script with unchanged content is idempotent
 * (upserts on the same IDs).
 *
 * Terms-of-use gate (§5): every manifest source must have termsChecked=true
 * before its chunks enter the answer corpus. Override only with
 * --force-unverified, mirroring fetch.ts (which fetches read-only; THIS
 * script ingests, so the gate is a hard fail by default).
 *
 * Run: npm run embed [-- --force-unverified]
 */
import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents, EMBEDDING_DIMENSIONS } from "../db/schema";
import { embedTexts, resolveEmbedModelId } from "../lib/gateway";
import { loadManifest } from "./fetch";
import type { EnrichedFile } from "./enrich";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENRICHED_DIR = path.join(ROOT, "sources", "enriched");

/** Embedding batch size (texts per gateway call). */
const BATCH = 64;
/** DB insert batch size (rows per INSERT). */
const INSERT_BATCH = 128;

async function loadEnriched(): Promise<EnrichedFile[]> {
  const files = (await readdir(ENRICHED_DIR)).filter((f) => f.endsWith(".json"));
  return Promise.all(
    files.map(async (f) =>
      JSON.parse(await readFile(path.join(ENRICHED_DIR, f), "utf8")) as EnrichedFile,
    ),
  );
}

function toDate(iso: string | null): Date | null {
  return iso ? new Date(iso) : null;
}

async function main() {
  const forceUnverified = process.argv.includes("--force-unverified");
  const manifest = await loadManifest();
  const corpusVersion = manifest.corpusVersion;
  const modelId = resolveEmbedModelId();

  const enriched = await loadEnriched();
  if (enriched.length === 0) {
    console.error("FAIL: sources/enriched/ is empty — run enrich.ts first");
    process.exit(1);
  }

  // --- Gates -----------------------------------------------------------------
  // Only fetched/ingested sources belong in the answer corpus; candidates are
  // pending fetch + terms review and are skipped by every gate below.
  const INGESTIBLE = new Set(["fetched", "ingested"]);
  const corpusSources = manifest.sources.filter((s) => INGESTIBLE.has(s.status));
  const candidates = manifest.sources.filter((s) => !INGESTIBLE.has(s.status));
  const enrichedIds = new Set(enriched.map((e) => e.docId));
  const missing = corpusSources.filter((s) => !enrichedIds.has(s.id));
  if (missing.length > 0) {
    console.error(
      `FAIL: manifest sources without an enriched file: ${missing.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
  }
  const stale = enriched.filter((e) => e.corpusVersion !== corpusVersion);
  if (stale.length > 0) {
    console.error(
      `FAIL: corpusVersion drift — manifest=${corpusVersion} but enriched has ` +
        `${stale.map((e) => `${e.docId}=${e.corpusVersion}`).join(", ")}. Re-run enrich.ts.`,
    );
    process.exit(1);
  }
  const unchecked = corpusSources.filter((s) => !s.termsChecked);
  if (unchecked.length > 0 && !forceUnverified) {
    console.error(
      `FAIL: terms-of-use gate — ${unchecked.length}/${corpusSources.length} ingestible sources have ` +
        `termsChecked=false (§5/D3): ${unchecked.map((s) => s.id).join(", ")}.\n` +
        `Review each source's terms of use/licensing, flip termsChecked: true in ` +
        `sources/manifest.json, and re-run. (Escape hatch: --force-unverified.)`,
    );
    process.exit(1);
  }
  const totalChunks = enriched.reduce((n, e) => n + e.chunks.length, 0);
  const ids = new Set<string>();
  for (const e of enriched) {
    for (const c of e.chunks) {
      if (ids.has(c.id)) {
        console.error(`FAIL: duplicate chunk id ${c.id}`);
        process.exit(1);
      }
      ids.add(c.id);
    }
  }
  console.log(
    `corpus v${corpusVersion}: ${enriched.length} docs, ${totalChunks} chunks, model=${modelId} (${EMBEDDING_DIMENSIONS}d)` +
      (candidates.length > 0 ? ` [${candidates.length} manifest candidates pending fetch/terms — skipped]` : "") +
      (unchecked.length > 0
        ? ` [--force-unverified: ingesting ${unchecked.length} terms-unchecked sources]`
        : ""),
  );

  // --- Embed (gateway handles retries/timeout/accounting) --------------------
  const texts = enriched.flatMap((e) => e.chunks.map((c) => c.text));
  const vectors: number[][] = [];
  let embedTokens = 0;
  let embedCost = 0;
  const embedStart = Date.now();
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const r = await embedTexts({ texts: batch, corpusVersion, promptVersion: "embed@1.0.0" });
    const dim = r.vectors[0]?.length;
    if (dim !== EMBEDDING_DIMENSIONS) {
      console.error(
        `FAIL: embedding drift — model ${r.model} returned ${dim} dims, schema expects ` +
          `${EMBEDDING_DIMENSIONS}. Change EMBEDDING_DIMENSIONS + migrate, or pick a matching MODEL_EMBED.`,
      );
      process.exit(1);
    }
    vectors.push(...r.vectors);
    embedTokens += r.usage.totalTokens;
    embedCost += r.costUsd;
    console.log(
      `  embedded ${Math.min(i + batch.length, texts.length)}/${texts.length} ` +
        `(tokens=${embedTokens}, cost=$${embedCost.toFixed(6)})`,
    );
  }
  const embedMs = Date.now() - embedStart;
  console.log(
    `embed done: ${embedTokens} tok, $${embedCost.toFixed(6)}, ${(embedMs / 1000).toFixed(1)}s`,
  );

  // --- Documents upsert ---------------------------------------------------------
  for (const e of enriched) {
    await db
      .insert(documents)
      .values({
        id: e.document.id,
        title: e.document.title,
        sourceUrl: e.document.sourceUrl,
        publisher: e.document.publisher,
        publishedAt: toDate(e.document.publishedAt),
        contentHash: e.document.contentHash,
      })
      .onConflictDoUpdate({
        target: documents.id,
        set: {
          title: e.document.title,
          sourceUrl: e.document.sourceUrl,
          publisher: e.document.publisher,
          publishedAt: toDate(e.document.publishedAt),
          contentHash: e.document.contentHash,
        },
      });
  }
  console.log(`documents upserted: ${enriched.length}`);

  // --- Supersede (§5 step 6): live chunks not in the new set ---------------------
  const existing = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(isNull(chunks.supersededAt));
  const toSupersede = existing.map((r) => r.id).filter((id) => !ids.has(id));
  if (toSupersede.length > 0) {
    await db
      .update(chunks)
      .set({ supersededAt: new Date() })
      .where(inArray(chunks.id, toSupersede));
  }
  console.log(
    `superseded: ${toSupersede.length}` +
      (toSupersede.length > 0 ? " (content changed since last ingest)" : ""),
  );

  // --- Chunks upsert with vectors -------------------------------------------------
  let vi = 0; // vectors were pushed in the same order as texts
  const rows = enriched.flatMap((e) =>
    e.chunks.map((c) => ({
      id: c.id,
      documentId: c.documentId,
      sectionPath: c.sectionPath,
      text: c.text,
      pageNumber: c.pageNumber,
      tokenCount: c.tokenCount,
      embedding: vectors[vi++],
    })),
  );
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    await db
      .insert(chunks)
      .values(batch)
      .onConflictDoUpdate({
        target: chunks.id,
        set: {
          sectionPath: sql`excluded.section_path`,
          text: sql`excluded.text`,
          pageNumber: sql`excluded.page_number`,
          tokenCount: sql`excluded.token_count`,
          embedding: sql`excluded.embedding`,
          supersededAt: sql`null`,
        },
      });
  }
  console.log(`chunks upserted: ${rows.length}`);

  // --- Full-text search index (Phase 3 keyword leg, built now) ---------------------
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (to_tsvector('english', text))`,
  );
  const { rows: countRows } = await db.execute<{ embedded: number }>(
    sql`SELECT count(*)::int AS embedded FROM chunks WHERE embedding IS NOT NULL AND superseded_at IS NULL`,
  );
  console.log(
    `fts index: chunks_fts_idx (gin, english) — live chunks with vectors: ${countRows[0].embedded}`,
  );
  console.log(
    `STAGE 5 PASS: ${rows.length} chunks, ${embedTokens} tokens, $${embedCost.toFixed(6)}`,
  );
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  const cause = (err as { cause?: unknown })?.cause;
  if (cause) console.error("CAUSE:", cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
  process.exit(1);
});
