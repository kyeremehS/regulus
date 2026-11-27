/**
 * Phase 2 smoke report + first golden run — DESIGN §10.2/§10.5.
 * Runs every golden eval case through the EXACT naive pipeline the app uses
 * (same retrieve → same prompt → same gateway) and scores it with code-only
 * evaluators (§10: objective checks now; LLM judges only after human labeling).
 *
 * Per-case scores (persisted to eval_results.scores jsonb):
 *   retrieval  — requiredChunks recalled by top-k (Recall@8 subsystem metric)
 *   citations  — every [S#] in the answer maps to a retrieved passage
 *   abstention — abstain/answer contract per the case's `expect`
 *   facts      — facts.yaml expected patterns matched in the answer (exact match)
 *   calculator — `use-calculator` cases (naive baseline has no tool → measured gap)
 *
 * Case-level `pass` = the semantic contract for its `expect` bucket; the
 * flag-conflict heuristic is reported but NOT part of pass (judge comes later).
 *
 * Run: npm run eval:run [-- --concurrency=3] [--limit=N] [--case=gv01-015]
 * Every run writes an eval_runs row (summaryMetrics) + eval_results rows;
 * answers are also persisted as conversations/traces for /admin/traces review.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { evalCases, evalRuns, evalResults, evalSets } from "../db/schema";
import { assembleContext, retrieve, manifestCorpusVersion } from "../lib/retrieval";
import { callModel } from "../lib/gateway";
import { ABSTENTION_MARKER, ANSWERER_NAIVE, answerPrompt, promptId } from "../lib/prompts";
import { persistTurn, type TraceSpan } from "../lib/trace";

const ROOT = path.resolve(import.meta.dirname, "..");
const GOLDEN_PATH = path.join(ROOT, "evals", "golden-v0.1.yaml");
const FACTS_PATH = path.join(ROOT, "evals", "facts.yaml");
const RUNS_DIR = path.join(ROOT, "evals", "runs");

type Expectation = "answer" | "abstain" | "answer+flag-conflict" | "use-calculator";

interface GoldenCase {
  id: string;
  question: string;
  queryType: string;
  riskTier: string;
  expect: Expectation;
  reference: string;
  facts?: string[];
  requiredChunks: string[];
  tags: string[];
}

interface GoldenFile {
  set: { id: string; name: string; version: string; corpusVersion: string };
  cases: GoldenCase[];
}

interface FactDef {
  id: string;
  label: string;
  expected?: string[];
  chunks?: string[];
}

interface FactsFile {
  facts: FactDef[];
}

// --- CLI ---------------------------------------------------------------------
function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
}
const concurrency = Math.max(1, Math.min(4, arg("concurrency", 3)));
const limit = arg("limit", Infinity);
const onlyCase = process.argv.find((a) => a.startsWith("--case="))?.split("=")[1];

// --- Scoring helpers -----------------------------------------------------------

function citedSids(answer: string): string[] {
  return [...answer.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
}

/** Answers sometimes carry NBSP/narrow-NBSP between number and word ("30\u00A0days"). */
function norm(s: string): string {
  return s
    .replace(/[\s\u00A0\u2000-\u200B\u202F\uFEFF]+/g, " ")
    .toLowerCase();
}

function factMatched(fact: FactDef, answer: string): string | null {
  const lower = norm(answer);
  for (const p of fact.expected ?? []) {
    if (lower.includes(norm(p))) return p;
  }
  return null;
}

/** Weak keyword heuristic for "flagged the conflict" — reported, never authoritative. */
function flagHeuristic(answer: string): boolean {
  return /\b(repeal|supersed|no longer (in )?force|conflict|currency|pre-2026|repealed|current law|does not state|not in the (current|act 1151))/i.test(
    answer,
  );
}

interface CaseOutcome {
  caseId: string;
  question: string;
  expect: Expectation;
  answer: string;
  scores: Record<string, unknown>;
  pass: boolean;
  latencyMs: number;
  costUsd: number;
  totalTokens: number;
  error?: string;
}

async function runCase(
  c: GoldenCase,
  factsById: Map<string, FactDef>,
  corpusVersion: string,
): Promise<CaseOutcome> {
  const startedAt = Date.now();
  const spans: TraceSpan[] = [];
  try {
    const retrieved = await retrieve(c.question);
    spans.push({
      step: "embed_query",
      startedAt: new Date(startedAt).toISOString(),
      latencyMs: retrieved.latencyMs,
      tokens: { input: retrieved.queryTokens, output: 0 },
      costUsd: retrieved.queryCostUsd,
    });
    const retrievedIds = retrieved.passages.map((p) => p.chunkId);
    spans.push({
      step: "retrieval",
      startedAt: new Date(startedAt + retrieved.latencyMs).toISOString(),
      latencyMs: 0,
      topK: retrieved.passages.length,
      contextTokens: retrieved.passages.reduce((n, p) => n + p.tokenCount, 0),
      passages: retrieved.passages.map((p) => ({
        sid: p.sid,
        chunkId: p.chunkId,
        documentId: p.documentId,
        sectionPath: p.sectionPath,
        pageNumber: p.pageNumber,
        similarity: Math.round(p.similarity * 1000) / 1000,
        tokenCount: p.tokenCount,
      })),
    });

    const result = await callModel({
      tier: "large",
      promptVersion: promptId(ANSWERER_NAIVE),
      corpusVersion,
      system: ANSWERER_NAIVE.system,
      prompt: answerPrompt(c.question, assembleContext(retrieved.passages)),
    });
    const answer = result.text;

    spans.push({
      step: "answer",
      startedAt: new Date(startedAt + retrieved.latencyMs).toISOString(),
      latencyMs: result.latencyMs,
      model: result.model,
      promptVersion: result.promptVersion,
      tokens: { input: result.usage.inputTokens, output: result.usage.outputTokens },
      costUsd: result.costUsd,
      answerChars: answer.length,
      emptyAnswer: !answer.trim(),
    });

    // --- Code evaluators (§10) ---
    const isAbstain = answer.trim().startsWith(ABSTENTION_MARKER);
    const sidToChunk = new Map<string, string>(
      retrieved.passages.map((p) => [p.sid, p.chunkId]),
    );
    const cited = citedSids(answer);
    const unretrieved = cited.filter((sid) => !sidToChunk.has(sid));
    const required = c.requiredChunks ?? [];
    const missingRequired = required.filter((id) => !retrievedIds.includes(id));
    const recall = required.length > 0 ? (required.length - missingRequired.length) / required.length : null;

    const factDetails: Record<string, { ok: boolean; matched: string | null }> = {};
    const factIds = c.facts ?? [];
    for (const fid of factIds) {
      const fact = factsById.get(fid);
      if (!fact) continue;
      // Absence-facts are only relevant to abstention cases.
      if (fact.expected && fact.expected.length > 0) {
        const matched = factMatched(fact, answer);
        factDetails[fid] = { ok: matched !== null, matched };
      }
    }
    const factsAllOk = Object.values(factDetails).every((f) => f.ok);

    const expect = c.expect;
    const answerBaseOk = !isAbstain && unretrieved.length === 0;
    let pass: boolean;
    if (expect === "abstain") {
      pass = isAbstain;
    } else if (expect === "use-calculator") {
      pass = false; // naive baseline has no calculator tool — measured gap (§8)
    } else {
      // answer and answer+flag-conflict share the same contract; the flag
      // heuristic is reported but never part of pass (judge comes later, §10).
      pass = factIds.length === 0 ? answerBaseOk : answerBaseOk && factsAllOk;
    }

    const scores = {
      expect,
      retrieval: { recall, missingRequired, retrievedCount: retrievedIds.length },
      citations: { cited, unretrieved, valid: unretrieved.length === 0 },
      abstention: { expected: expect, isAbstain },
      facts: factIds.length > 0 ? { allOk: factsAllOk, details: factDetails } : null,
      flagConflict:
        expect === "answer+flag-conflict" ? { heuristicHit: flagHeuristic(answer) } : null,
      calculator: expect === "use-calculator" ? { required: true, ok: false } : null,
      emptyAnswer: !answer.trim(),
      retrievalEmpty: retrieved.passages.length === 0,
    };

    const latencyMs = Date.now() - startedAt;
    await persistTurn({
      question: `[eval:${c.id}] ${c.question}`,
      answer,
      citations: retrieved.passages.map((p) => ({
        sid: p.sid,
        chunkId: p.chunkId,
        documentId: p.documentId,
        documentTitle: p.documentTitle,
        sectionPath: p.sectionPath,
        pageNumber: p.pageNumber,
        sourceUrl: p.sourceUrl,
        similarity: Math.round(p.similarity * 1000) / 1000,
      })),
      promptVersions: [promptId(ANSWERER_NAIVE), "query-embed@1.0.0"],
      spans,
      totalTokens: result.usage.totalTokens + retrieved.queryTokens,
      costUsd: result.costUsd + retrieved.queryCostUsd,
      latencyMs,
    });

    return {
      caseId: c.id,
      question: c.question,
      expect,
      answer,
      scores,
      pass,
      latencyMs,
      costUsd: result.costUsd + retrieved.queryCostUsd,
      totalTokens: result.usage.totalTokens + retrieved.queryTokens,
    };
  } catch (err) {
    return {
      caseId: c.id,
      question: c.question,
      expect: c.expect,
      answer: "",
      scores: { exception: String(err) },
      pass: false,
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      totalTokens: 0,
      error: String(err),
    };
  }
}

// --- Main -----------------------------------------------------------------------

async function main() {
  const golden = parse(await readFile(GOLDEN_PATH, "utf8")) as GoldenFile;
  const factsFile = parse(await readFile(FACTS_PATH, "utf8")) as FactsFile;
  const factsById = new Map(factsFile.facts.map((f) => [f.id, f]));
  const corpusVersion = await manifestCorpusVersion();

  let cases = golden.cases;
  if (onlyCase) cases = cases.filter((c) => c.id === onlyCase);
  cases = cases.slice(0, limit);
  if (cases.length === 0) {
    console.error("FAIL: no cases selected");
    process.exit(1);
  }

  let gitSha = "unknown";
  try {
    gitSha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    /* not a git checkout */
  }

  // Sync the golden set + cases into the DB (append-only runs sit below).
  await db
    .insert(evalSets)
    .values({
      id: golden.set.id,
      name: golden.set.name,
      version: golden.set.version,
    })
    .onConflictDoUpdate({
      target: evalSets.id,
      set: { name: golden.set.name, version: golden.set.version },
    });
  for (const c of golden.cases) {
    await db
      .insert(evalCases)
      .values({
        id: c.id,
        evalSetId: golden.set.id,
        question: c.question,
        queryType: c.queryType,
        reference: c.reference,
        requiredChunks: c.requiredChunks,
        tags: c.tags,
      })
      .onConflictDoUpdate({
        target: evalCases.id,
        set: {
          question: c.question,
          queryType: c.queryType,
          reference: c.reference,
          requiredChunks: c.requiredChunks,
          tags: c.tags,
        },
      });
  }

  const runId = crypto.randomUUID();
  await db.insert(evalRuns).values({
    id: runId,
    evalSetId: golden.set.id,
    configJson: {
      corpusVersion,
      prompt: promptId(ANSWERER_NAIVE),
      concurrency,
      selected: cases.length,
      gitSha,
      mode: onlyCase ? "single" : limit < Infinity ? "limited" : "full",
    },
    gitSha,
    startedAt: new Date(),
  });

  console.log(
    `eval run ${runId}: ${cases.length} cases, concurrency=${concurrency}, corpus v${corpusVersion}, prompt=${promptId(ANSWERER_NAIVE)}`,
  );

  const outcomes: CaseOutcome[] = [];
  const queue = [...cases];
  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift()!;
      const o = await runCase(c, factsById, corpusVersion);
      outcomes.push(o);
      const verdict = o.error ? "ERROR" : o.pass ? "PASS " : "FAIL ";
      const sc = o.scores as { retrieval?: { recall: number | null } };
      console.log(
        `  ${verdict} ${o.caseId}  expect=${o.expect}  recall=${sc.retrieval?.recall ?? "-"}  ` +
          `${(o.latencyMs / 1000).toFixed(1)}s  $${o.costUsd.toFixed(6)}`,
      );
      await db.insert(evalResults).values({
        id: crypto.randomUUID(),
        evalRunId: runId,
        evalCaseId: o.caseId,
        answer: o.answer,
        scores: o.scores,
        costUsd: o.costUsd.toFixed(6),
        latencyMs: o.latencyMs,
      });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // --- Aggregate summary (the smoke report, §10.2) ---
  outcomes.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const n = outcomes.length;
  const byExpect: Record<string, { n: number; pass: number }> = {};
  for (const o of outcomes) {
    byExpect[o.expect] ??= { n: 0, pass: 0 };
    byExpect[o.expect].n += 1;
    if (o.pass) byExpect[o.expect].pass += 1;
  }
  const recalls = outcomes
    .map((o) => (o.scores as { retrieval?: { recall: number | null } }).retrieval?.recall)
    .filter((r): r is number => r !== null && r !== undefined);
  const citationsBad = outcomes.filter(
    (o) => !(o.scores as { citations?: { valid: boolean } }).citations?.valid,
  );
  const abstentions = outcomes.filter((o) => o.expect === "abstain");
  const abstainCorrect = abstentions.filter(
    (o) => (o.scores as { abstention?: { isAbstain: boolean } }).abstention?.isAbstain,
  );
  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : 0;

  const summary = {
    cases: n,
    passRate: n ? outcomes.filter((o) => o.pass).length / n : 0,
    byExpect,
    recallAt8: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
    citationErrors: citationsBad.length,
    abstentionCorrect: `${abstainCorrect.length}/${abstentions.length}`,
    emptyAnswers: outcomes.filter((o) => (o.scores as { emptyAnswer?: boolean }).emptyAnswer).length,
    retrievalEmpties: outcomes.filter(
      (o) => (o.scores as { retrievalEmpty?: boolean }).retrievalEmpty,
    ).length,
    exceptions: outcomes.filter((o) => o.error).length,
    latencyMs: { p50: pct(0.5), p95: pct(0.95) },
    totalCostUsd: outcomes.reduce((s, o) => s + o.costUsd, 0),
    totalTokens: outcomes.reduce((s, o) => s + o.totalTokens, 0),
  };

  await db
    .update(evalRuns)
    .set({ summaryMetrics: summary })
    .where(eq(evalRuns.id, runId));

  await mkdir(RUNS_DIR, { recursive: true });
  const runFile = path.join(RUNS_DIR, `${runId}.json`);
  await writeFile(runFile, JSON.stringify({ runId, gitSha, summary, outcomes }, null, 2));

  console.log("\n=== SMOKE REPORT ===");
  console.log(JSON.stringify(summary, null, 2));
  for (const o of outcomes.filter((x) => !x.pass)) {
    const s = o.scores as {
      retrieval?: { missingRequired?: string[]; recall?: number | null };
      abstention?: { isAbstain?: boolean };
      facts?: { details?: Record<string, { ok: boolean; matched: string | null }> };
      exception?: string;
    };
    const why: string[] = [];
    if (o.error) why.push(`exception: ${o.error.slice(0, 120)}`);
    if (s.abstention?.isAbstain === true && o.expect !== "abstain") why.push("unexpected abstention");
    if (s.abstention?.isAbstain === false && o.expect === "abstain") why.push("failed to abstain");
    if (s.retrieval?.missingRequired?.length) why.push(`missing chunks: ${s.retrieval.missingRequired.join(", ")}`);
    if (s.facts?.details) {
      for (const [fid, d] of Object.entries(s.facts.details)) if (!d.ok) why.push(`fact ${fid} not found`);
    }
    if (o.expect === "use-calculator") why.push("no calculator tool in naive baseline");
    console.log(`  FAIL ${o.caseId}: ${why.join(" | ") || "see run file"}`);
  }
  console.log(`\nrun file: ${path.relative(ROOT, runFile)}`);

  const ok = summary.exceptions === 0;
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
