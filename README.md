# Regulus

**A research assistant you can check.** Regulus answers questions about Ghanaian tax and business regulation — VAT registration, corporate income tax, company incorporation, employer obligations — and cites the exact source passage behind every answer, with a hard rule: when the sources don't support an answer, it says *"Not found in the sources"* instead of guessing.

Built as a production-style RAG and agent system with an eval harness and a cost/quality/latency dashboard. Every claim is traceable, every prompt change is gated by evals, and every point on the quality-vs-cost curve is measured.

> **Status: Phase 0 complete (skeleton).** Ingestion, RAG, agents and evals are specified in [DESIGN.md](DESIGN.md) and tracked in [progress.md](progress.md). Not yet deployed.

**Documentation:** [DESIGN.md](DESIGN.md) (the full design) · [SPEC.md](SPEC.md) (the working spec evals test against) · [progress.md](progress.md) (build tracker)

## What it does

- **Answers with citations you can open.** Every regulation claim carries an inline `[S#]` citation that renders as a source card — document, section, page, link back to the official source.
- **Abstains when it should.** Out of scope, unsupported, or conflicting sources → an explicit "not found", never a confident guess. Over-refusal is tracked as its own failure mode.
- **Calculates, deterministically.** PAYE and VAT math runs through a calculator tool reading rates from a versioned facts file — never from model memory.
- **Keeps the corpus honest.** Re-ingesting a changed Act supersedes old chunks instead of deleting them, so yesterday's answer stays reproducible and superseded citations are flagged.
- **Measures itself.** A golden set, binary evaluators (code where objective, LLM judge only where interpretive), and a CI gate that blocks a prompt change from merging if it regresses quality.
- **Tracks what it costs.** Every model call logs tokens, dollars, latency and prompt version; a dashboard plots quality against cost per configuration.

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

## How it works

One question, one traced pipeline:

1. Gateway checks the response cache (keyed on query + corpus version + prompt version)
2. Planner classifies the query and picks tools
3. Retriever runs hybrid search (vector + keyword, fused) and reranks
4. Answerer streams a cited answer from the assembled context
5. Verifier checks each claim against its cited passage — revise, or downgrade to "partially supported"
6. Traces, tokens, cost and latency land in Postgres

A single-call baseline RAG path stays in the codebase forever: every agent added later has to beat it in evals, and the delta gets documented.

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

**Prerequisites:** Node 20.9+, a Postgres database with pgvector ([Neon](https://neon.tech) or [Supabase](https://supabase.com)), an OpenAI API key.

```bash
git clone https://github.com/kyeremehS/regulus.git && cd regulus
npm install
cp .env.example .env      # then fill in OPENAI_API_KEY and DATABASE_URL

npm run db:migrate        # create tables + pgvector extension
npm run smoke:gateway     # verify one traced model call
npm run dev               # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js (Turbopack) |
| `npm run typecheck` / `lint` | TS + ESLint, both clean |
| `npm run smoke:gateway` | One traced model call; prints tokens/cost/prompt version |
| `npm run db:generate` / `db:migrate` / `db:push` | Drizzle migrations |
| `npm run db:studio` | Browse tables in a GUI |

## Roadmap

The build follows [DESIGN.md §18](DESIGN.md) — each phase has exit criteria recorded in [progress.md](progress.md):

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| ✅ 0. Skeleton | Docs, schema, gateway, manifest | App runs, schema migrates, traced call |
| 1. Foundations | Ingestion + naive RAG with citations | 20 documents, citations render |
| 2. Eval harness | Traces, facts file, labeled failure taxonomy, CI gate | Baseline failure prevalence with CIs |
| 3. Retrieval | Hybrid search, reranking, query rewriting | Recall@k improves over baseline |
| 4. Agents | Planner, calculator, verifier | Beats or matches baseline, delta documented |
| 5. Optimization | Routing, caching, dashboard | Measurable cost/latency win at equal quality |
| 6. Production | Deploy, rate limits, README eval tables | Public demo + before/after numbers |

## What this is not

Regulus is a **research aid, not legal or tax advice**. It is deliberately narrow — scope is the corpus in `sources/manifest.json`, nothing more — and it says so in the UI and in every answer footer. Regulations change; every answer shows the corpus version and "last updated" date it drew from.

## Development notes

Built with heavy AI assistance (OpenCode), with verification by hand: every phase closes on running code — typecheck, lint, build, and smoke tests pass — and design decisions are recorded in `progress.md`'s change log. Eval results tables (baseline vs. final system: correctness, faithfulness, abstention, cost, latency) land here in Phase 6.

## License

TBD.
