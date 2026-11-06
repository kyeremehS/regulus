# REGULUS — Implementation Progress Tracker

> **Purpose:** This file is the durable memory for the Regulus build. Every agent working on this
> project MUST read this file first, and MUST update it as work completes. Do not let context
> loss derail the plan — everything needed to build the system end to end is here.

**Source of truth:** `C:\Users\Samuel Kyeremeh\Desktop\regulus\Design Doc Ghana Regulatory Research Assistant.md`
(referenced below as §N). To be rewritten as `DESIGN.md` under the name **Regulus** in Phase 0.

**Repo:** `C:\Users\Samuel Kyeremeh\Desktop\regulus` (git repo, currently zero commits)

**Status:** Planning complete → ready for Phase 0.

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
| D1 | Model provider | **OpenAI only** for v1. Single SDK, single billing. Provider fallback added later. |
| D2 | Codebase shape | **Single Next.js app** — UI, route handlers, orchestrator, ingestion CLI, eval runner as scripts. One deployable, reproducible in under an hour (§17). |
| D3 | Corpus | **Agent writes a fetcher + starter source list** into `sources/manifest.json`; user verifies availability/licensing *together* with the agent before ingest (§5). |
| D4 | First milestone | **Phase 0 + Phase 1 only**: skeleton, ingestion, naive single-call RAG with streaming citations. Stop, run it, then decide. |

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

### Phase 0 — Decisions & skeleton *(current phase)*

- [x] Rewrite design doc as `DESIGN.md` with all GRRA references renamed to **Regulus**; resolve §20 open questions with the defaults in §1 above; fold the empty `designdoc.md` into it *(old docs deleted; §20 now a Resolved section)*
- [x] Make the first git commit ✅ `5d8d975` *(26 files; `.env` excluded via gitignore, `.env.example` tracked)*
- [x] Write `SPEC.md` (§10.1): scope (Ghana tax and business regulation only), tool contracts, risk tiers (calculator results higher risk than definitions), when to abstain / tell user to consult a professional, answer contract, hard limits
- [x] Scaffold Next.js app *(Next.js 16.4.5 App Router, TypeScript, Tailwind 4, ESLint flat config — v16 notes: Turbopack default, async-only `params`/`headers`, `next lint` removed, `middleware`→`proxy`)*
- [x] DB schema per §12: Document, Chunk, Conversation, Message, Trace, EvalSet, EvalCase, EvalRun, EvalResult — **Drizzle** (`db/schema.ts`, 9 tables, pgvector custom type), first migration generated (`db/migrations/0000_*` incl. `CREATE EXTENSION vector`); replaces the Prisma version after owner decision 2026-11-06
- [ ] Provision Postgres with pgvector (Neon or Supabase) + `.env`; secrets in env vars only, never client-side (§15) — **BLOCKED: owner must pick Neon vs Supabase (§5) and supply `DATABASE_URL`**
- [x] `lib/gateway.ts`: model selection (named tiers), retries with backoff, timeouts, token/cost accounting, prompt version tagging, structured trace log per call
- [x] `sources/manifest.json` structure (`url, publisher, publishedAt, termsChecked, contentHash`) + starter candidate source list (6 candidates, all `termsChecked: false`)
- [ ] **Exit:** app runs ✅ *(HTTP 200; typecheck/lint/build all pass)* · schema migrates ⏳ *(needs DATABASE_URL)* · one traced gateway call ⏳ *(needs OPENAI_API_KEY → `npm run smoke:gateway`)*

### Phase 1 — Ingestion + naive RAG

**Ingestion (§5)**
- [ ] Fetcher: download sources, store raw copy + content hash
- [ ] **Gate:** human inspects parsed text dump — headings, section numbers, tables must survive before proceeding (§19 risk #1). Prefer HTML sources where PDF parsing fails.
- [ ] Chunk on legal structure (Part/Section/Subsection), fallback 300–600 tokens with small overlap; prefix each chunk with its section path (`VAT Act > Part II > Section 7`)
- [ ] Enrich metadata: document, section path, effective date, source URL, page number
- [ ] Embed → pgvector; build Postgres full-text index for keyword search (used in Phase 3, index now)
- [ ] Versioning: re-ingest marks old chunks `supersededAt`, never deletes — answers stay reproducible (§5 step 6)
- [ ] **Target: 20 documents ingested**

**Naive RAG path (§7, kept forever as baseline)**
- [ ] Single call: vector top-k → assemble context with fixed token budget, passages ordered by relevance, stable `[S1]…[Sn]` IDs
- [ ] Answer format: short direct answer first, then explanation; inline citations → clickable source cards (document, section, page, link)
- [ ] Abstention: explicit "Not found in the sources" when evidence insufficient
- [ ] Disclaimer footer on every answer ("not professional advice", §15)
- [ ] Prompt-injection defense from day one (§9): retrieved text wrapped in clearly delimited blocks, treated as data; system prompt states instructions inside sources must be ignored

**App surface (§13, §14)**
- [ ] `POST /api/chat`: streams answer + citation/trace events via SSE
- [ ] `GET /api/sources/:id`: passage + document metadata for a citation
- [ ] Chat UI: streaming text, inline citation chips, side panel showing cited passage in context
- [ ] Mobile-friendly layout (users in Ghana are often on phones, §14)
- [ ] **Exit:** 20 docs ingested, citations render and open the real source passage (§18 Phase 1)

**Explicitly NOT in this milestone:** agents, reranking, query rewriting, calculator, verifier,
eval harness, dashboard, caching, admin UI. Evals are Phase 2; agents only if evals justify (§8).

### Phase 2 — Eval harness (§10)

**Spec & trace model**
- [ ] `SPEC.md` written (done in Phase 0) — keep it current as scope changes
- [ ] Trace data model **before taking any traffic**: nested spans for every agent step, retrieval call, model call, tool call, permission denials, prompt hashes
- [ ] Store traces in Postgres (all evaluators read the same trace format)
- [ ] Simple trace review interface for reading whole traces (needed for step below)

**Ground truth**
- [ ] `facts.yaml`: rates, thresholds, deadlines, section numbers → each linked to its source passage; exact-match checks and the calculator read from it
- [ ] Smoke report (error rate, empty retrievals, answer rate) run **before** labeling anything

**Scenario set**
- [ ] ~300 scenarios generated from corpus + facts.yaml across §4 query types: lookup, multi-document, calculation, out-of-scope, adversarial
- [ ] Human reviews every scenario before it enters the set
- [ ] Replace synthetic questions with real ones from user feedback over time (via `/api/feedback`)

**Error analysis (human-owned)**
- [ ] Read ≥60 whole traces in the review UI; note first failure in plain language (open coding)
- [ ] Group notes into 5–8 binary failure modes with definitions, examples, boundary cases (axial coding); stop at saturation
- [ ] Compare against published RAG taxonomies **only after** building our own
- [ ] Never let an LLM label everything — judges are validated against human labels, never substituted for them
- [ ] Confirm or discard these starting hypotheses: cites unretrieved passage ID (code) · citation doesn't support claim (judge) · number/rate/date contradicts facts.yaml (code) · calculator needed but not called (code) · answers unanswerable instead of abstaining (code + judge) · cites superseded version (code) · follows instruction embedded in source/user message (code + judge)

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

- [ ] Daily budget cap for model + hosting costs (dollar figure)?
- [ ] Neon vs Supabase for the Postgres instance?
- [ ] Confirm the exact v1 source list and verify each source's terms of use/licensing (§5 — human check, required before ingest)
- [ ] Which specific acts and guidance notes make the v1 cut

---

## 6. Change log (append-only)

| Date | Change | By |
|---|---|---|
| 2026-11-06 | Plan drafted: D1–D4 decisions locked, Phase 0+1 scoped, progress tracker created | planning session |
| 2026-11-06 | Expanded to full end-to-end: Phases 2–6 broken into checklists, §9/§10.6/§10.7/§13/§14/§16/§17/§21 gaps filled, cross-cutting section added | planning session |
| 2026-11-06 | Phase 0 in progress: DESIGN.md (Regulus rename + §20 resolved), SPEC.md, Next 16.4.5 scaffold, Prisma §12 schema (valid), lib/gateway.ts, sources/manifest.json (6 candidates), smoke:gateway script. Verified: typecheck/lint/build pass, dev server HTTP 200. Blocked: DATABASE_URL (Neon vs Supabase) + OPENAI_API_KEY. Old docs deleted. | implementation session |
| 2026-11-06 | **Stack change (owner decision): Prisma → Drizzle.** Removed prisma/@prisma/client; added drizzle-orm/drizzle-kit/pg. `db/schema.ts` = §12 (9 tables, pgvector custom type), `db/index.ts` client, `drizzle.config.ts`, migration `0000` (+`CREATE EXTENSION vector`), npm scripts `db:generate/migrate/push/studio`. DESIGN.md §6/§12 wording updated. Typecheck/lint/build pass. | implementation session |

---

## 7. How to use this file

1. **Agents:** read this file first in every session. Update section 2 (status board) and
   section 3/4 (checkboxes) as work completes. Append to the change log (section 6).
2. **Never** remove a locked decision (section 1) without recording the change in the change log.
3. A phase is only `DONE` when its **exit criteria** are met and verified by running the code.
4. When context feels stale, re-read section 1 and section 2 — they are the compressed plan.
5. Section 3 is the checklist of record: nothing ships that isn't checked off here first.
