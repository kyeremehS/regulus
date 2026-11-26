/**
 * Retrieval — naive single-call RAG baseline (DESIGN.md §7), kept FOREVER as
 * the comparison point for every later agent/retrieval upgrade (§8 golden
 * rule). Embeds the query through the gateway, takes top-k vector matches
 * from pgvector over live (non-superseded) chunks, and assembles a context
 * block with stable [S1]…[Sn] IDs under a fixed token budget.
 *
 * Phase 3 will ADD hybrid search + reranking on top; this module's output
 * shape is the contract evaluators measure.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { embedTexts } from "./gateway";

/** Vector matches per query (§7 top-k). */
export const TOP_K = 8;
/** Fixed context budget in tokens — passages are admitted in similarity order. */
export const CONTEXT_BUDGET_TOKENS = 3_200;

export interface Passage {
  /** Stable display id used in the answer text: S1, S2, … (similarity order). */
  sid: string;
  /** chunks.id — content-addressed; this is what /api/sources/:id resolves. */
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sectionPath: string;
  text: string;
  pageNumber: number | null;
  sourceUrl: string;
  tokenCount: number;
  similarity: number;
}

export interface Retrieved {
  passages: Passage[];
  queryTokens: number;
  queryCostUsd: number;
  latencyMs: number;
}

/** Corpus version logged with every call (§5.6 / §9). Read from the manifest. */
let corpusVersionCache: string | null = null;
export async function manifestCorpusVersion(): Promise<string> {
  if (corpusVersionCache) return corpusVersionCache;
  try {
    const raw = await readFile(path.join(process.cwd(), "sources", "manifest.json"), "utf8");
    corpusVersionCache = (JSON.parse(raw) as { corpusVersion: string }).corpusVersion;
  } catch {
    console.warn(
      JSON.stringify({
        event: "corpus.manifest_missing",
        note: "sources/manifest.json unreadable — corpus version falls back to 0.1.0",
        ts: new Date().toISOString(),
      }),
    );
    corpusVersionCache = "0.1.0";
  }
  return corpusVersionCache;
}

/**
 * Top-k vector retrieval. `embedding <=> '…'` is pgvector cosine distance;
 * similarity = 1 - distance.
 */
export async function retrieve(question: string): Promise<Retrieved> {
  const startedAt = Date.now();
  const corpusVersion = await manifestCorpusVersion();
  const embed = await embedTexts({
    texts: [question],
    corpusVersion,
    promptVersion: "query-embed@1.0.0",
  });
  const queryVector = `[${embed.vectors[0].join(",")}]`;

  const { rows } = await db.execute<{
    id: string;
    document_id: string;
    document_title: string;
    source_url: string;
    section_path: string;
    text: string;
    page_number: number | null;
    token_count: number;
    similarity: number;
  }>(sql`
    SELECT c.id, c.document_id, d.title AS document_title, d.source_url,
           c.section_path, c.text, c.page_number, c.token_count,
           1 - (c.embedding <=> ${queryVector}::vector) AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.superseded_at IS NULL
    ORDER BY c.embedding <=> ${queryVector}::vector
    LIMIT ${TOP_K}
  `);

  // Fixed budget, passages ordered by relevance; always admit at least one.
  const passages: Passage[] = [];
  let budget = CONTEXT_BUDGET_TOKENS;
  rows.forEach((r, i) => {
    if (passages.length > 0 && r.token_count > budget) return;
    budget -= r.token_count;
    passages.push({
      sid: `S${i + 1}`,
      chunkId: r.id,
      documentId: r.document_id,
      documentTitle: r.document_title,
      sectionPath: r.section_path,
      text: r.text,
      pageNumber: r.page_number,
      sourceUrl: r.source_url,
      tokenCount: r.token_count,
      similarity: Number(r.similarity),
    });
  });

  return {
    passages,
    queryTokens: embed.usage.totalTokens,
    queryCostUsd: embed.costUsd,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * The prompt payload: delimited data blocks (§9 injection defense) with
 * citation ids, section paths and page numbers for the answer contract.
 */
export function assembleContext(passages: Passage[]): string {
  return passages
    .map(
      (p) =>
        `<source id="${p.sid}" document="${p.documentTitle}" section="${p.sectionPath}"` +
        (p.pageNumber ? ` page="${p.pageNumber}"` : "") +
        `>\n${p.text}\n</source>`,
    )
    .join("\n\n");
}
