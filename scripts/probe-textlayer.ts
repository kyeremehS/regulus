/**
 * Probe candidate PDF URLs for a usable text layer.
 * Usage: npx tsx scripts/probe-textlayer.ts <url> [url ...]
 * Prints text chars on the first 3 pages — 0 means scanned image (needs OCR).
 */
import { readFile } from "node:fs/promises";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = path.join(ROOT, "sources", "raw", "_probe");

async function probe(url: string): Promise<void> {
  let file: string;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.log(`HTTP ${res.status}  ${url}`);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(TMP, { recursive: true });
    file = path.join(TMP, `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
    await writeFile(file, buf);
    console.log(`downloaded ${(buf.byteLength / 1024).toFixed(0)} KB  ${url}`);
  } catch (err) {
    console.log(`DOWNLOAD FAIL  ${String((err as Error).message).slice(0, 80)}  ${url}`);
    return;
  }

  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await readFile(file));
    const doc = await pdfjs.getDocument({ data, disableFontFace: true }).promise;
    let total = 0;
    const sample: string[] = [];
    for (let p = 1; p <= Math.min(3, doc.numPages); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const text = tc.items.map((i: { str: string }) => i.str).join("");
      total += text.length;
      if (sample.length < 2 && text.trim()) sample.push(text.slice(0, 70).replace(/\s+/g, " "));
      page.cleanup();
    }
    const verdict = total > 200 ? "TEXT LAYER OK" : total > 0 ? "THIN/UNCERTAIN" : "SCANNED (no text)";
    console.log(`  pages=${doc.numPages} chars3pg=${total}  => ${verdict}`);
    if (sample.length) console.log(`  sample: "${sample[0]}"`);
    await doc.destroy?.();
  } catch (err) {
    console.log(`  PARSE FAIL  ${String((err as Error).message).slice(0, 100)}`);
  }
}

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error("usage: tsx scripts/probe-textlayer.ts <url> [url ...]");
    process.exit(1);
  }
  for (const url of urls) await probe(url);
}

main().catch((e) => {
  console.error(String(e).slice(0, 500));
  process.exit(1);
});
