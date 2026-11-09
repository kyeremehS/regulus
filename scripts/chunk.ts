/**
 * Stage 3: Chunk — DESIGN.md §5 step 3.
 * Splits parsed documents on legal structure (Part/Section/Subsection) with a
 * 300–600 token fallback window + overlap, and prefixes each chunk with its
 * section path (`VAT Act > Part II > Section 7`) so embeddings and citations
 * both carry hierarchy.
 *
 * Output: sources/chunks/<doc-id>.json — inspection dump for the gate.
 * DB writes happen later (needs DATABASE_URL); this stage is pure CPU.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./fetch";
import type { ParsedBlock } from "./parse";

const ROOT = path.resolve(import.meta.dirname, "..");
const PARSED_DIR = path.join(ROOT, "sources", "parsed");
const CHUNKS_DIR = path.join(ROOT, "sources", "chunks");

export interface Chunk {
  docId: string;
  chunkIndex: number;
  /** e.g. "Income Tax Act, 2015 (Act 896) > PART II > Section 4" */
  sectionPath: string;
  /** Heading text of the owning section ("" at doc level) */
  sectionTitle: string;
  text: string;
  approxTokens: number;
  pageStart: number;
  pageEnd: number;
}

const TARGET_TOKENS = 450;
const MAX_TOKENS = 600;
const OVERLAP_TOKENS = 50;

/** Rough token estimate: ~4 chars/token for legal English. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Section {
  level: number; // 0 = doc, 1 = PART/CHAPTER, 2 = Section, 3 = subsection-ish
  title: string;
  blocks: ParsedBlock[];
}

/**
 * Hierarchy depth for a heading. Ghanaian acts nest up to four tiers:
 * Chapter → Part → Division → Section (title-case or numbered).
 * Schedules and ALL-CAPS labels sit near the top.
 */
function headingLevel(text: string): number {
  if (/^(chapter|schedule)\b/i.test(text) || /^(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)\s+SCHEDULE\b/i.test(text)) return 1;
  if (/^part\b/i.test(text)) return 2;
  if (/^division\b/i.test(text)) return 3;
  if (/^\d+(\.\d+)*\.?\s+\S/.test(text)) return 4; // "12. Liability of members"
  if (/^(section|subsection)\s+\d/i.test(text)) return 4;
  // ALL-CAPS standalone label (e.g. "IMPOSITION OF INCOME TAX") = part-level tag.
  if (text === text.toUpperCase() && /[A-Z]/.test(text)) return 2;
  return 4; // title-case section titles from the parser's context pass
}

/** Walk blocks, grouping into sections keyed by heading structure. */
function buildSections(blocks: ParsedBlock[]): Section[] {
  const sections: Section[] = [{ level: 0, title: "", blocks: [] }];
  const stack: Section[] = [sections[0]];

  for (const b of blocks) {
    if (b.kind === "heading") {
      const level = headingLevel(b.text);
      // Close stack down to the last section with a lower level.
      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const section: Section = { level, title: b.text, blocks: [b] };
      sections.push(section);
      stack.push(section);
    } else {
      stack[stack.length - 1].blocks.push(b);
    }
  }
  return sections;
}

/**
 * Split a run of blocks into chunks: prefer cutting at sentence boundaries
 * near the token target, never exceeding MAX, with OVERLAP carried forward.
 */
function chunkBlocks(
  blocks: ParsedBlock[],
  makePath: (section: Section) => string,
  section: Section,
  startIndex: { n: number },
  docId: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let pageStart = 0;
  let overlapCarry = "";

  const flush = (pageEnd: number) => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    chunks.push({
      docId,
      chunkIndex: startIndex.n++,
      sectionPath: makePath(section),
      sectionTitle: section.title,
      text,
      approxTokens: currentTokens,
      pageStart: pageStart || section.blocks[0]?.page || 1,
      pageEnd,
    });
    current = [];
    currentTokens = 0;
  };

  for (const b of blocks) {
    if (!pageStart) pageStart = b.page;
    const tokens = approxTokens(b.text);

    // Hard split oversized single blocks (long subsections) at sentence bounds.
    if (tokens > MAX_TOKENS) {
      for (const piece of splitLongText(b.text)) {
        pushPiece(piece, b.page);
      }
      continue;
    }
    pushPiece(b.text, b.page);
  }

  function pushPiece(text: string, page: number) {
    const tokens = approxTokens(text);
    if (currentTokens + tokens > MAX_TOKENS && currentTokens >= TARGET_TOKENS * 0.6) {
      // Keep a small overlap: carry the tail of the flushed chunk forward.
      const joined = current.join(" ");
      overlapCarry = tailTokens(joined, OVERLAP_TOKENS);
      flush(page);
      if (overlapCarry) {
        current = [overlapCarry];
        currentTokens = approxTokens(overlapCarry);
        if (pageStart === 0) pageStart = page;
      }
    }
    current.push(text);
    currentTokens += tokens;
  }

  const lastBlock = blocks[blocks.length - 1];
  flush(lastBlock?.page ?? 1);
  return chunks;
}

/** Split text longer than MAX_TOKENS at sentence boundaries. */
function splitLongText(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const pieces: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (approxTokens(buf + s) > MAX_TOKENS && buf) {
      pieces.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) pieces.push(buf.trim());
  return pieces;
}

/** Last ~N tokens of a string, cut at a word boundary. */
function tailTokens(text: string, n: number): string {
  const chars = n * 4;
  if (text.length <= chars) return text;
  const tail = text.slice(-chars);
  const spaceIdx = tail.indexOf(" ");
  return spaceIdx > 0 ? tail.slice(spaceIdx + 1) : tail;
}

interface ParsedFile {
  id: string;
  title: string;
  blocks: ParsedBlock[];
}

export async function runChunk(ids?: string[]): Promise<{ docId: string; chunks: Chunk[] }[]> {
  const manifest = await loadManifest();
  await mkdir(CHUNKS_DIR, { recursive: true });

  const files = await readdir(PARSED_DIR);
  const results: { docId: string; chunks: Chunk[] }[] = [];

  for (const source of manifest.sources) {
    if (ids && !ids.includes(source.id)) continue;
    const file = files.find((f) => f === `${source.id}.md`);
    if (!file) continue;

    const raw = await readFile(path.join(PARSED_DIR, file), "utf8");
    const blocks = parseInspectionDump(raw);
    if (blocks.length === 0) continue;

    const sections = buildSections(blocks);
    const chunks: Chunk[] = [];
    let index = 0;

    for (const section of sections) {
      if (section.blocks.length === 0) continue;
      const sectionPath = makeSectionPath(source.title, section, sections);
      const made = chunkBlocks(section.blocks, () => sectionPath, section, { n: index }, source.id);
      index += made.length;
      chunks.push(...made);
    }

    await writeFile(
      path.join(CHUNKS_DIR, `${source.id}.json`),
      JSON.stringify({ docId: source.id, title: source.title, chunks }, null, 2),
      "utf8",
    );
    results.push({ docId: source.id, chunks });
    const tokens = chunks.reduce((s, c) => s + c.approxTokens, 0);
    console.log(
      `OK  ${source.id}  sections=${sections.length} chunks=${chunks.length} tokens≈${tokens}`,
    );
  }

  return results;
}

/** Rebuild the section-path string by walking the section's ancestry. */
function makeSectionPath(docTitle: string, section: Section, all: Section[]): string {
  // Sections were built in document order; ancestry = nearest preceding
  // sections with strictly lower level.
  const idx = all.indexOf(section);
  const parts: string[] = [section.title];
  let lastLevel = section.level;
  for (let i = idx - 1; i >= 0 && parts.length < 4; i--) {
    const s = all[i];
    if (s.level < lastLevel) {
      parts.unshift(s.title);
      lastLevel = s.level;
      if (s.level === 0) break;
    }
  }
  return [docTitle, ...parts.filter(Boolean)].join(" > ");
}

/** Parse the inspection dump back into blocks (single source of truth = .md). */
export function parseInspectionDump(markdown: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let page = 1;
  for (const line of markdown.split(/\r?\n/)) {
    const pageMatch = line.match(/^===== PAGE (\d+) =====$/);
    if (pageMatch) {
      page = Number(pageMatch[1]);
      continue;
    }
    const headingMatch = line.match(/^# \[p(\d+) fs=[\d.]+\] (.*)$/);
    if (headingMatch) {
      blocks.push({ page: Number(headingMatch[1]), kind: "heading", text: headingMatch[2], fontSize: 0 });
      continue;
    }
    if (!line.trim() || line.startsWith("# PARSE") || line.startsWith("Document:") ||
        line.startsWith("ID:") || line.startsWith("Source:") || line.startsWith("Published:") ||
        line.startsWith("Content hash:") || line.startsWith("Pages:") ||
        line.startsWith("REVIEW") || line.startsWith("  [ ]") || line.startsWith("---")) {
      continue;
    }
    blocks.push({ page, kind: "body", text: line.trim(), fontSize: 0 });
  }
  return blocks;
}

// CLI: npx tsx scripts/chunk.ts [id ...]
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
})();
if (isDirectRun) {
  const ids = process.argv.slice(2);
  runChunk(ids.length ? ids : undefined).then((results) => {
    const total = results.reduce((s, r) => s + r.chunks.length, 0);
    console.log(`\n${results.length} docs → ${total} chunks → sources/chunks/*.json`);
    process.exit(results.length === 0 ? 1 : 0);
  });
}
