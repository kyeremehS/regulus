# Regulus

**A research assistant you can check.** Regulus answers questions about Ghanaian tax and business regulation — VAT registration, corporate income tax, company incorporation, employer obligations — and cites the exact source passage behind every answer, with a hard rule: when the sources don't support an answer, it says *"Not found in the sources"* instead of guessing.

Built as a production-style RAG and agent system with an eval harness and a cost/quality/latency dashboard. Every claim is traceable, every prompt change is gated by evals, and every point on the quality-vs-cost curve is measured.

> **Status: Phase 1 complete — the thing works.** 20 official documents (Ghanaian tax & business law), 1,856 searchable passages, a live chat UI with clickable citations, full trace recording per turn. Phase 2 (eval harness) in progress — first baseline scored **75.9%** on 29 golden cases (see [Results](#baseline-results--measured-not-claimed)). Not yet deployed.

**Documentation:** [DESIGN.md](DESIGN.md) (the full design) · [SPEC.md](SPEC.md) (the working spec evals test against) · [progress.md](progress.md) (build tracker, change log)

## What it does (today)

- **Answers with citations you can open.** Every regulation claim carries an inline `[S#]` citation that renders as a source card — document, section, page, link back to the official source.
- **Abstains when it should.** Out of scope, unsupported, or conflicting sources → an explicit "not found", never a confident guess. Over-refusal is tracked as its own failure mode.
- **Keeps the corpus honest.** Re-ingesting a changed Act supersedes old chunks instead of deleting them, so yesterday's answer stays reproducible and superseded citations are flagged.
- **Traces every turn.** Each question stores its retrieval results, spans, tokens, cost and latency — readable in `/admin/traces` with one-click copy for analysis.
- **Measures itself.** A golden set, binary evaluators (code where objective, LLM judge only where interpretive), and (Phase 2–3) a CI gate that blocks a prompt change from merging if it regresses quality.
- **Tracks what it costs.** Every model call logs tokens, dollars, latency and prompt version.

**Planned, not yet built** (Phases 4–5): deterministic PAYE/VAT calculator tool, multi-agent orchestration (planner/verifier), quality-vs-cost dashboard.

## The eval harness — the point of the project

Agentic RAG is non-deterministic: an LLM plans, retrieval varies, steps branch. Nothing about it holds in production on vibes alone. Regulus is built so that **no change ships unmeasured** — prompts, retrieval settings, models and agents are all versioned artifacts tested against a fixed workload, and regressions block the merge.

**How quality is defined here:** not with a generic metric list, but with a failure taxonomy built from reading our own traces — start from data, not benchmarks.

| Layer | How it's measured |
| --- | --- |
| Failure modes (hallucinated citation, unsupported claim, wrong number, missing calculator call, no abstention, superseded citation, prompt injection) | One **binary evaluator** per mode — code where objective, LLM judge only where interpretive, always validated against human labels (TPR/TNR reported, never accuracy alone) |
| Retrieval | Recall@k and MRR against required passages |
| Numbers & calculator | Exact match against `facts.yaml` — deterministic ground truth linked to source passages |
| Abstention | Correct-abstain rate on the unanswerable subset |
| Reliability | pass^k (every run passes) and pass@k (any run passes), k = 3–5 |
| Operations | p50/p95 latency, cost per query, tokens — from gateway logs |

**The loop:**

1. **SPEC.md first** — scope, tool contracts, risk tiers, abstention rules. You can't measure what you haven't specified.
2. **Traces before traffic** — nested spans for every agent step, retrieval call, model call, tool call, with prompt hashes. Every evaluator reads the same trace format.
3. **Human-owned error analysis** — read 60+ whole traces, open-code the first failure in each, group into 5–8 binary failure modes. Judges are validated against these labels, never substituted for them.
4. **CI gate** — deterministic checks on every commit, mocked integration on every PR, full agent evals nightly and on any prompt/retrieval/model change. A regression beyond threshold = merge blocked, summary table posted.
5. **After deploy** — code checks on all traffic, frozen judges on a ~5% sample, corrected prevalence on a dashboard. Every production failure becomes a new test case.

The naive single-call RAG baseline stays in the codebase forever, so every agent and every optimization has to prove its delta against it — measured, with the numbers documented.

## Baseline results — measured, not claimed

The naive single-call pipeline's first full score on the golden set (`evals/golden-v0.1.yaml`, 29 cases covering lookup, synthesis, calculation, abstention and adversarial questions). **This is the number every future phase must beat** — retrieval upgrades, agents, models, prompts. Reproduce with `npm run eval:run`.

*Recorded 2026-11-27 (v0.6.0), corpus v0.1.0 (20 docs / 1,856 chunks), prompt `answerer-naive@1.0.0`, free-tier models:*

| Metric | Baseline |
| --- | --- |
| **Case pass rate** | **75.9% (22/29)** |
| — ordinary questions | 15/17 |
| — conflicting-law questions | 3/5 |
| — correct-abstain on unanswerable questions | 4/5 |
| — calculation questions (no calculator tool yet) | 0/2 *(by design)* |
| Retrieval Recall@8 (required passages in top 8) | 0.667 |
| Citation errors (cited a passage that wasn't retrieved) | 1 |
| Latency p50 / p95 | 13.3s / 110s *(free-tier model)* |
| Cost of the full 29-case run | $0.0000076 |

**What the failures teach** (Phase 2's raw material): withholding-tax rate facts missed by retrieval; one abstention failure in each direction (answered instead of refusing, refused instead of answering); a model timeout on the free tier; and one golden case that may itself be wrong — the model now argues the VAT flat rate is *gone* under Act 1151, citing GRA's own conversion guidance, which contradicts the case's reference. Owner fact-review pending: sometimes the test is what needs fixing.

Run snapshots: persisted `eval_runs`/`eval_results` rows (the record) + local `evals/runs/*.json` (gitignored); per-case traces in `/admin/traces` (question prefix `[eval:`). Before/after comparison tables land here when Phases 3–6 complete (§21).

## How it works

**What runs today** (the §7 baseline, kept in the codebase forever):

1. Embed the question (1536-dimension vector, same model as the corpus) → top-8 vector search over live pgvector chunks
2. Assemble a fixed-token-budget context with stable `[S1]…[Sn]` ids, wrapped in injection-resistant `<source>` blocks
3. One streamed LLM call with the versioned system prompt → cited answer, or "Not found in the sources"
4. Persist conversation, citations, and spans (embed → retrieval → answer) to Postgres

**Planned pipeline** (Phases 3–4 — every step must prove its delta against the baseline above):

1. Gateway checks the response cache (keyed on query + corpus version + prompt version)
2. Planner classifies the query and picks tools
3. Retriever runs hybrid search (vector + keyword, fused) and reranks
4. Answerer streams a cited answer from the assembled context
5. Verifier checks each claim against its cited passage — revise, or downgrade to "partially supported"
6. Traces, tokens, cost and latency land in Postgres

## Repository

| Part | What it is |
| --- | --- |
| `app/` | Next.js 16 app: chat UI, route handlers, admin pages |
| `lib/gateway.ts` | The only place the app talks to a model API — retries, cost accounting, prompt version tagging |
| `db/` | Drizzle schema (§12), migrations, client — Postgres + pgvector |
| `scripts/` | Ingestion pipeline, eval runner, smoke tests |
| `sources/` | Corpus manifest: URLs, publishers, licensing status, content hashes |
| `DESIGN.md` | Full design doc: architecture, RAG, agents, eval harness, milestones |
| `SPEC.md` | Scope, tool contracts, risk tiers, abstention rules — what evals test against |
| `progress.md` | Build tracker: decisions locked, phase status, checklists |

## Getting started

**Prerequisites:** Node 20.9+, a Postgres database with pgvector ([Neon](https://neon.tech) or [Supabase](https://supabase.com)), an [OpenRouter](https://openrouter.ai/settings/keys) API key (free tier works — the free `:free` chat models cost $0; embeddings cost ~$0.009 for the whole corpus).

```bash
git clone https://github.com/kyeremehS/regulus.git && cd regulus
npm install
cp .env.example .env      # then fill in OPENROUTER_API_KEY and DATABASE_URL

npm run db:migrate        # create tables + pgvector extension
npm run smoke:gateway     # verify one traced model call
npm run embed             # load the corpus into pgvector (+ FTS index)
npm run dev               # http://localhost:3000
```

Ask a question in the UI, click an `[S#]` chip to open the cited passage, then open `http://localhost:3000/admin/traces` to see the full trace of what just happened (set `ADMIN_KEY` in `.env` before deploying).

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js (Turbopack) |
| `npm run typecheck` / `lint` | TS + ESLint, both clean |
| `npm run smoke:gateway` | One traced model call; prints tokens/cost/prompt version |
| `npm run eval:run` | Score all golden cases → [Results](#baseline-results--measured-not-claimed) |
| `npm run eval:validate` | Structural check of facts/golden YAML against the corpus |
| `npx tsx scripts/fetch.ts` / `parse.ts` / `chunk.ts` / `enrich.ts`, then `npm run embed` | Ingestion pipeline (DESIGN §5) — re-ingest marks superseded chunks, never deletes |
| `npm run db:generate` / `db:migrate` / `db:push` | Drizzle migrations |
| `npm run db:studio` | Browse tables in a GUI |

## Versioning

SemVer git tags: **`vMAJOR.MINOR.PATCH`** — MAJOR = a phase from the roadmap completes, MINOR = new capability within a phase, PATCH = fixes and docs. Each tag ships with a GitHub Release whose notes come from the tracker's change log. Current: **`v0.6.0`** (eval runner + baseline; [all releases](https://github.com/kyeremehS/regulus/releases)). See [progress.md](progress.md) §1 (decision D5).

## Roadmap

The build follows [DESIGN.md §18](DESIGN.md) — each phase has exit criteria recorded in [progress.md](progress.md):

| Phase | Deliverable | Exit criteria | Status |
| --- | --- | --- | --- |
| ✅ 0. Skeleton | Docs, schema, gateway, manifest | App runs, schema migrates, traced call | DONE 2026-11-16 |
| ✅ 1. Foundations | Ingestion + naive RAG with citations | 20 documents, citations render | DONE 2026-11-27 |
| 🔵 2. Eval harness | Traces, facts file, labeled failure taxonomy, CI gate | Baseline failure prevalence with CIs | WIP — baseline scored (75.9%) |
| 3. Retrieval | Hybrid search, reranking, query rewriting | Recall@k improves over baseline (now: > 0.667) | |
| 4. Agents | Planner, calculator, verifier | Beats or matches baseline, delta documented | |
| 5. Optimization | Routing, caching, dashboard | Measurable cost/latency win at equal quality | |
| 6. Production | Deploy, rate limits, README eval tables | Public demo + before/after numbers | |

## What this is not

Regulus is a **research aid, not legal or tax advice**. It is deliberately narrow — scope is the corpus in `sources/manifest.json`, nothing more — and it says so in the UI and in every answer footer. Every turn's trace records the corpus version and prompt version the answer drew from.

## Development notes

Built with heavy AI assistance (OpenCode) and owner verification — the process itself is part of the deliverable:

- **Every phase closes on running code:** typecheck, lint, build, smoke tests pass, live end-to-end verification, then a tag. Nothing is marked done in [progress.md](progress.md) without its exit criteria met and recorded.
- **Human gates stay human:** source licensing terms, parse quality, and golden-case semantics are owner decisions — the AI researches and executes, the owner approves (this is logged per-source in `sources/manifest.json`).
- **An append-only change log** (`progress.md` §6) records every decision — including mistakes (transient DB failures, a hydration bug, a stream-corruption bug caught by live tests) and corrections (the "OpenRouter has no embeddings" probe that hit the wrong API endpoint).
- **Evals before vibes:** the failure-mode taxonomy comes from reading our own traces, not benchmarks — judges will be validated against human labels, never substituted for them.

Eval results tables (baseline vs. final system: correctness, faithfulness, abstention, cost, latency) grow here as phases land — the baseline is already in [Results](#baseline-results--measured-not-claimed).

## License

TBD.
