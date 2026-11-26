# REGULUS — Implementation Progress Tracker

> **Purpose:** This file is the durable memory for the Regulus build. Every agent working on this
> project MUST read this file first, and MUST update it as work completes. Do not let context
> loss derail the plan — everything needed to build the system end to end is here.

**Source of truth:** `C:\Users\Samuel Kyeremeh\Desktop\regulus\Design Doc Ghana Regulatory Research Assistant.md`
(referenced below as §N). To be rewritten as `DESIGN.md` under the name **Regulus** in Phase 0.

**Repo:** `C:\Users\Samuel Kyeremeh\Desktop\regulus` → https://github.com/kyeremehS/regulus (public, `main`)

**Status:** ✅ **Phase 0 COMPLETE 2026-11-16** — app runs, **schema migrated** (9 tables + pgvector 0.8.7 on Neon), **gateway call traced** (`npm run smoke:gateway` PASS on OpenRouter free tier; D1 revised, `OPENROUTER_API_KEY` live). Phase 1 ingestion: **fetch + parse + chunk + enrich done, parse gate PASSED (owner review 2026-11-09) — 9/9 sources, 1,157 chunks, ~336k tokens, 0 over 600**. Phase 2 head start: **eval set v0.1 (2026-11-09) — `evals/facts.yaml` (19 facts) + `evals/golden-v0.1.yaml` (28 cases) + `npm run eval:validate`, exit 0**; owner review of cases pending. Next: **naive RAG path LIVE 2026-11-26 (streaming citations end-to-end; abstention verified; answers correct + cited)** → remaining Phase 1: expand corpus to 20 docs (needs owner-approved sources) + owner browser check of citation rendering. 2026-11-26.

---

## 0. Project identity

- **Name: Regulus.** The design doc's name "Ghana Regulatory Research Assistant / GRRA" is wrong
  — rename all occurrences to Regulus as part of Phase 0. Do not reintroduce the old name.
- One-line: a cited RAG + agent research assistant over Ghanaian tax and business regulation,
  built as a portfolio piece for an AI Software Engineer role, with an eval harness and a
  cost/quality/latency dashboard.
- Non-goals (§2): no legal/tax advice, no fine-tuning, no multi-tenant auth/billing, no coverage
  of all Ghanaian law.

---

## 1. Decisions locked in (do not re-litigate)

| # | Decision | Choice |
|---|---|---|
| D1 | Model provider (revised 2026-11-16) | **Provider-agnostic tiers, OpenRouter free tier by default.** Two named tiers (`small`/`large`) resolved at call time: `MODEL_PROVIDER=openrouter|openai` (default: openrouter when `OPENROUTER_API_KEY` set, else openai). Free defaults: `nvidia/nemotron-3.5-lightning:free` (small) / `nvidia/nemotron-3-ultra-550b-a55b:free` (large), env-swappable via `MODEL_SMALL`/`MODEL_LARGE` because the free roster rotates. Rationale: OpenAI credits exhausted; OpenRouter free tier ($0/token, no card, 20 req/min + 50 req/day) unblocks gateway/chat/evals immediately. OpenAI path retained for when credits return. |
| D2 | Codebase shape | **Single Next.js app** — UI, route handlers, orchestrator, ingestion CLI, eval runner as scripts. One deployable, reproducible in under an hour (§17). |
| D3 | Corpus | **Agent writes a fetcher + starter source list** into `sources/manifest.json`; user verifies availability/licensing *together* with the agent before ingest (§5). |
| D4 | First milestone | **Phase 0 + Phase 1 only**: skeleton, ingestion, naive single-call RAG with streaming citations. Stop, run it, then decide. |
| D5 | Versioning (decided 2026-11-06) | **SemVer git tags** (`vMAJOR.MINOR.PATCH`). MAJOR = phase completed per §18 exit criteria (`v1.0.0` = production, Phase 6). MINOR = new capability within a phase. PATCH = fixes/docs/refactors. Every tag gets a GitHub Release whose notes come from the tracker's change log. Nothing marked `DONE` in this tracker without its version tag. |

### Stack (implied by D1/D2)

| Concern | Choice |
|---|---|
| App | Next.js (App Router) + TypeScript |
| DB | Postgres + pgvector (Neon or Supabase, free tier) |
| ORM | **Drizzle** (owner's preference, decided 2026-11-06 — overrides doc's original "Prisma") — schema per §12 in `db/schema.ts`, pgvector via custom type |
| Streaming | Vercel AI SDK (`streamText`, SSE citation/trace events) |
| LLM access | OpenAI via AI SDK, ALL calls go through one `lib/gateway.ts` with token/cost accounting + prompt-version tagging (build it now, retrofitting is painful) |
| PDF parsing | `unstructured` or `pdfjs-dist` + structure-aware splitter — inspect output early (§19 risk #1) |
| Validation | Zod everywhere — typed agent I/O per §8 |

### Defaults adopted for §20 open questions (v1)

- **Corpus:** Income Tax Act, VAT Act, Companies Act, GRA guidance notes, RGD incorporation guidance.
- **Reranker:** LLM-based (no reranker API) — keeps the stack simple. *(Revisit in Phase 3.)*
- **Calculator:** PAYE and VAT only in v1. *(Revisit in Phase 4.)*
- **Budget cap:** configurable daily cap, default value TBD by user (see §5 Open questions).

---

## 2. Phase status board

Legend: `TODO` · `WIP` · `DONE` · `BLOCKED`

| Phase | Scope | Exit criteria (§18) | Status |
|---|---|---|---|
| **0. Decisions & skeleton** | Rename to Regulus, `DESIGN.md`, `SPEC.md`, scaffold, Drizzle schema, gateway, DB | App runs ✅ / schema migrates ⏳ (needs DB) / traced gateway call ⏳ (needs API key) | WIP |
| **1. Foundations** | Ingestion pipeline, naive RAG with citations, chat UI | 20 documents ingested, citations render correctly | TODO |
| **2. Eval harness** | SPEC, trace model, facts.yaml, 60+ labeled traces, taxonomy, evaluators, CI gate | Baseline failure-mode prevalence with CIs recorded for the naive pipeline | TODO |
| **3. Retrieval upgrade** | Hybrid search, reranking, query rewriting | Recall@k improves against baseline | TODO |
| **4. Agents** | Planner, retriever, calculator, answerer, verifier | Multi-agent path beats or matches baseline on quality, delta documented | TODO |
| **5. Optimization** | Model routing, caching, dashboard | Measurable cost or latency reduction at equal quality | TODO |
| **6. Production** | Deploy, rate limits, tracing, README, safety evals | Public demo link + README with before/after eval tables | TODO |

**Golden rules:**
- The naive single-call baseline path stays in the codebase **forever** (§8). Every agent added
  later must beat it in evals with the delta documented.
- Add agents only when evals show a benefit (§8).
- Route each fix to the cheapest effective layer: prompt → tool design → harness → model (§10.7).

---

## 3. Detailed task checklists

### Phase 0 — Decisions & skeleton ✅ **COMPLETE 2026-11-16**

- [x] Rewrite design doc as `DESIGN.md` with all GRRA references renamed to **Regulus**; resolve §20 open questions with the defaults in §1 above; fold the empty `designdoc.md` into it *(old docs deleted; §20 now a Resolved section)*
- [x] Make the first git commit ✅ `5d8d975` *(26 files; `.env` excluded via gitignore, `.env.example` tracked)*
- [x] Write `SPEC.md` (§10.1): scope (Ghana tax and business regulation only), tool contracts, risk tiers (calculator results higher risk than definitions), when to abstain / tell user to consult a professional, answer contract, hard limits
- [x] Scaffold Next.js app *(Next.js 16.4.5 App Router, TypeScript, Tailwind 4, ESLint flat config — v16 notes: Turbopack default, async-only `params`/`headers`, `next lint` removed, `middleware`→`proxy`)*
- [x] DB schema per §12: Document, Chunk, Conversation, Message, Trace, EvalSet, EvalCase, EvalRun, EvalResult — **Drizzle** (`db/schema.ts`, 9 tables, pgvector custom type), first migration generated (`db/migrations/0000_*` incl. `CREATE EXTENSION vector`); replaces the Prisma version after owner decision 2026-11-06
- [x] Provision Postgres with pgvector (Neon or Supabase) + `.env`; secrets in env vars only, never client-side (§15) — **done: owner chose Neon free tier (2026-11-09), pasted real `DATABASE_URL`, migrated 2026-11-16 → 9 tables + pgvector 0.8.7**
- [x] `lib/gateway.ts`: model selection (named tiers), retries with backoff, timeouts, token/cost accounting, prompt version tagging, structured trace log per call
- [x] `sources/manifest.json` structure (`url, publisher, publishedAt, termsChecked, contentHash`) + starter candidate source list (6 candidates, all `termsChecked: false`)
- [x] **Exit:** app runs ✅ *(HTTP 200; typecheck/lint/build all pass)* · schema migrates ✅ *(2026-11-16: `npm run db:migrate` PASS — 9 tables on Neon, pgvector 0.8.7; drizzle-kit BOM bug fixed, guard added to `db:generate`)* · one traced gateway call ✅ *(2026-11-16: `npm run smoke:gateway` PASS via OpenRouter free tier — provider=openrouter, nemotron-3.5-lightning:free, 158 tok, $0, 1.7s, trace record complete)* — **all three exit criteria met → Phase 0 COMPLETE**

### Phase 1 — Ingestion + naive RAG

**Ingestion (§5)**
- [x] Fetcher: download sources, store raw copy + content hash — `scripts/fetch.ts` (`npx tsx scripts/fetch.ts --force-unverified`), 9/9 fetched, sha256 in manifest
- [x] Parser: structure-preserving text extraction — `scripts/parse.ts` (pdfjs-dist, line grouping by y-position, median body font, heading heuristics) → `sources/parsed/*.md`
- [x] **Gate:** human inspects parsed text dump — headings, section numbers, tables must survive before proceeding (§19 risk #1). **PASSED 2026-11-09** — owner reviewed `sources/parsed/*.md`, no bugs found (spot-check of VAT 870, Companies Act, WHT practice note + programmatic checks: section counts, chunk sizes, paths). Parser fixes that went into this dump: TOC (`ARRANGEMENT OF SECTIONS`) stripped, running headers/page numbers dropped, false-positive headings removed (VAT 870 248→64), section-title context pass added. Known cosmetic artifacts accepted: Companies Act title duplication (`Companies Act, 2019Companies Act, 2019`), `Act992` missing space, WHT rate-table rows concatenated (readable), 19% of chunks <80 tokens (mostly genuine short sections)
- [x] Chunk on legal structure (Part/Section/Subsection), fallback 300–600 tokens with small overlap; prefix each chunk with its section path (`VAT Act > Part II > Section 7`) — `scripts/chunk.ts` (2026-11-09): 4-tier hierarchy (Chapter/Part/Division/Section), 450-token target / 600 max / 50 overlap, section-path prefixes, `sources/chunks/*.json`. **9 docs → 1,157 chunks, ~336k tokens, 0 over 600, 19% under 80** (was 43% before heading fixes)
- [x] Enrich metadata: document, section path, effective date, source URL, page number — `scripts/enrich.ts` (2026-11-09): content-addressed chunk IDs (`<docId>:<hash8>:<index>`, idempotent + supports §5.6 supersede), effective date from the act's `DATE OF ASSENT` line (3 acts) else manifest `publishedAt`, denormalized `sourceUrl`/`effectiveDate` per chunk for citation cards, corpus validation (missing/stale/empty/duplicate → FAIL), terms-gate warning. → `sources/enriched/*.json` (gitignored, derived). **9 docs → 1,157 chunks enriched, exit 0**
- [x] Embed → pgvector; build Postgres full-text index for keyword search (used in Phase 3, index now) — **DONE 2026-11-26: `npm run embed` (scripts/embed.ts) — OpenRouter `text-embedding-3-small` 1536d via gateway `embedTexts()`; 9 docs / 1,157 chunks embedded, $0.005673, 44.7s; GIN index `chunks_fts_idx` on `to_tsvector('english', text)`; DB-verified: 1,157/1,157 embedded @ 1536 dims, FTS returns ranked WHT-practice-note sections**
- [x] Versioning: re-ingest marks old chunks `supersededAt`, never deletes — answers stay reproducible (§5 step 6) — **mechanism built into scripts/embed.ts (content-addressed IDs → absent live chunk IDs get `supersededAt = now()`; first run had 0 to supersede)**
- [ ] **Target: 20 documents ingested**

**Naive RAG path (§7, kept forever as baseline)**
- [x] Single call: vector top-k → assemble context with fixed token budget, passages ordered by relevance, stable `[S1]…[Sn]` IDs — **DONE 2026-11-26: `lib/retrieval.ts` (top-k=8 pgvector cosine over live chunks, 3,200-tok budget, similarity-ordered admission) + `lib/gateway.ts` `streamModel()` (streaming counterpart of callModel; single-consumer contract — drain textStream before awaiting finished)**
- [x] Answer format: short direct answer first, then explanation; inline citations → clickable source cards (document, section, page, link) — **DONE 2026-11-26: `lib/prompts.ts` answerer-naive@1.0.0; UI parses `[S1]` into chips → `GET /api/sources/:id` → side panel with passage in context + official-PDF link**
- [x] Abstention: explicit "Not found in the sources" when evidence insufficient — **verified live 2026-11-26: tax-objection question (the facts.yaml absence fact) → "Not found in the sources. I looked for …" exactly per SPEC**
- [x] Disclaimer footer on every answer ("not professional advice", §15) — per-answer footer + persistent composer footer in UI
- [x] Prompt-injection defense from day one (§9): retrieved text wrapped in clearly delimited blocks, treated as data; system prompt states instructions inside sources must be ignored — `<source id="…">` blocks + answerer-naive@1.0.0 rules

**App surface (§13, §14)**
- [x] `POST /api/chat`: streams answer + citation/trace events via SSE — **DONE 2026-11-26: `sources` → `text` deltas → `done` (trace: promptVersion/corpusVersion/model/tokens/cost/latency); verified live**
- [x] `GET /api/sources/:id`: passage + document metadata for a citation — **DONE 2026-11-26, verified live (200, chunk text + document title)**
- [x] Chat UI: streaming text, inline citation chips, side panel showing cited passage in context — **DONE 2026-11-26 (`app/page.tsx` client component)**
- [x] Mobile-friendly layout (users in Ghana are often on phones, §14) — responsive: citation panel becomes a bottom sheet below `lg`
- [ ] **Exit:** 20 docs ingested, citations render and open the real source passage (§18 Phase 1) — **9/20 docs; citations pipeline verified end-to-end via API smoke; owner to confirm rendering in browser; corpus expansion (11 more sources) remains**

**Explicitly NOT in this milestone:** agents, reranking, query rewriting, calculator, verifier,
eval harness, dashboard, caching, admin UI. Evals are Phase 2; agents only if evals justify (§8).

### Phase 2 — Eval harness (§10)

**Spec & trace model**
- [ ] `SPEC.md` written (done in Phase 0) — keep it current as scope changes
- [x] Trace data model **before taking any traffic**: nested spans for every agent step, retrieval call, model call, tool call, permission denials, prompt hashes — **DONE 2026-11-26: `lib/trace.ts` — every chat turn persists conversation + user/assistant messages (citations jsonb) + trace with ordered spans (embed_query → retrieval with per-passage similarity/tokens → answer or error), per-step tokens/cost/latency/model/promptVersion. Verified live: 2 turns → 2 traces, spans complete.**
- [ ] Store traces in Postgres (all evaluators read the same trace format) — **done as part of the line above; the `/api/admin/traces` JSON endpoint is the evaluators' read path. Mark fully when the eval runner consumes it (Phase 2).**
- [ ] Simple trace review interface for reading whole traces (needed for step below) — **DONE 2026-11-26: `/admin/traces` (server component, expandable whole-trace view: question, spans, retrieved-passage table with similarities, answer; ERROR/ABSTAINED badges; simple ADMIN_KEY protection per §13) — verified live. Owner to eyeball rendering.**

**Ground truth**
- [x] `facts.yaml`: rates, thresholds, deadlines, section numbers → each linked to its source passage; exact-match checks and the calculator read from it — **v0.1 written 2026-11-09** (`evals/facts.yaml`, 19 facts, every `chunks` id content-addressed + validator-checked; includes 3 documented corpus conflicts + 1 absence fact for abstention)
- [ ] Smoke report (error rate, empty retrievals, answer rate) run **before** labeling anything — blocked (needs a model key: `OPENROUTER_API_KEY` free tier suffices)

**Scenario set**
- [ ] ~300 scenarios generated from corpus + facts.yaml across §4 query types: lookup, multi-document, calculation, out-of-scope, adversarial
- [x] **Golden eval set v0.1** — `evals/golden-v0.1.yaml`, 28 cases (lookup=12, synthesis=6, calculation=2, abstention=5, adversarial=3), seeded from GRA's 13 public FAQ pages + corpus facts; each case carries `question/queryType/riskTier/expect/reference/facts/requiredChunks/tags` mirroring `db/schema.ts`; validated by `npm run eval:validate` (2026-11-09, exit 0 vs 1,157 corpus chunks). To be refined to v0.2 with KPMG practitioner questions
- [ ] Human reviews every scenario before it enters the set — **owner review pending for v0.1**
- [ ] Replace synthetic questions with real ones from user feedback over time (via `/api/feedback`)

**Error analysis (human-owned)**
- [ ] Read ≥60 whole traces in the review UI; note first failure in plain language (open coding)
- [ ] Group notes into 5–8 binary failure modes with definitions, examples, boundary cases (axial coding); stop at saturation
- [ ] Compare against published RAG taxonomies **only after** building our own
- [ ] Never let an LLM label everything — judges are validated against human labels, never substituted for them
- [ ] Confirm or discard these starting hypotheses: cites unretrieved passage ID (code) · citation doesn't support claim (judge) · number/rate/date contradicts facts.yaml (code) · calculator needed but not called (code) · answers unanswerable instead of abstaining (code + judge) · cites superseded version (code) — **CONFIRMED live 2026-11-26: owner's retail flat-rate question got "3%" cited from the repealed Act 870 regime (2020 practice note) as if current; Act 1151 (commenced 2026-01-01) + its guidelines never state the rate → golden case gv01-029 + facts `absence-flat-rate-current-law`** · follows instruction embedded in source/user message (code + judge)

**Evaluators & metrics**
- [ ] One binary pass/fail evaluator per failure mode — code for objective, LLM judge only where interpretive
- [ ] Split labeled traces into train (judge prompt examples), dev (iteration), test (frozen, read once at the end)
- [ ] Report each judge's TPR and TNR on test split (not accuracy alone); correct prevalence estimates; bootstrap 95% CIs
- [ ] Subsystem evaluators: retrieval Recall@k + MRR (code), numbers/calculator exact match (code, vs facts.yaml), abstention correct-abstain rate, reliability pass^k / pass@k (k = 3–5), operational p50/p95 latency + cost per query

**CI/CD regression suite (§10.5)**
- [ ] Every labeled failure → test case: input, expected result, initial state (corpus version, conversation history)
- [ ] Mechanical failures → code assertions; subjective failures → pinned judge checks (judge prompt + model frozen)
- [ ] Cost tiers: deterministic checks every commit · mocked integration (recorded responses) every PR · full agent evals nightly and on any prompt/retrieval/model change
- [ ] GitHub Actions gate blocks merges that raise any failure-mode rate beyond threshold; posts summary table
- [ ] After deploy: code checks on all traffic, frozen judges on ~5% sample, dashboard with corrected prevalence + alerts; new production failures become new test cases
- [ ] `GET /api/admin/evals` provides the data (admin auth = simple protection, §13)

**Exit:** baseline failure-mode prevalence with confidence intervals recorded for the naive pipeline (§18)

### Phase 3 — Retrieval upgrade (§7)

- [ ] Hybrid search: top-k vector + top-k keyword merged with reciprocal rank fusion
- [ ] Reranking: LLM-based reranker narrows merged list (30 → 6) — revisit the reranker-API vs LLM choice here
- [ ] Query rewriting: planner-driven rewrite/decomposition into sub-queries (no full planner agent yet — keep it simple)
- [ ] Metadata filters: document / act / effective date when the query implies them
- [ ] Context assembly hardening: fixed token budget, passages ordered by relevance, merge adjacent chunks from the same section to avoid fragmented evidence
- [ ] Re-run eval suite; record Recall@k and MRR before/after
- [ ] **Exit:** Recall@k improves against baseline (§18)

### Phase 4 — Agents (§8)

- [ ] **Planner** (small/fast model): classify query, decide tools, decompose multi-part questions — typed input/output schema
- [ ] **Retriever agent** (small + retrieval code): execute searches, refine when results are weak
- [ ] **Calculator tool** (no LLM): deterministic PAYE + VAT computation reading rates from a **versioned config file, never model memory** (§20 default: PAYE + VAT only)
- [ ] **Answerer** (large model): compose final cited response
- [ ] **Verifier** (small/medium): check each claim supported by cited passage → triggers one revision pass or downgrades to "partially supported"
- [ ] Orchestrator runs the agent graph per query, emits trace events, writes tokens/cost/latency to Postgres (§6 flow steps 1–7)
- [ ] Zod-validated I/O on every agent; malformed output → one retry → safe fallback
- [ ] Hard limits on steps, tokens, wall-clock time per request (no runaway loops)
- [ ] Gateway response cache checked first, keyed on normalized query + corpus version + prompt version (§6 step 2)
- [ ] Re-run full eval suite against baseline; document the delta
- [ ] **Exit:** multi-agent path beats or matches baseline on quality, delta documented (§18)

### Phase 5 — Optimization (§11, §10.7)

**Levers (each measured against the eval suite)**
- [ ] Model routing: small for planning/verification, large for answers only
- [ ] Response caching + embedding caching
- [ ] Retrieval tuning: chunk size, top-k, reranker on/off
- [ ] Context trimming to reduce input tokens
- [ ] Streaming + parallel tool calls for perceived latency
- [ ] Skip verifier on high-confidence simple queries
- [ ] Profile history growth, retrieval depth, repeated tool schemas (usual cost culprits, §10.7)

**Dashboard (§11, §14 admin pages)**
- [ ] Quality vs. cost scatter — one point per configuration (model, prompt version, retrieval settings)
- [ ] Latency breakdown per stage (retrieval, planning, generation, verification)
- [ ] Cost per query over time and per query type
- [ ] `GET /api/admin/metrics` endpoint + protected admin pages
- [ ] Eval run list, run-to-run diff, trace viewer (§14)

**Improvement loop (§10.7)**
- [ ] Comparable frontier: every point uses same prompts, tools, harness, workload, suite; vary one axis at a time
- [ ] Route each fix to cheapest effective layer: prompt → tool design → harness → model
- [ ] Fix top failure mode by hand **before** any automated prompt optimization (e.g. GEPA); guard reward hacking by checking winners on the frozen test split + reading sample traces
- [ ] Store several Pareto-frontier configs (cheapest acceptable, best quality); when a new model ships, re-run suite, redraw frontier, decide deploy/keep/retire
- [ ] Service levels: TTFT < 1.5s, p95 full answer < 10s, cost per query capped, configurable daily budget that disables expensive paths when exceeded (§11 — revise after first baseline measurements)
- [ ] **Exit:** measurable cost or latency reduction at equal quality (§18)

### Phase 6 — Production (§13–§17, §10.6, §21)

**Remaining API surface**
- [ ] `POST /api/feedback`: thumbs up/down + optional reason → grows the golden set (§13)
- [ ] `GET /api/admin/evals`, `GET /api/admin/metrics` protected (if not already done in Phases 2/5)
- [ ] Visible "confidence/support" indicator in UI driven by verifier result (§14)

**Red-team & safety evals (§10.6)**
- [ ] Map attack surface with OWASP Top 10 for Agentic Applications — main risks: goal hijacking, context poisoning (ingested docs + user input)
- [ ] Enforce safety in code (injection has no reliable detector): system can only read corpus + call calculator; no tool can write or send anything
- [ ] Run promptfoo against the running endpoint; every successful attack → failing adversarial test, then fix
- [ ] Input, output, and tool guards in place
- [ ] Short governance note structured on NIST AI RMF: purpose, known limits, monitoring, applicable legal obligations

**Reliability & security (§15)**
- [ ] Timeouts, retries with backoff, fallback to secondary model on provider errors
- [ ] Per-IP and per-session rate limiting; input length limits
- [ ] No sensitive personal data requested or stored; logs avoid raw user identifiers
- [ ] Secrets in env vars only; API keys never exposed to client
- [ ] Prompt-injection and data-exfiltration tests included in the eval suite
- [ ] Legal disclaimer in UI and every answer footer

**Observability (§16)**
- [ ] Trace per request with spans for each agent step, retrieval call, model call — incl. prompt version, tokens, cost, latency
- [ ] Structured JSON logs
- [ ] Alerts for error rate, p95 latency, daily cost thresholds (simple ones are fine)

**Deployment & CI (§17)**
- [ ] Frontend + API on Vercel; managed Postgres with pgvector (Neon/Supabase)
- [ ] Environments: local, preview (per PR), production
- [ ] CI pipeline order: lint → type-check → unit tests → eval run on dev set → deploy
- [ ] Infrastructure small and documented so it can be reproduced in under an hour

**Success criteria (§21) — final acceptance**
- [ ] Public demo answers questions from the corpus with correct, verifiable citations
- [ ] README shows eval tables: naive baseline vs final system on correctness, faithfulness, abstention, cost, latency
- [ ] At least one documented trade-off decision backed by dashboard data
- [ ] A prompt change cannot be merged without passing the eval gate
- [ ] README documents what was AI-assisted and how it was verified (§3)
- [ ] **Exit:** public demo link + README with before/after eval tables (§18)

---

## 4. Cross-cutting requirements (apply during ALL phases)

### Prompt & context engineering (§9)
- [ ] Prompts live in version-controlled files, each with ID + semantic version (e.g. `answerer@1.3.0`)
- [ ] Every model call logs prompt version, model, and corpus version
- [ ] Prompt changes go through PRs including eval results; CI gate blocks merges that regress key metrics beyond threshold
- [ ] Context rules documented: passage ordering, token budgets per section, abstention instructions, citation format
- [ ] Prompt-injection defense (delimited data blocks, ignore instructions in sources)

### Data model (§12)
- [ ] All nine models implemented: Document, Chunk, Conversation, Message, Trace, EvalSet, EvalCase, EvalRun, EvalResult — with the fields listed in §12

### Risks (§19) — keep in view throughout
1. PDF parsing hurts retrieval → inspect parsed output early, structure-aware chunking, parsing tests
2. LLM judge biased/noisy → hand-label a sample, report agreement, use a different judge model
3. Prompt overfitting to golden set → held-out set reported separately
4. Outdated regulations → effective dates, versions, "last updated" shown in answers
5. Eval costs → cache judge calls, sample on PRs, full suite nightly
6. Multi-agent complexity without gains → keep baseline, require eval evidence per agent
7. Wrong answer on high-stakes topic → verifier, abstention, clear disclaimer

---

## 5. Open questions for the user

- [x] **Model key in `.env`** — D1 revised 2026-11-16: default provider is now **OpenRouter free tier** (no credit card). Owner added free `OPENROUTER_API_KEY` same day → **`npm run smoke:gateway` PASS** (Phase 0 gateway exit ✅). OpenAI path kept (`MODEL_PROVIDER=openai` + `OPENAI_API_KEY`) for when credits return
- [x] **Database choice** — owner picked **Neon free tier** (2026-11-09), pasted a real `DATABASE_URL` (neon.tech), and **`npm run db:migrate` succeeded 2026-11-16** → 9 tables + pgvector 0.8.7 on PostgreSQL 18.7
- [ ] Daily budget cap for model + hosting costs (dollar figure)? (`.env.example` defaults to 5 USD)
- [ ] Confirm the exact v1 source list and verify each source's terms of use/licensing (§5 — human check, required before Phase 1 ingest: flip `termsChecked: true` in `sources/manifest.json`)

---

## 6. Change log (append-only)

| Date | Change | By |
|---|---|---|
| 2026-11-06 | Plan drafted: D1–D4 decisions locked, Phase 0+1 scoped, progress tracker created | planning session |
| 2026-11-06 | Expanded to full end-to-end: Phases 2–6 broken into checklists, §9/§10.6/§10.7/§13/§14/§16/§17/§21 gaps filled, cross-cutting section added | planning session |
| 2026-11-06 | Phase 0 in progress: DESIGN.md (Regulus rename + §20 resolved), SPEC.md, Next 16.4.5 scaffold, Prisma §12 schema (valid), lib/gateway.ts, sources/manifest.json (6 candidates), smoke:gateway script. Verified: typecheck/lint/build pass, dev server HTTP 200. Blocked: DATABASE_URL (Neon vs Supabase) + OPENAI_API_KEY. Old docs deleted. | implementation session |
| 2026-11-06 | **Stack change (owner decision): Prisma → Drizzle.** Removed prisma/@prisma/client; added drizzle-orm/drizzle-kit/pg. `db/schema.ts` = §12 (9 tables, pgvector custom type), `db/index.ts` client, `drizzle.config.ts`, migration `0000` (+`CREATE EXTENSION vector`), npm scripts `db:generate/migrate/push/studio`. DESIGN.md §6/§12 wording updated. Typecheck/lint/build pass. | implementation session |
| 2026-11-06 | **Pushed to GitHub:** https://github.com/kyeremehS/regulus (public, `main`). 4 commits: Phase 0 skeleton → tracker → Drizzle switch → cleanup. | implementation session |
| 2026-11-06 | README written (Veritas-style) then eval-harness section promoted to a lead section (owner priority: evals are the most important part). **Versioning adopted (D5):** SemVer tags, MAJOR = phase complete. Tagged `v0.1.0` = Phase 0 skeleton. | implementation session |
| 2026-11-06 | Session paused. Owner will add OPENAI_API_KEY + DATABASE_URL to `.env` manually; project resumes weekend of 2026-11-07/08. Resume point: smoke:gateway + db:migrate → Phase 1. | implementation session |
| 2026-11-09 | **Ingestion pipeline built.** `scripts/fetch.ts` (sha256 + manifest updates, Windows-safe CLI guard), `scripts/parse.ts` (pdfjs-dist structure-preserving parse → inspection dumps), `scripts/diagnose.ts` (text-vs-image), `scripts/probe-textlayer.ts` (candidate URL text-layer prober). Real GRA URLs scraped from gra.gov.gh/acts + /practice-notes (websearch tool broken, HTTP 402 — used direct scraping). 9 sources in manifest. **Parse gate caught #1 risk live: Income Tax Act 896, VAT Act 1151, VAT Guidelines 1151 were scanned images (0 text).** Re-sourced: Act 896 → brr.gov.gh consolidated as-amended copy (111pp text), Act 1151 → a-tla.org mirror (87pp), VAT Guidelines → ghtaxclub.com mirror (19pp), Companies Act 992 → Wayback snapshot of ghalii.org (412pp; RGD dead, ORC no library, ghalii 403s bots). **9/9 now parse: 15,448 + 3,545 + 2,867 blocks etc., 0 zero-block docs.** Gate open for owner review of `sources/parsed/*.md`. DATABASE_URL: owner chose Neon free tier (signup pending). | implementation session |
| 2026-11-09 | **Chunker built + parse/chunk quality pass.** `scripts/chunk.ts`: parses inspection dumps → blocks, groups into sections with 4-tier hierarchy (Chapter→Part→Division→Section), 450-target/600-max/50-overlap token windows, section-path prefixes → `sources/chunks/*.json`. Gate-driven parse fixes: TOC strip (re-states `AN ACT…` boundary — never eats body text), running-header/page-number strip (repeated on ≥25% of pages), dedupe double-printed lines, tightened `isHeading` (junk guards first: no trailing `;`/`,`, no trailing `.` unless numbered), context pass promoting section titles above numbered openers, `actPattern` narrowed to `Act <number>`. `headingLevel` rewritten to 4 tiers. **Result: 9 docs → 1,157 chunks, ~336k tokens, 0 over 600, 19% under 80 (was 43%).** Verified paths e.g. `Income Tax Act > PART II—INCOME TAX BASE > Division IV: Deductions > Section 9—Residual deduction rule`. Also: typecheck fixes to `diagnose.ts`/`probe-textlayer.ts` (`paintInlineImageXObject`, `"str" in i` guards, `doc.destroy` cast). Next: owner gate review of `sources/parsed/*.md`. | implementation session |
| 2026-11-09 | **Stage 4 enrich built.** `scripts/enrich.ts` attaches document/section-path/effective-date/source-URL/page metadata to every chunk (DESIGN §5 step 4) and assigns content-addressed chunk IDs `<docId>:<hash8>:<index>` — idempotent re-runs, and changed content yields new IDs so re-ingest can mark old chunks `supersededAt` without deleting (§5.6). Effective date parsed from the act's own `DATE OF ASSENT` line (Act 896 → 2015-09-01, Act 1151 → 2025-12-09, Act 992 → 2019-08-02), else manifest `publishedAt`; source recorded (`assent`/`published`). Validates corpus (missing chunks file, stale title, empty text, duplicate IDs → FAIL) + warns 9/9 `termsChecked=false` (answer-corpus ingest still blocked). Output `sources/enriched/*.json` gitignored (derived). **9 docs → 1,157 chunks, exit 0.** Known limitation: consolidated Act 896 carries the BASE act's assent date; currency lives in the separate amendments doc. Remaining ingestion (embed → pgvector + FTS + versioning) blocked on DATABASE_URL + OPENAI_API_KEY. | implementation session |
| 2026-11-09 | **Parse inspection gate PASSED** (§19 risk #1 closed). Owner reviewed `sources/parsed/*.md` spot-checks (VAT 870, Companies Act, WHT practice note) — no bugs found; accepted known cosmetic artifacts (Companies Act title duplication, `Act992` missing space, WHT rate-table rows concatenated, 19% chunks <80 tok). Ingestion stages 1–3 (fetch → parse → chunk) now complete and verified. Remaining Phase 1 ingestion (enrich → embed → FTS index → versioning) blocked on DATABASE_URL (Neon signup pending) + OPENAI_API_KEY (credits exhausted). | implementation session |
| 2026-11-09 | **Eval set v0.1 written (owner's stated top priority) — zero-credit Phase 2 head start.** Seed = GRA's 13 public FAQ pages (real taxpayer questions, official answers) grounded against the corpus. Two artifacts per DESIGN §10.2 + validator: (1) `evals/facts.yaml` — 19 facts (VAT 15%, flat rate 3%, CIT 25/22/8%, PAYE bands, WHT table rates, return deadline 4 months, incorporation rules), each linked to content-addressed chunk IDs; documents the **VAT registration threshold conflict as a feature** (Act 870 GHS 120,000 `:32aa74aa:6` vs Act 1151 GHS 750,000/187,500 `:209a8c58:8` vs GRA FAQ 200,000 — FAQ figure NOT in corpus, recorded as such) + 1 absence fact (tax-objection procedure verifiably absent from all 9 docs → abstention ground truth). (2) `evals/golden-v0.1.yaml` — 28 cases: lookup=12, synthesis=6, calculation=2, abstention=5, adversarial=3, mirroring `eval_cases` columns plus `riskTier` (SPEC T1–T3) and `expect` (`answer` / `abstain` / `answer+flag-conflict` / `use-calculator`). (3) `scripts/eval-validate.ts` (`npm run eval:validate`) — structural checks, every requiredChunk must exist in `sources/enriched/` (so re-fetch hash drift fails loudly), fact-id cross-refs, DESIGN §4 type-coverage gates, SPEC T3 rules (calculation ⇒ use-calculator). **First run: facts=19 cases=28, corpus chunks=1,157, exit 0.** Next: owner review of cases → v0.1 accepted; KPMG questions → v0.2. | implementation session |
| 2026-11-16 | **D1 revised — OpenRouter free tier added as default model provider** (owner decision; unblocks gateway/chat/evals without waiting on OpenAI credits). `lib/gateway.ts`: tiers `small`/`large` are now provider-agnostic and resolved at call time — `MODEL_PROVIDER=openrouter\|openai` explicit, else default openrouter when `OPENROUTER_API_KEY` set, else openai; model ids env-swappable (`MODEL_SMALL`/`MODEL_LARGE`) because OpenRouter's free roster rotates. Free defaults chosen from the live `/models` list (14 `:free` models on 2026-11-16): **small = `nvidia/nemotron-3.5-lightning:free`** (3B active/30B MoE, high-throughput agentic — planner/retriever/verifier/judge per §8) and **large = `nvidia/nemotron-3-ultra-550b-a55b:free`** (55B active/550B MoE, open frontier reasoning + orchestration, 1M ctx — answerer per §8). Installed official `@openrouter/ai-sdk-provider@3.1.0` (peer `ai ^7.0.0` matches local 7.0.163); `.chat(modelId)` returns a `LanguageModelV4`. `estimateCost` returns 0 for `:free` ids (usage still logged); gateway log/result now carry `provider`; timeout 30s → 60s (free endpoints queue, reasoning models think). `smoke-gateway.ts` prints provider + resolved tier ids and checks the right key var. `.env.example` updated. Free-tier facts verified via docs: no credit card, $0/token, 20 req/min, 50 req/day (1,000/day after one-time $10 top-up) — the 28-case golden run fits in one day's allowance. **Also observed: owner pasted a real neon.tech `DATABASE_URL` into `.env`** → `npm run db:migrate` now runnable (Phase 0 exit item). Still needed: `OPENROUTER_API_KEY` (owner, free) → `npm run smoke:gateway`; embeddings provider for stage 5 remains open (OpenRouter free list is chat-only). | implementation session |
| 2026-11-16 | **Smoke test PASS — Phase 0 gateway exit met.** Owner added the free `OPENROUTER_API_KEY`; `npm run smoke:gateway` first run revealed a real finding: **both free-tier defaults are reasoning models that think by default** — with the original `maxOutputTokens: 16` the entire budget was consumed by thinking (`outputTokens=16`, `text=""`), while usage/trace/cost all logged correctly. Probe confirmed: at 512 tokens both tiers answer ("OK"; small spends ~90 tokens thinking first, large ~20). Fixes: smoke budget 16 → 512 with comment (≥ ~256 headroom for reasoning models), gateway note on the gotcha, plus a `gateway.call.empty_text` structured warning so silent empty answers can never pass unnoticed in later evals. Re-run: **PASS** — provider=openrouter, `nvidia/nemotron-3.5-lightning:free`, 158 tokens, $0, 1.7s, 1 attempt, full trace record (prompt version + corpus version). Remaining Phase 0 exit: `npm run db:migrate` (DATABASE_URL real). Free-allowance note: ~6 of 50 daily requests used. | implementation session |
| 2026-11-26 | **First live failure-mode finding: "cites superseded version" confirmed (owner-found, pre-harness).** Owner asked about the retail VAT flat rate; naive RAG answered "3%" citing the 2020 GRA practice note — Act 870-era law — as if current. Corpus forensics: 7 chunks stating 3% are ALL from repealed-era docs (Act 870/Act 948/practice note); current-law docs (Act 1151 + 2026 Guidelines) contain only one flat-rate mention (¶15.5 conversion of flat-rate taxpayers — scheme persists administratively, rate unstated). Root cause is by design: the naive §7 baseline has no currency/supersession awareness — similarity retrieval surfaces the textually-closest historical text. This is a BASELINE measurement to keep, not a silent hotfix (golden rule); the designed fixes land in Phase 3 (effective-date metadata filters) + Phase 4 (verifier). Recorded now: facts.yaml `absence-flat-rate-current-law` + currency warning on `vat-rate-flat-scheme`; golden case `gv01-029` (expect answer+flag-conflict — 3% only WITH Act-870-era provenance, or abstain on current rate). `npm run eval:validate` PASS (facts=20, cases=29). | implementation session |
| 2026-11-26 | **Trace store + review UI (§10.1 Phase 2 groundwork) — built and live-verified.** Owner's ask ("how do I see traces to catch failures") = the plan's next item. New `lib/trace.ts` (`persistTurn`: conversation + user/assistant messages with citations jsonb + trace row whose `steps` jsonb holds ordered spans with per-step tokens/cost/latency/model/promptVersion; persistence failures log `trace.persist_failed` and never break an answer), wired into `POST /api/chat` (single `done` event now carries trace + conversationId; error path persists an `error` span), `GET /api/admin/traces` (JSON read path for the future eval runner; ADMIN_KEY simple protection per §13 — unset = open with a warning banner to set before deploy), and `/admin/traces` (server component viewer: expandable whole-trace cards with ERROR/ABSTAINED badges, span timeline, retrieved-passage similarity table, full answer). Next 16 learnings: cacheComponents forbids `export const dynamic` on pages too — use `await connection()` + `export const instant = false` for blocking admin routes. **Live verification: 2 chat turns (one normal, one abstention) → conversations=2, messages=4, traces=2, spans embed_query(1.5s)→retrieval(8 passages)→answer(13.7s); admin page renders rows.** Candidate tag `v0.4.0`. | implementation session |
| 2026-11-26 | **Naive RAG path LIVE (§7 baseline) — streaming cited answers end to end.** Built: `lib/retrieval.ts` (query embed via gateway → pgvector cosine top-8 over live chunks → 3,200-token budget, similarity-ordered, stable [S1…S8] ids), `lib/prompts.ts` (answerer-naive@1.0.0 — answer-first format, cite-after-claim, exact-quote rule, abstention phrase, §9 injection defense via `<source>` data blocks), `lib/gateway.ts streamModel()` (streamText with retry-until-first-delta + full accounting; **hard-won contract: ONE consumer per stream — the first implementation let `finished` race the caller's for-await on the same iterator and interleaved/corrupted the visible answer; caught by live smoke, fixed by single-consumer buffer**), `POST /api/chat` (SSE: sources → text deltas → done+trace), `GET /api/sources/[id]`, and the chat UI (`app/page.tsx`: streaming text, [S1] chips → side panel with cited passage + official-PDF link, disclaimer footers, bottom-sheet panel on mobile). Next 16.4.5 notes: `cacheComponents` forbids `export const dynamic` in route handlers (removed; POST/stream routes stay dynamic by default). **Live verification (prod build, real corpus):** VAT-rate question → correct answer (15% Act 1151 s.3 [S8]; 3% flat rate Act 870 s.3(2) as amended by Act 948 [S3,S5]; retrieval hit the right practice-note + rate sections, 8 sources, ~3.9k tok, $0 free tier, 38-63s on the free large model); abstention question (tax-objection procedure — the known corpus absence) → exact "Not found in the sources. I looked for …"; /api/sources/:id → 200 with chunk + doc metadata. Remaining Phase 1: corpus → 20 docs (owner sources) + owner browser confirmation. Candidate tag `v0.3.0`. | implementation session |
| 2026-11-26 | **Stage 5 embed RUN PASS — corpus is in the database.** Owner reviewed the 9 manifest sources (official GRA/BRR publications + mirrors of public statute texts) and approved → all `termsChecked: true` recorded in the manifest `$comment`; statuses flipped to `ingested`. `npm run embed`: **9 docs / 1,157 chunks embedded — 283,633 tokens, $0.005673, 44.7s, 19/19 gateway calls at 1 attempt, zero retries needed**. DB-verified (not just script output): documents=9, chunks=1,157, all with embeddings at 1536 dims; `chunks_fts_idx` GIN index created; FTS sanity check returns sensible ranked results (60 chunks match "withholding"; top-3 = WHT practice note appendix/exemption sections). Supersede path exercised (0 to supersede on first ingest). Phase 1 ingestion now complete through stage 5 — remaining Phase 1 work is the naive RAG path + app surface (route handlers, chat UI). Per D5 this is a new capability → candidate tag `v0.2.0` when committing. | implementation session |
| 2026-11-26 | **Stage 5 embedding decision + build (correction: OpenRouter DOES serve embeddings).** My earlier "zero embedding models" probe hit the chat `/models` catalog — embeddings live on a dedicated pair of endpoints (`GET /api/v1/embeddings/models`, `POST /api/v1/embeddings`); live check found **40 embedding models incl. 3 `:free`** (one of which, `nemotron-3-embed-1b:free`, went end-of-life 2026-11-23 — proving the free-roster rotation risk). Owner decision: **`openai/text-embedding-3-small` via OpenRouter** — live-verified 1536 dims (matches schema `vector(1536)`, zero migration), ~$0.02/M tok (~**$0.007 one-time for the whole 336k-token corpus**), stable id, one key for chat+embed, and query-time embedding works on Vercel serverless (no ONNX payload — the decisive argument vs local fastembed). Env-swappable `MODEL_EMBED` per the D1 pattern; pricing table gains the entry. Built: `lib/gateway.ts` `embedTexts()` (same retry/timeout/accounting/trace discipline as `callModel`, event `gateway.embed`), `scripts/embed.ts` (`npm run embed`) — terms gate hard-fails unless all manifest sources are `termsChecked=true` (or `--force-unverified`), corpus validation (missing/stale/dupes), batches 64 texts/call, upserts documents + chunks, marks absent live chunks `supersededAt` (§5.6), creates `chunks_fts_idx` GIN index on `to_tsvector('english', text)` for Phase 3. **Embed smoke PASS** (2 texts → 1536 dims, 17 tok, $3.4e-7, typecheck/lint pass). **Real run pending: owner terms review of all 9 manifest sources** (owner chose review-first). | implementation session |
| 2026-11-26 | **OpenRouter account upgraded to paid tier (owner added credits).** Verified via `/api/v1/key`: `is_free_tier=false`, `limit=unlimited`, usage $0. Effect: daily request cap 50 → 1,000/day (eval runs no longer squeezed into a day's allowance) and paid (non-`:free`) models are now reachable via `MODEL_SMALL`/`MODEL_LARGE` env swap. Defaults per D1 unchanged (`:free` nemotron tiers cost $0 — paid tier only lifts limits). Also probed live `/models` (477 models): **still zero embedding models** → stage 5 embeddings provider decision remains open (local/fastembed, Gemini free tier, or paid embeddings elsewhere). | implementation session |
| 2026-11-16 | **`db:migrate` PASS → Phase 0 COMPLETE (all 3 exit criteria).** First two `drizzle-kit migrate` runs exited 1 with **no error message** — drizzle-kit's spinner swallows the failure (observed repeatedly; always verify via table count). Diagnosed by stepping down: raw `pg` connect OK (Neon PostgreSQL 18.7, database `neondb`, 0 tables) → direct `drizzle-orm` migrator exposed the real error (`Failed query: CREATE EXTENSION IF NOT EXISTS vector; …`) → standalone `CREATE EXTENSION` succeeded (pgvector 0.8.7 available), isolating the cause: **the migration file `0000_lonely_dorian_gray.sql` began with a UTF-8 BOM (`0xEF 0xBB 0xBF`), which PostgreSQL rejects with a syntax error** (BOM written by drizzle-kit generate on Windows; JSON snapshot/journal unaffected). Stripped the BOM → `db:migrate` PASS → verified **9 tables** (chunks, conversations, documents, eval_cases, eval_results, eval_runs, eval_sets, messages, traces) + pgvector 0.8.7. Hardening: new `scripts/strip-bom.ts` runs after every `db:generate` (idempotent) so future migrations can't hit the same silent failure. Phase 0 checklist all ✅; next: stage 5 embed (embeddings provider decision) → naive RAG. | implementation session |

---

## 7. How to use this file

1. **Agents:** read this file first in every session. Update section 2 (status board) and
   section 3/4 (checkboxes) as work completes. Append to the change log (section 6).
2. **Never** remove a locked decision (section 1) without recording the change in the change log.
3. A phase is only `DONE` when its **exit criteria** are met and verified by running the code.
4. When context feels stale, re-read section 1 and section 2 — they are the compressed plan.
5. Section 3 is the checklist of record: nothing ships that isn't checked off here first.
6. **Versioning (D5):** tag SemVer when phases/capabilities land — `git tag -a vX.Y.Z -m "..."` + `git push origin --tags`. GitHub Release notes come from the change log below. Nothing marked `DONE` without its tag.
