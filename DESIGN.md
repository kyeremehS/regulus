# **Design Doc: Regulus**

*A production-style RAG and agent app with a built-in eval harness and cost/latency dashboard*

**Status:** Draft v1 Â· **Author:** You Â· **Date:** November 6, 2026

## **1\. Overview**

The Regulus answers questions about Ghana tax and business regulation (for example, VAT registration, corporate income tax, company incorporation, and employer obligations). Every answer cites the exact source passages it relies on. The product is deliberately narrow so that quality can be measured rigorously.

The project has a second purpose: it is a portfolio piece for an AI Software Engineer role. It is built to demonstrate end-to-end ownership, from the product surface to the model-facing layer, with quality, cost, and latency treated as engineering constraints and measured at every step.

## **2\. Goals and Non-Goals**

### **Goals**

* Deliver accurate, cited answers over a curated corpus of Ghanaian regulatory documents.  
* Implement retrieval, RAG, agent planning, tool use, and multi-agent orchestration on top of frontier model APIs.  
* Treat prompts and context as versioned, tested artifacts, with evals running in CI.  
* Expose cost, latency, and quality per model and prompt version in a dashboard.  
* Ship to production with streaming, caching, tracing, and rate limiting.

### **Non-Goals**

* Providing legal or tax advice. The product is a research aid and says so in the UI.  
* Fine-tuning models or hosting your own LLMs.  
* Multi-tenant auth, billing, or enterprise features.  
* Covering all of Ghanaian law. Scope is limited to the corpus defined in section 5\.

## **3\. Mapping to the Job Posting**

| Posting requirement | Where it shows up in this project |
| :---- | :---- |
| Ship production-quality AI features across the stack | Next.js app, API routes, Postgres, deployed instance |
| Retrieval and RAG pipelines on frontier APIs | Ingestion, hybrid retrieval, reranking, cited answers |
| Agent planning, tool use, multi-agent orchestration | Planner, retriever, calculator, and verifier agents |
| Prompt and context engineering as a tested practice | Versioned prompts, context budgeting, regression tests |
| Wire evals into the development loop | Golden set, LLM-as-judge, CI gate on every prompt change |
| Optimize cost, quality, latency | Model routing, caching, trade-off dashboard |
| Use AI dev tools to increase velocity | Documented in the README (what was AI-assisted and how it was verified) |
| Own systems from concept to production | This doc, the build, the deployment, the postmortem notes |

## **4\. Users and Use Cases**

**Primary user:** a small-business owner, accountant, or startup founder in Ghana who needs a quick, trustworthy answer with a pointer to the source.

**Example queries:**

* "Do I need to register for VAT if my annual turnover is GHS 500,000?"  
* "What are the filing deadlines for corporate income tax for a new company?"  
* "Calculate the PAYE on a monthly salary of GHS 8,000." (requires a calculator tool)  
* "What documents do I need to incorporate a limited liability company?"

**Query types the system must handle:**

1. Single-passage factual lookups  
2. Multi-document synthesis  
3. Calculation questions that need rules plus arithmetic  
4. Out-of-scope or unanswerable questions, where the correct behavior is to decline or say "not found in sources"

## **5\. Corpus and Ingestion**

### **Sources (public, official where possible)**

* Ghana Revenue Authority guidance notes and published tax rates  
* Acts and amendments (for example, Income Tax Act, VAT Act, Companies Act) from official gazette or parliamentary publications  
* Registrar General's Department incorporation guidance

Before ingesting, confirm each source's terms of use and record its URL, publication date, and version in the metadata. Prefer official PDFs and pages.

### **Ingestion pipeline**

1. **Fetch:** download source files and store the raw copy with a content hash.  
2. **Parse:** extract text from PDFs and HTML while preserving structure (headings, section numbers, tables). OCR only if needed.  
3. **Chunk:** split on legal structure (part, section, subsection) first, then by token size (target 300â€“600 tokens, with small overlap). Each chunk keeps its section path as a prefix, for example "VAT Act \> Part II \> Section 7".  
4. **Enrich:** attach metadata: document, section path, effective date, source URL, page number.  
5. **Embed:** generate embeddings and store them in pgvector. Also build a Postgres full-text index for keyword search.  
6. **Version:** re-ingesting a changed document creates a new version. Old chunks are marked superseded, not deleted, so answers remain reproducible.

## **6\. System Architecture**

**Components**

* **Web app (Next.js \+ TypeScript):** chat UI with streaming, citation previews, and an admin area for evals and the dashboard.  
* **API layer (Next.js route handlers or a small Node service):** auth-light session handling, rate limiting, request validation, orchestration entry point.  
* **Orchestrator:** runs the agent graph for each query and emits trace events.  
* **Retrieval service:** hybrid search (vector plus keyword), reranking, and context assembly.  
* **Model gateway:** a single wrapper around the model API providing model selection, retries, timeouts, caching, token and cost accounting, and prompt version tagging.  
* **Postgres (Prisma \+ pgvector):** documents, chunks, embeddings, conversations, traces, eval runs.  
* **Eval runner:** a CLI plus CI job that executes the golden set against a given prompt and model configuration.  
* **Observability:** structured logs and traces for every model call and tool call.

**Request flow**

1. User submits a question.  
2. The gateway checks the response cache (keyed on normalized query, corpus version, and prompt version).  
3. The planner (small, fast model) classifies the query and produces a plan.  
4. The retriever agent runs one or more searches. The calculator tool runs if the plan calls for it.  
5. The answerer (larger model) drafts a cited answer from the assembled context, streaming tokens to the UI.  
6. The verifier checks that each claim is supported by a cited passage. If not, it triggers one revision pass or downgrades the answer to "partially supported".  
7. Traces, token counts, cost, and latency are written to Postgres.

## **7\. RAG Design**

### **Retrieval**

* **Hybrid search:** top-k from vector similarity and top-k from keyword search, merged with reciprocal rank fusion.  
* **Reranking:** a cross-encoder or an LLM-based reranker narrows the merged list (for example, 30 down to 6).  
* **Query rewriting:** the planner can rewrite or decompose the question (for example, splitting a multi-part question into sub-queries).  
* **Metadata filters:** filter by document, act, or effective date when the query implies them.

### **Context assembly**

* Fixed token budget for context, with passages ordered by relevance.  
* Each passage is labeled with a stable ID (for example, \[S3\]) that the model must cite.  
* Adjacent chunks from the same section are merged to avoid fragmented evidence.

### **Answer format**

* Short direct answer, then supporting explanation.  
* Inline citations that map to passage IDs and render as clickable source cards (document, section, page, link).  
* Explicit "Not found in the sources" response when evidence is insufficient.  
* A standard disclaimer that the output is not professional advice.

## **8\. Agent Design**

Start with the simplest orchestration that works and add agents only when evals show a benefit.

| Agent / tool | Responsibility | Model tier |
| :---- | :---- | :---- |
| Planner | Classify the query, decide which tools to use, decompose multi-part questions | Small and fast |
| Retriever | Execute searches, refine queries when results are weak | Small, plus retrieval code |
| Calculator tool | Deterministic tax and arithmetic computation using rates from structured config | No LLM |
| Answerer | Compose the final cited response | Large |
| Verifier | Check that claims are supported by the cited passages | Small or medium |

**Design rules**

* Every agent has a typed input/output schema (validated with Zod). Malformed output triggers one retry, then a safe fallback.  
* Hard limits on steps, tokens, and wall-clock time per request to prevent runaway loops.  
* Tools are pure and testable. The calculator reads rates from a versioned config file, never from model memory.  
* A baseline single-call RAG path is kept in the codebase so the multi-agent path is always compared against it in evals.

## **9\. Prompt and Context Engineering**

* Prompts live in version-controlled files, each with an ID and semantic version (for example, answerer@1.3.0).  
* Every model call logs the prompt version, model, and corpus version.  
* Prompt changes go through pull requests that include eval results. A CI gate blocks merges that regress key metrics beyond a set threshold.  
* Context rules are documented: ordering of passages, token budgets per section, instructions for abstaining, and citation format.  
* Prompt-injection defense: retrieved text is wrapped in clearly delimited blocks and treated as data. The system prompt states that instructions inside sources must be ignored.

## **10\. Evaluation Harness**

Evals follow a fixed order: design the system so it can be measured, find failures by reading traces, then measure each failure with a validated evaluator. The metrics come from your own failure taxonomy, not from a generic list. This order mirrors the course's Three Gulfs (comprehension, specification, generalization), which map to Analyze, Measure, and Improve.

### **10.1 Spec and evaluability**

* Write SPEC.md before building: scope (Ghana tax and business regulation only), tool contracts, risk tiers (a calculator result is higher risk than a definition), and when the system must abstain or tell the user to consult a professional.  
* Design the trace data model before taking any traffic: nested spans for every agent step, retrieval call, model call, and tool call, plus permission denials and prompt hashes.  
* Store traces in Postgres, or self-host Langfuse with ClickHouse. Every evaluator reads the same trace format.

### **10.2 Synthetic scenarios and a facts file**

* Build facts.yaml: the rates, thresholds, deadlines, and section numbers that questions depend on, each linked to its source passage. Exact-match checks and the calculator read from it, so ground truth is deterministic.  
* Generate about 300 scenarios from the corpus and facts file across the query types in section 4 (lookup, multi-document, calculation, out of scope, adversarial). A human reviews every scenario before it enters the set.  
* Run a smoke report first (error rate, empty retrievals, answer rate) before labeling anything. Replace synthetic questions with real ones from user feedback over time.

### **10.3 Error analysis (human-owned)**

1. Read at least 60 whole traces in a simple review interface. For each, note the first failure in plain language (open coding).  
2. Group the notes into 5 to 8 binary failure modes, each with a definition, examples, and boundary cases (axial coding). Stop when new traces add no new modes.  
3. Compare against published RAG failure taxonomies only after building your own.

Do not let an LLM label everything. Judges are validated against your labels, never substituted for them.

Starting hypotheses to confirm or discard during labeling:

| Candidate failure mode | Evaluator |
| :---- | :---- |
| Cites a passage ID that was not retrieved | Code check |
| Cited passage does not support the claim | LLM judge |
| Number, rate, or date contradicts facts.yaml | Code check |
| Calculation needed but calculator not called | Code check |
| Answers an unanswerable question instead of abstaining | Code check plus judge |
| Cites a superseded document version | Code check |
| Follows an instruction embedded in a source or user message | Code check plus judge |

### **10.4 Evaluators and metrics**

* One binary pass/fail evaluator per failure mode. Use code for objective failures and an LLM judge only where interpretation is needed.  
* Split labeled traces into train (examples for the judge prompt), dev (iteration), and test (frozen; read once at the end).  
* Report each judge's true positive rate and true negative rate on the test split, not accuracy alone. Use them to correct prevalence estimates and report bootstrap confidence intervals.  
* Evaluate subsystems the same way: retrieval, grounding, and abstention each get their own evaluators.

| Layer | Metric | Method |
| :---- | :---- | :---- |
| Failure modes | Prevalence with 95% bootstrap CI, corrected by judge TPR/TNR | Binary evaluators on a fixed workload |
| Retrieval | Recall@k, MRR | Code, against required passages |
| Numbers and calculator | Exact match | Code, against facts.yaml |
| Abstention | Correct-abstain rate | Unanswerable subset |
| Reliability | pass^k (all k runs pass) and pass@k (any run passes) | Repeated runs, k \= 3 to 5 |
| Operational | p50/p95 latency, cost per query, tokens | Gateway logs |

### **10.5 CI/CD regression suite**

* Convert every labeled failure into a test case: input, expected result, and initial state (corpus version, conversation history).  
* Mechanical failures become code assertions. Subjective failures become pinned judge checks, with the judge prompt and model frozen.  
* Run in cost tiers: deterministic checks on every commit, mocked integration (recorded retrieval and model responses) on every pull request, and full agent evals nightly and on any prompt, retrieval, or model change.  
* Use pass^k for reliability and pass@k for capability. Reset state and replay each case to measure failure rate.  
* A GitHub Actions gate blocks merges that raise any failure-mode rate beyond a set threshold and posts a summary table.  
* After deploy: code checks on all traffic, frozen judges on a sample (about 5%), and a dashboard with corrected prevalence and alerts. New production failures become new test cases.

### **10.6 Red-team and safety evals**

* Map the attack surface with the OWASP Top 10 for Agentic Applications. For this project the main risks are goal hijacking and context poisoning through ingested documents or user input.  
* Prompt injection has no reliable detector, so safety must hold even if the model is compromised. Enforce it in code: the system can only read the corpus and call the calculator, and no tool can write or send anything.  
* Run promptfoo against the running endpoint. Turn every successful attack into a failing adversarial test, then fix it.  
* Add input, output, and tool guards. Keep a short governance note structured on the NIST AI Risk Management Framework: purpose, known limits, monitoring, and which legal obligations apply, if any.

### **10.7 Improvement loop**

* Build a comparable frontier: every point uses the same prompts, tools, harness, workload, and suite. Vary one axis at a time.  
* Route each fix to the cheapest effective layer: prompt first, then tool design, then harness, then model.  
* Fix your top failure mode by hand before using automated prompt optimization (for example GEPA). Guard against reward hacking by checking winners on the frozen test split and reading sample traces.  
* Keep several points on the Pareto frontier (cheapest acceptable, best quality) stored as configs. When a new model ships, re-run the suite, redraw the frontier, and decide what to deploy, keep, or retire.  
* Cost levers are in section 11\. Profile first: history growth, retrieval depth, and repeated tool schemas are the usual culprits.

## **11\. Cost, Quality, and Latency Optimization**

**Dashboard views**

* Quality vs. cost scatter plot, one point per configuration (model, prompt version, retrieval settings).  
* Latency breakdown per stage (retrieval, planning, generation, verification).  
* Cost per query over time and per query type.

**Levers to explore (each measured against the eval suite)**

1. Model routing: small model for planning and verification, large model for answers only.  
2. Response caching and embedding caching.  
3. Retrieval tuning: chunk size, top-k, reranker on or off.  
4. Context trimming to reduce input tokens.  
5. Streaming and parallel tool calls to improve perceived latency.  
6. Skipping the verifier on high-confidence simple queries.

**Target service levels (initial)**

* Time to first token under 1.5 seconds.  
* p95 full answer under 10 seconds for standard queries.  
* Cost per query tracked and capped, with a configurable daily budget that disables expensive paths when exceeded.

These targets are starting points. Revise them after the first baseline measurements.

## **12\. Data Model (Prisma, simplified)**

* Document: id, title, sourceUrl, publisher, publishedAt, version, contentHash  
* Chunk: id, documentId, sectionPath, text, pageNumber, tokenCount, embedding (vector), supersededAt  
* Conversation: id, createdAt  
* Message: id, conversationId, role, content, citations (JSON)  
* Trace: id, messageId, promptVersions (JSON), steps (JSON), totalTokens, costUsd, latencyMs  
* EvalSet: id, name, version  
* EvalCase: id, evalSetId, question, queryType, reference, requiredChunks (JSON), tags  
* EvalRun: id, evalSetId, configJson, gitSha, startedAt, summaryMetrics (JSON)  
* EvalResult: id, evalRunId, evalCaseId, answer, scores (JSON), costUsd, latencyMs

## **13\. API Surface**

* POST /api/chat: streams the answer and emits citation and trace events (server-sent events).  
* GET /api/sources/:id: returns the passage and document metadata for a citation.  
* POST /api/feedback: thumbs up/down plus an optional reason, used to grow the golden set.  
* GET /api/admin/evals, GET /api/admin/metrics: dashboard data (protected).

## **14\. Frontend**

* Chat interface with streaming text, inline citation chips, and a side panel showing the cited passage in context.  
* Visible "confidence/support" indicator driven by the verifier result.  
* Admin pages: eval run list, run-to-run diff, cost/quality scatter, latency breakdown, trace viewer.  
* Mobile-friendly layout, since many users in Ghana will be on phones.

## **15\. Reliability, Security, and Safety**

* Timeouts, retries with backoff, and fallback to a secondary model on provider errors.  
* Per-IP and per-session rate limiting, plus input length limits.  
* No sensitive personal data is requested or stored. Logs avoid storing raw user identifiers.  
* Secrets in environment variables only. API keys are never exposed to the client.  
* Prompt-injection and data-exfiltration tests are included in the eval suite.  
* Legal disclaimer in the UI and in every answer footer.

## **16\. Observability**

* A trace for every request with spans for each agent step, retrieval call, and model call, including prompt version, tokens, cost, and latency.  
* Structured JSON logs.  
* Alerts (even simple ones) for error rate, p95 latency, and daily cost thresholds.

## **17\. Deployment**

* Frontend and API on Vercel (or a similar host). Managed Postgres with pgvector (for example, Neon or Supabase).  
* Environments: local, preview (per pull request), and production.  
* CI pipeline: lint, type-check, unit tests, eval run on the dev set, then deploy.  
* Infrastructure kept small and documented so it can be reproduced in under an hour.

## **18\. Milestones**

| Phase | Deliverable | Exit criteria |
| :---- | :---- | :---- |
| 1\. Foundations | Repo, ingestion pipeline, basic RAG with citations | 20 documents ingested, citations render correctly |
| 2\. Eval harness | SPEC.md, trace model, 60+ labeled traces, failure taxonomy, binary evaluators, CI gate | Baseline failure-mode prevalence with confidence intervals recorded for the naive pipeline |
| 3\. Retrieval upgrade | Hybrid search, reranking, query rewriting | Recall@k improves against baseline |
| 4\. Agents | Planner, calculator, verifier | Multi-agent path beats or matches baseline on quality, with the delta documented |
| 5\. Optimization | Model routing, caching, dashboard | Measurable cost or latency reduction at equal quality |
| 6\. Production | Deployment, rate limits, tracing, README | Public demo link and a README with before/after eval tables |

## **19\. Risks and Mitigations**

| Risk | Mitigation |
| :---- | :---- |
| Poor PDF parsing hurts retrieval | Inspect parsed output early, use structure-aware chunking, add parsing tests |
| LLM judge is biased or noisy | Hand-label a sample, report agreement, use a different judge model |
| Overfitting prompts to the golden set | Maintain a held-out set and report it separately |
| Regulations change or documents are outdated | Store effective dates and versions, show a "last updated" date in answers |
| Costs grow during evals | Cache judge calls, sample on PRs, run the full suite nightly |
| Multi-agent complexity adds latency without quality gains | Keep the baseline path and require eval evidence for each added agent |
| Incorrect answer on a high-stakes topic | Verifier, abstention behavior, and a clear disclaimer |

## **20\. Open Questions — Resolved for v1**

Decisions recorded in `progress.md` (section 1). Summary:

* **v1 corpus:** Income Tax Act, VAT Act, Companies Act, GRA guidance notes, Registrar General's Department incorporation guidance. Each source's terms of use must be confirmed before ingest and recorded in `sources/manifest.json`.
* **Model provider:** OpenAI only for v1. Small/fast tier for planner, retriever, verifier, and judge; large tier for the answerer. Multi-provider fallback is added later, not in v1.
* **Reranker:** LLM-based reranking, no reranker API — keeps the stack simple. Revisit in Phase 3 if quality demands it.
* **Calculator scope:** PAYE and VAT only in v1. Corporate income tax is a later addition.
* **Budget cap:** configurable daily cap that disables expensive paths when exceeded (§11), set via environment variable. **Still open:** the actual dollar figure — pending from the owner.

## **21\. Success Criteria**

The project is successful when:

1. A public demo answers questions from the corpus with correct, verifiable citations.  
2. The README shows eval tables comparing the naive baseline to the final system on correctness, faithfulness, abstention, cost, and latency.  
3. At least one documented trade-off decision is backed by dashboard data (for example, "routing planning to a smaller model cut cost by X percent with no significant quality change").  
4. A new prompt change cannot be merged without passing the eval gate.
