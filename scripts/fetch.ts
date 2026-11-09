/**
 * Stage 1: Fetch — DESIGN.md §5 step 1.
 * Downloads each manifest source, stores the raw copy under sources/raw/,
 * computes a content hash, and records it in the manifest.
 *
 * Terms-of-use gate: sources with termsChecked=false are reported but can be
 * fetched with --force-unverified (fetching for parse inspection is read-only
 * and fair-use-ish; INGESTING into the answer corpus still requires approval).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const RAW_DIR = path.join(ROOT, "sources", "raw");
const MANIFEST_PATH = path.join(ROOT, "sources", "manifest.json");

export interface Source {
  id: string;
  title: string;
  publisher: string;
  url: string;
  publishedAt: string | null;
  type: "pdf" | "html";
  termsChecked: boolean;
  termsNotes: string;
  status: "candidate" | "verified" | "fetched" | "ingested" | "rejected";
  contentHash: string | null;
  fetchedAt: string | null;
}

export interface Manifest {
  $comment: string;
  corpusVersion: string;
  sources: Source[];
}

export async function loadManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
}

export async function saveManifest(m: Manifest): Promise<void> {
  await writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n", "utf8");
}

const USER_AGENT =
  "RegulusIngest/0.1 (research corpus fetch; contact: github.com/kyeremehS/regulus)";

export interface FetchResult {
  id: string;
  ok: boolean;
  bytes?: number;
  sha256?: string;
  file?: string;
  reason?: string;
}

function extensionFor(type: Source["type"], url: string): string {
  if (type === "pdf") return ".pdf";
  try {
    const p = new URL(url).pathname;
    if (p.endsWith(".html") || p.endsWith(".htm")) return ".html";
  } catch {
    /* fall through */
  }
  return ".html";
}

export async function fetchSource(
  source: Source,
  opts: { forceUnverified?: boolean } = {},
): Promise<FetchResult> {
  if (!source.termsChecked && !opts.forceUnverified) {
    return { id: source.id, ok: false, reason: "terms not verified (use --force-unverified)" };
  }

  try {
    const res = await fetch(source.url, {
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return { id: source.id, ok: false, reason: `HTTP ${res.status}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const file = `${source.id}${extensionFor(source.type, source.url)}`;

    await mkdir(RAW_DIR, { recursive: true });
    await writeFile(path.join(RAW_DIR, file), buf);

    return { id: source.id, ok: true, bytes: buf.byteLength, sha256, file };
  } catch (err) {
    return { id: source.id, ok: false, reason: String((err as Error).message ?? err) };
  }
}

export async function runFetch(opts: { forceUnverified?: boolean } = {}): Promise<FetchResult[]> {
  const manifest = await loadManifest();
  const results: FetchResult[] = [];

  for (const source of manifest.sources) {
    const result = await fetchSource(source, opts);
    results.push(result);

    if (result.ok && result.sha256) {
      const target = manifest.sources.find((s) => s.id === source.id)!;
      target.contentHash = result.sha256;
      target.fetchedAt = new Date().toISOString();
      if (target.status === "candidate" || target.status === "verified") target.status = "fetched";
    }
    const label = result.ok
      ? `OK  ${result.id}  ${(result.bytes! / 1024).toFixed(0)} KB  sha256:${result.sha256!.slice(0, 12)}`
      : `FAIL ${result.id}  ${result.reason}`;
    console.log(label);
  }

  await saveManifest(manifest);
  return results;
}

// CLI: tsx scripts/fetch.ts [--force-unverified]
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
})();
if (isDirectRun) {
  const forceUnverified = process.argv.includes("--force-unverified");
  runFetch({ forceUnverified }).then((results) => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} fetched`);
    process.exit(failed.length === results.length ? 1 : 0);
  });
}
