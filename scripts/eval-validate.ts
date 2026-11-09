/**
 * Eval set validator — DESIGN.md §10.2 / §10 "spec and evaluability".
 *
 * Checks the eval files against the actual corpus so eval cases stay honest:
 *   - YAML parses; required fields present; enums valid; ids unique.
 *   - Every requiredChunk id exists in sources/enriched/ (content-addressed —
 *     a re-fetch that changes a document's hash will FAIL here, which is the
 *     point: requiredChunks must be re-verified after any re-ingest).
 *   - Every facts.yaml chunk id exists; every fact a case cites exists.
 *   - Coverage: all four §4 query types + at least one abstention case.
 *
 * Run: npx tsx scripts/eval-validate.ts        (or `npm run eval:validate`)
 * Pure CPU: no DB, no network, no API key.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const EVALS_DIR = path.join(ROOT, "evals");
const ENRICHED_DIR = path.join(ROOT, "sources", "enriched");

const QUERY_TYPES = new Set(["lookup", "synthesis", "calculation", "abstention", "adversarial"]);
const EXPECTS = new Set(["answer", "abstain", "answer+flag-conflict", "use-calculator"]);
const RISK_TIERS = new Set(["T1", "T2", "T3"]);

interface Fact {
  id: string;
  label: string;
  value: string;
  expected?: string[];
  chunks: string[];
  note?: string;
}

interface Case {
  id: string;
  question: string;
  queryType: string;
  riskTier: string;
  expect: string;
  reference: string;
  facts?: string[];
  requiredChunks: string[];
  tags: string[];
}

interface FactsFile {
  facts: Fact[];
}

interface GoldenFile {
  set: { id: string; name: string; version: string; corpusVersion: string };
  cases: Case[];
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- load corpus chunk ids ------------------------------------------------
  const corpusIds = new Set<string>();
  const enrichedFiles = await readdir(ENRICHED_DIR).catch(() => [] as string[]);
  if (enrichedFiles.length === 0) {
    errors.push(
      "sources/enriched/ is empty — run `npx tsx scripts/enrich.ts` before validating evals",
    );
  }
  for (const f of enrichedFiles.filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(await readFile(path.join(ENRICHED_DIR, f), "utf8")) as {
      chunks: { id: string }[];
    };
    for (const c of doc.chunks) corpusIds.add(c.id);
  }

  // --- facts.yaml -----------------------------------------------------------
  const factsDoc = parse(await readFile(path.join(EVALS_DIR, "facts.yaml"), "utf8")) as FactsFile;
  if (!factsDoc?.facts?.length) errors.push("facts.yaml: no facts found");
  const factIds = new Set<string>();
  for (const f of factsDoc.facts ?? []) {
    if (!f.id) errors.push("facts.yaml: fact missing id");
    else if (factIds.has(f.id)) errors.push(`facts.yaml: duplicate fact id ${f.id}`);
    else factIds.add(f.id);
    if (!f.value) errors.push(`facts.yaml: fact ${f.id} missing value`);
    for (const c of f.chunks ?? []) {
      if (enrichedFiles.length && !corpusIds.has(c)) {
        errors.push(`facts.yaml: fact ${f.id} references unknown chunk ${c}`);
      }
    }
  }

  // --- golden set -----------------------------------------------------------
  const golden = parse(
    await readFile(path.join(EVALS_DIR, "golden-v0.1.yaml"), "utf8"),
  ) as GoldenFile;
  if (!golden?.cases?.length) errors.push("golden-v0.1.yaml: no cases found");

  const caseIds = new Set<string>();
  const typeCounts = new Map<string, number>();
  for (const c of golden.cases ?? []) {
    const at = (m: string) => `case ${c.id || "?"}: ${m}`;
    if (!c.id) errors.push("case missing id");
    else if (caseIds.has(c.id)) errors.push(`duplicate case id ${c.id}`);
    else caseIds.add(c.id);
    if (!c.question?.trim()) errors.push(at("missing question"));
    if (!QUERY_TYPES.has(c.queryType)) errors.push(at(`invalid queryType "${c.queryType}"`));
    else typeCounts.set(c.queryType, (typeCounts.get(c.queryType) ?? 0) + 1);
    if (!EXPECTS.has(c.expect)) errors.push(at(`invalid expect "${c.expect}"`));
    if (!RISK_TIERS.has(c.riskTier)) errors.push(at(`invalid riskTier "${c.riskTier}"`));
    if (!c.reference?.trim()) errors.push(at("missing reference"));
    if (!Array.isArray(c.requiredChunks)) errors.push(at("requiredChunks must be a list"));
    for (const chunkId of c.requiredChunks ?? []) {
      if (enrichedFiles.length && !corpusIds.has(chunkId)) {
        errors.push(at(`requiredChunk not in corpus: ${chunkId}`));
      }
    }
    for (const factId of c.facts ?? []) {
      if (!factIds.has(factId)) errors.push(at(`unknown fact id ${factId}`));
    }
    // SPEC alignment: calculation questions must use the calculator; T3
    // questions may not be plain "answer" without a tool decision.
    if (c.queryType === "calculation" && c.expect !== "use-calculator") {
      errors.push(at("calculation cases must set expect: use-calculator (SPEC T3)"));
    }
    if (c.expect === "abstain" && (c.requiredChunks?.length ?? 0) > 0) {
      warnings.push(at("abstain case with requiredChunks — double-check intent"));
    }
    if (c.riskTier === "T3" && c.expect === "answer") {
      warnings.push(at("T3 case with expect: answer — verify tool requirements"));
    }
  }

  // --- coverage gates -------------------------------------------------------
  for (const t of ["lookup", "synthesis", "calculation", "abstention"]) {
    if (!typeCounts.get(t)) errors.push(`coverage: no "${t}" cases (DESIGN §4 requires all 4 types)`);
  }
  if (!typeCounts.get("adversarial")) warnings.push("coverage: no adversarial cases");

  // --- report ---------------------------------------------------------------
  for (const w of warnings) console.warn(`WARN ${w}`);
  for (const e of errors) console.error(`FAIL ${e}`);
  const summary = [...typeCounts.entries()].map(([t, n]) => `${t}=${n}`).join(" ");
  console.log(
    `\nfacts=${factIds.size} cases=${caseIds.size} [${summary}] · corpus chunks=${corpusIds.size}`,
  );
  console.log(errors.length ? `VALIDATION FAILED: ${errors.length} error(s)` : "eval set OK");
  process.exit(errors.length ? 1 : 0);
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
})();
if (isDirectRun) void main();
