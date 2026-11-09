/**
 * Stage 4: Enrich — DESIGN.md §5 step 4.
 * Attaches document metadata (title, publisher, source URL, effective date,
 * content hash, terms status) to every chunk and assigns stable,
 * content-addressed chunk IDs (`<docId>:<hash8>:<index>`), so that:
 *   - re-running this stage is idempotent (same inputs → same IDs), and
 *   - re-ingesting changed content produces new IDs while old chunks are
 *     marked superseded, never deleted (§5 step 6).
 * Also validates the corpus before the embed stage (missing docs, stale
 * chunk files, empty chunks, duplicate IDs) and flags sources whose terms
 * are still unchecked — enrichment is read-only prep; ingest into the
 * ANSWER corpus stays blocked until terms are confirmed (§5).
 *
 * Inputs: sources/manifest.json, sources/chunks/*.json, sources/parsed/*.md
 * Output: sources/enriched/<doc-id>.json (derived — gitignored; regenerate
 * with `npx tsx scripts/enrich.ts`).
 * Pure CPU: no DB, no network.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, type Source } from "./fetch";
import type { Chunk } from "./chunk";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHUNKS_DIR = path.join(ROOT, "sources", "chunks");
const PARSED_DIR = path.join(ROOT, "sources", "parsed");
const ENRICHED_DIR = path.join(ROOT, "sources", "enriched");

/** Citation-ready passage: SPEC §search result shape + chunking internals. */
export interface EnrichedChunk {
  /** Stable, content-addressed: `<docId>:<hash8>:<chunkIndex>`. */
  id: string;
  documentId: string;
  chunkIndex: number;
  sectionPath: string;
  sectionTitle: string;
  text: string;
  tokenCount: number;
  /** Page the chunk starts on (maps to chunks.page_number; pageEnd for display). */
  pageNumber: number;
  pageStart: number;
  pageEnd: number;
  effectiveDate: string | null;
  sourceUrl: string;
}

export interface EnrichedDocument {
  id: string;
  title: string;
  publisher: string;
  sourceUrl: string;
  publishedAt: string | null;
  effectiveDate: string | null;
  /** "assent" = DATE OF ASSENT printed in the act; "published" = manifest fallback. */
  effectiveDateSource: "assent" | "published" | null;
  contentHash: string;
  termsChecked: boolean;
}

export interface EnrichedFile {
  docId: string;
  corpusVersion: string;
  document: EnrichedDocument;
  chunks: EnrichedChunk[];
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * First "DATE OF ASSENT: 1st September, 2015" line in the parsed dump →
 * ISO date. That line is the act's own cover-page convention (first match in
 * the file = the document's own date, before any body citations).
 */
function parseAssentDate(parsed: string): string | null {
  const m = parsed.match(
    /DATE OF ASSENT:?\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s*(\d{4})/i,
  );
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  const day = Number(m[1]);
  if (!month || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface EnrichResult {
  docs: number;
  chunks: number;
  errors: string[];
  warnings: string[];
}

export async function runEnrich(ids?: string[]): Promise<EnrichResult> {
  const manifest = await loadManifest();
  await mkdir(ENRICHED_DIR, { recursive: true });

  const chunkFiles = new Set(await readdir(CHUNKS_DIR));
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  let docCount = 0;
  let chunkCount = 0;

  for (const source of manifest.sources) {
    if (ids && !ids.includes(source.id)) continue;
    try {
      const result = await enrichOne(source, manifest.corpusVersion, chunkFiles, seenIds, warnings);
      if (!result) continue;
      docCount += 1;
      chunkCount += result.chunks;
      console.log(
        `OK  ${source.id}  chunks=${result.chunks} tokens≈${result.tokens} ` +
          `effective=${result.effectiveDate ?? "?"} (${result.effectiveDateSource ?? "none"}) ` +
          `terms=${source.termsChecked ? "checked" : "UNCHECKED"}`,
      );
    } catch (err) {
      errors.push(`${source.id}: ${(err as Error).message}`);
    }
  }

  // Terms gate: enrichment is read-only prep (like fetch/parse), but the
  // ANSWER corpus ingest stays blocked until terms are confirmed (DESIGN §5).
  const unchecked = manifest.sources.filter((s) => !s.termsChecked).length;
  if (unchecked) {
    warnings.push(
      `${unchecked}/${manifest.sources.length} sources termsChecked=false — enrichment OK, ` +
        `but ingest into the ANSWER corpus stays blocked until terms are confirmed (DESIGN §5)`,
    );
  }

  return { docs: docCount, chunks: chunkCount, errors, warnings };
}

async function enrichOne(
  source: Source,
  corpusVersion: string,
  chunkFiles: Set<string>,
  seenIds: Set<string>,
  warnings: string[],
): Promise<{ chunks: number; tokens: number; effectiveDate: string | null; effectiveDateSource: EnrichedDocument["effectiveDateSource"] } | null> {
  const file = `${source.id}.json`;
  if (!chunkFiles.has(file)) {
    throw new Error(`no chunks file — run \`npx tsx scripts/chunk.ts\` first`);
  }
  if (!source.contentHash) {
    throw new Error(`manifest has no contentHash — run \`npx tsx scripts/fetch.ts\` first`);
  }

  const raw = JSON.parse(await readFile(path.join(CHUNKS_DIR, file), "utf8")) as {
    docId: string;
    title: string;
    chunks: Chunk[];
  };
  if (raw.docId !== source.id) {
    throw new Error(`chunks file docId "${raw.docId}" does not match manifest id`);
  }
  if (raw.title !== source.title) {
    throw new Error(`title changed since chunking — re-run \`npx tsx scripts/chunk.ts\``);
  }

  // Effective date: the assent date printed in the act, else manifest
  // publishedAt. Consolidated acts carry the BASE act's assent date (their
  // "as amended" currency lives in the amendments document) — noted as a
  // known limitation in progress.md.
  let effectiveDate: string | null = null;
  let effectiveDateSource: EnrichedDocument["effectiveDateSource"] = null;
  try {
    const parsed = await readFile(path.join(PARSED_DIR, `${source.id}.md`), "utf8");
    effectiveDate = parseAssentDate(parsed);
    if (effectiveDate) effectiveDateSource = "assent";
  } catch {
    // parsed dump missing — fall through to publishedAt
  }
  if (!effectiveDate && source.publishedAt) {
    effectiveDate = source.publishedAt;
    effectiveDateSource = "published";
  }
  if (!effectiveDate) {
    warnings.push(`${source.id}: no effective date (no DATE OF ASSENT, no publishedAt)`);
  }

  const hash8 = source.contentHash.slice(0, 8);
  const chunks: EnrichedChunk[] = [];
  for (const c of raw.chunks) {
    if (!c.text.trim()) throw new Error(`chunk #${c.chunkIndex} has empty text`);
    if (!c.sectionPath) throw new Error(`chunk #${c.chunkIndex} has no sectionPath`);
    if (c.pageStart < 1) throw new Error(`chunk #${c.chunkIndex} has bad pageStart ${c.pageStart}`);
    if (c.approxTokens <= 0) throw new Error(`chunk #${c.chunkIndex} has bad tokenCount`);
    const id = `${source.id}:${hash8}:${c.chunkIndex}`;
    if (seenIds.has(id)) throw new Error(`duplicate chunk id ${id}`);
    seenIds.add(id);
    chunks.push({
      id,
      documentId: source.id,
      chunkIndex: c.chunkIndex,
      sectionPath: c.sectionPath,
      sectionTitle: c.sectionTitle,
      text: c.text,
      tokenCount: c.approxTokens,
      pageNumber: c.pageStart,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      effectiveDate,
      sourceUrl: source.url,
    });
  }

  const document: EnrichedDocument = {
    id: source.id,
    title: source.title,
    publisher: source.publisher,
    sourceUrl: source.url,
    publishedAt: source.publishedAt,
    effectiveDate,
    effectiveDateSource,
    contentHash: source.contentHash,
    termsChecked: source.termsChecked,
  };

  await writeFile(
    path.join(ENRICHED_DIR, file),
    JSON.stringify(
      { docId: source.id, corpusVersion, document, chunks } satisfies EnrichedFile,
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return {
    chunks: chunks.length,
    tokens: chunks.reduce((s, c) => s + c.tokenCount, 0),
    effectiveDate,
    effectiveDateSource,
  };
}

// CLI: npx tsx scripts/enrich.ts [id ...]
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
})();
if (isDirectRun) {
  const ids = process.argv.slice(2);
  runEnrich(ids.length ? ids : undefined).then(({ docs, chunks, errors, warnings }) => {
    for (const w of warnings) console.warn(`WARN ${w}`);
    for (const e of errors) console.error(`FAIL ${e}`);
    console.log(`\n${docs} docs → ${chunks} enriched chunks → sources/enriched/*.json`);
    process.exit(errors.length ? 1 : 0);
  });
}
