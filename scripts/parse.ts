/**
 * Stage 2: Parse — DESIGN.md §5 step 2.
 * Extracts text from fetched PDFs while PRESERVING STRUCTURE (headings, section
 * numbers, page numbers). This is the project's #1 risk (§19), so the output of
 * this stage is a human-readable dump for inspection (the parse gate).
 *
 * Strategy: pdfjs-dist gives per-item text with font size + boldness. Legal
 * documents set headings in larger/bolder type than body copy, so we detect
 * heading lines by comparing each item's font size against the document's
 * dominant (body) size.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadManifest } from "./fetch";

const ROOT = path.resolve(import.meta.dirname, "..");
const RAW_DIR = path.join(ROOT, "sources", "raw");
const PARSED_DIR = path.join(ROOT, "sources", "parsed");

export interface TextItem {
  str: string;
  transform: number[]; // [a, b, c, d, e, f] — a = x scale, f = y position
  width: number;
  height: number;
  hasEOL: boolean;
}

export interface ParsedBlock {
  page: number;
  kind: "heading" | "body";
  text: string;
  fontSize: number;
}

export interface ParsedDocument {
  id: string;
  title: string;
  sourceUrl: string;
  publishedAt: string | null;
  contentHash: string | null;
  pageCount: number;
  bodyFontSize: number;
  blocks: ParsedBlock[];
  headingCount: number;
}

/** Load pdfjs (legacy build works under Node/tsx). */
async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Suppress worker warnings: we run with workers disabled (Node, no DOM).
  return pdfjs;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function parsePdf(
  filePath: string,
): Promise<{ blocks: ParsedBlock[]; pageCount: number; bodyFontSize: number }> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await readFile(filePath));

  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    // pdfjs needs the bundled standard font data to resolve Type1/TrueType
    // fonts used by scanned-era government PDFs; without it, glyphs vanish.
    standardFontDataUrl: new URL(
      "../node_modules/pdfjs-dist/standard_fonts/",
      import.meta.url,
    ).toString(),
  }).promise;

  const raw: Omit<ParsedBlock, "kind">[] = [];
  const sizes: number[] = [];
  const pageCount = doc.numPages;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    // Group items into visual lines by their y position (transform[5]).
    const lines = new Map<number, { items: TextItem[]; y: number }>();
    for (const item of content.items as TextItem[]) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5]);
      const key = y;
      const entry = lines.get(key) ?? { items: [], y };
      entry.items.push(item);
      lines.set(key, entry);
    }

    const sorted = [...lines.values()].sort((a, b) => b.y - a.y); // top → bottom
    for (const line of sorted) {
      line.items.sort((a, b) => a.transform[4] - b.transform[4]); // left → right
      const text = line.items.map((i) => i.str).join("").replace(/\s+/g, " ").trim();
      if (!text) continue;

      // Font size ≈ max item height on the line (handles mixed runs).
      const fontSize = Math.max(...line.items.map((i) => Math.abs(i.height) || 0));
      if (fontSize > 0) sizes.push(fontSize);

      raw.push({ page: p, text, fontSize });
    }
    page.cleanup();
  }

  await (doc as { destroy?: () => Promise<void> }).destroy?.();

  // Body size = median font size (robust against big headings/footers).
  const bodyFontSize = median(sizes);

  // Drop the "Arrangement of Sections" table of contents: it duplicates every
  // section title with zero content, which created thousands of empty fake
  // sections downstream (caught at the gate 2026-11-09).
  const kept = stripRunningHeaders(stripTableOfContents(raw), pageCount);

  const blocks = kept.map((b) => ({
    ...b,
    kind: isHeading(b.text, b.fontSize, bodyFontSize) ? ("heading" as const) : ("body" as const),
  }));

  // Context pass: acts print the section title on its own line directly above
  // the numbered section text ("Imposition of tax" / "1.(1) There is imposed…").
  // The title is plain body-size title case, so promote it when the NEXT line
  // opens a numbered section. Without this, whole sections got no path.
  for (let i = 0; i < blocks.length - 1; i++) {
    const b = blocks[i];
    const next = blocks[i + 1];
    if (b.kind !== "body" || next.kind !== "body") continue;
    if (b.text.length > 60 || /[.;,]$/.test(b.text) || !/^[A-Z]/.test(b.text)) continue;
    if (b.text.split(/\s+/).length > 8) continue;
    // Next line opens a numbered section: "1.(1) There is imposed…", "3.Except…"
    if (!/^\d+\./.test(next.text)) continue;
    b.kind = "heading";
  }

  return { blocks, pageCount, bodyFontSize };
}

/**
 * Drop running headers/footers/page numbers: short lines repeated verbatim on
 * a large share of pages ("Act992", "GRA", standalone page numbers). They were
 * being classified as headings and became section parents (caught at the gate).
 * Also collapses immediately-consecutive duplicate lines (double-printed runs).
 */
function stripRunningHeaders(
  raw: { page: number; text: string; fontSize: number }[],
  pageCount: number,
) {
  const pagesByText = new Map<string, Set<number>>();
  for (const b of raw) {
    if (b.text.length > 60) continue;
    const set = pagesByText.get(b.text) ?? new Set<number>();
    set.add(b.page);
    pagesByText.set(b.text, set);
  }
  const threshold = Math.max(3, Math.ceil(pageCount * 0.25));
  const isHeader = (t: string) => (pagesByText.get(t)?.size ?? 0) >= threshold;

  const out: typeof raw = [];
  for (const b of raw) {
    if (isHeader(b.text)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.page === b.page && prev.text === b.text) continue; // double-print
    out.push(b);
  }
  return out;
}

/**
 * Remove the TOC region: from an "ARRANGEMENT OF SECTIONS" heading up to the
 * point where the act re-states its long title ("AN ACT to …"), which marks
 * where real content begins. If the marker never appears, strip nothing —
 * never risk eating body text (the gate would catch a leftover TOC).
 */
function stripTableOfContents(raw: { page: number; text: string; fontSize: number }[]) {
  const start = raw.findIndex((b) => /arrangement of sections/i.test(b.text));
  if (start === -1) return raw;
  for (let i = start + 1; i < raw.length; i++) {
    // No trailing \b: some PDFs render it "AN ACTto" (missing space).
    if (/\bAN\s+ACT/i.test(raw[i].text)) {
      return [...raw.slice(0, start), ...raw.slice(i)];
    }
  }
  return raw;
}

/**
 * Heading heuristics for legal text. Junk guards come first: wrapped prose
 * fragments ("and", "place;", "Health.", "Schedule undersection 38 (1);")
 * must never become headings regardless of font size — at the gate they
 * showed up as section parents of whole chunks (2026-11-09).
 */
function isHeading(text: string, fontSize: number, bodyFontSize: number): boolean {
  if (text.length > 110) return false;
  // Sentence-ending punctuation ⇒ prose, not a title. Numbered headings exempt.
  if (/[;,]$/.test(text)) return false;
  if (/\.$/.test(text) && !/^\d+\s*\./.test(text)) return false;

  const size = fontSize > 0 ? fontSize : bodyFontSize;
  const biggerThanBody = size >= bodyFontSize + 1.5;

  // Case-SENSITIVE keywords. Both title case ("Part II") and the ALL-CAPS
  // form acts actually print ("PART II", "CHAPTER ONE") must match; lowercase
  // body lines ("section 51, the application…") must not.
  const headingPattern =
    /^(Part|Chapter|Division|Schedule|Interpretation|ARRANGEMENT)\b|^(PART|CHAPTER|DIVISION|SCHEDULE)\b/;
  const sectionKeyword = /^(Section|Subsection)\s+\d/; // "Section 7" but not "section 51, the ..."
  const numberedPattern = /^\d+(\.\d+)*\.?\s+[A-Z]/; // "12. Liability of members"
  const actPattern = /^Act\s+\d+/; // "Act 896" — not prose "Act and an agreement…"

  if (headingPattern.test(text) || sectionKeyword.test(text)) return true;
  if (numberedPattern.test(text) && size >= bodyFontSize) return true;
  if (actPattern.test(text)) return true;
  // Bigger-than-body must still look like a title: starts capitalized.
  if (biggerThanBody && /^[A-Z]/.test(text)) return true;

  return false;
}

/** Render a parsed document to an inspection dump (the parse gate artifact). */
export function renderInspection(doc: ParsedDocument): string {
  const lines: string[] = [];
  lines.push(`# PARSE INSPECTION DUMP`);
  lines.push(`Document: ${doc.title}`);
  lines.push(`ID: ${doc.id}`);
  lines.push(`Source: ${doc.sourceUrl}`);
  lines.push(`Published: ${doc.publishedAt ?? "unknown"}`);
  lines.push(`Content hash: ${doc.contentHash ?? "unknown"}`);
  lines.push(`Pages: ${doc.pageCount}  |  Body font size: ${doc.bodyFontSize.toFixed(1)}  |  Blocks: ${doc.blocks.length}  |  Headings detected: ${doc.headingCount}`);
  lines.push("");
  lines.push("REVIEW CHECKLIST (§5 gate):");
  lines.push("  [ ] Section numbers present (e.g. '7.', '12.1')?");
  lines.push("  [ ] Headings identified (marked with #) look right?");
  lines.push("  [ ] Tables readable, or at least not scrambled nonsense?");
  lines.push("  [ ] Page numbers retained?");
  lines.push("  [ ] No obvious OCR garbage / missing glyph blocks?");
  lines.push("  [ ] Text order matches reading order?");
  lines.push("");
  lines.push("---".repeat(20));
  lines.push("");

  let lastPage = 0;
  for (const b of doc.blocks) {
    if (b.page !== lastPage) {
      lines.push("");
      lines.push(`===== PAGE ${b.page} =====`);
      lines.push("");
      lastPage = b.page;
    }
    if (b.kind === "heading") {
      lines.push(`# [p${b.page} fs=${b.fontSize.toFixed(1)}] ${b.text}`);
    } else {
      lines.push(b.text);
    }
  }
  return lines.join("\n");
}

export async function runParse(ids?: string[]): Promise<ParsedDocument[]> {
  const manifest = await loadManifest();
  await mkdir(PARSED_DIR, { recursive: true });

  const rawFiles = await readdir(RAW_DIR).catch(() => [] as string[]);
  const results: ParsedDocument[] = [];

  for (const source of manifest.sources) {
    if (ids && !ids.includes(source.id)) continue;

    const file = rawFiles.find((f) => f.startsWith(source.id + "."));
    if (!file) continue;

    const ext = path.extname(file).toLowerCase();
    try {
      if (ext === ".pdf") {
        const { blocks, pageCount, bodyFontSize } = await parsePdf(path.join(RAW_DIR, file));
        const parsed: ParsedDocument = {
          id: source.id,
          title: source.title,
          sourceUrl: source.url,
          publishedAt: source.publishedAt,
          contentHash: source.contentHash ?? createHash("sha256").update(file).digest("hex"),
          pageCount,
          bodyFontSize,
          blocks,
          headingCount: blocks.filter((b) => b.kind === "heading").length,
        };
        await writeFile(path.join(PARSED_DIR, `${source.id}.md`), renderInspection(parsed), "utf8");
        results.push(parsed);
        console.log(
          `OK  ${source.id}  pages=${pageCount} blocks=${blocks.length} headings=${parsed.headingCount} bodyFS=${bodyFontSize.toFixed(1)}`,
        );
      } else {
        // HTML: strip tags crudely but keep block boundaries (still needs inspection).
        const html = await readFile(path.join(RAW_DIR, file), "utf8");
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, "\n\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        const blocks: ParsedBlock[] = text
          .split(/\n{2,}/)
          .filter((t) => t.trim())
          .map((t) => ({ page: 1, kind: "body" as const, text: t.trim(), fontSize: 0 }));
        const parsed: ParsedDocument = {
          id: source.id,
          title: source.title,
          sourceUrl: source.url,
          publishedAt: source.publishedAt,
          contentHash: source.contentHash ?? null,
          pageCount: 1,
          bodyFontSize: 0,
          blocks,
          headingCount: 0,
        };
        await writeFile(path.join(PARSED_DIR, `${source.id}.md`), renderInspection(parsed), "utf8");
        results.push(parsed);
        console.log(`OK  ${source.id}  html blocks=${blocks.length} (heading detection: n/a)`);
      }
    } catch (err) {
      console.log(`FAIL ${source.id}  ${String((err as Error).message ?? err).slice(0, 120)}`);
    }
  }

  return results;
}

// CLI: npx tsx scripts/parse.ts [id ...]
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
})();
if (isDirectRun) {
  const ids = process.argv.slice(2);
  runParse(ids.length ? ids : undefined).then((docs) => {
    console.log(`\n${docs.length} parsed → sources/parsed/*.md (inspect these!)`);
    process.exit(docs.length === 0 ? 1 : 0);
  });
}
