/** Diagnostic: is a PDF text-based or a scanned image? */
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx scripts/diagnose.ts <raw-file>");
    process.exit(1);
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(path.join(ROOT, "sources", "raw", file)));
  const doc = await pdfjs.getDocument({ data, disableFontFace: true }).promise;

  console.log(`pages: ${doc.numPages}`);
  for (let p = 1; p <= Math.min(3, doc.numPages); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const ops = await page.getOperatorList();
    const images = ops.fnArray.filter(
      (f: number) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject,
    ).length;
    const text = tc.items
      .map((i) => ("str" in i ? i.str : ""))
      .join("");
    console.log(
      `p${p}: items=${tc.items.length} textChars=${text.length} imagePaints=${images} sample="${text.slice(0, 80).replace(/\s+/g, " ")}"`,
    );
  }
}

main().catch((e) => {
  console.error(String(e).slice(0, 500));
  process.exit(1);
});
