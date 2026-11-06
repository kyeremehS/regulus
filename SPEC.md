# SPEC.md — Regulus v1

**Status:** Living spec · **Owner:** Samuel · **Last updated:** 2026-11-06

This is the working specification Regulus is built and evaluated against. Evals (§10 of DESIGN.md)
reference the rules here. Change this file through a PR that includes eval results.

---

## 1. Scope

**In scope:** answers about Ghanaian tax and business regulation, restricted to the v1 corpus:

- Income Tax Act
- VAT Act
- Companies Act
- Ghana Revenue Authority (GRA) guidance notes and published tax rates
- Registrar General's Department incorporation guidance

**Out of scope (system must decline, not guess):**

- Any law, regulation, or guidance not in the corpus
- Any jurisdiction other than Ghana
- Legal or tax **advice** (recommendations, opinions, strategy) — Regulus is a research aid
- Anything the sources do not support, even if the model "knows" the answer

## 2. Tool contracts

The system has exactly three capabilities. There is no write tool, no network tool beyond the
pre-approved corpus fetcher, and nothing that can send or transmit data (§10.6).

| Tool | Input | Output | Failure behavior |
|---|---|---|---|
| `search` | `{ query: string, topK?: number, filters?: { document?, effectiveDate? } }` | `{ passages: [{ id, documentId, sectionPath, text, sourceUrl, pageNumber, score }] }` | Empty list on error; caller may refine once |
| `calculator` | `{ kind: "paye" \| "vat", params: {...} }` | `{ result, inputs: [{ label, value }], rateSource: { factId, sectionPath } }` | Throws on unknown params; agent must report "calculation unavailable" |
| `fetch_passage` | `{ passageId: string }` | Full passage + document metadata | Error if passage not in current corpus version |

Rates, thresholds, and deadlines come from `facts.yaml` / versioned config — **never from model
memory** (§8).

## 3. Risk tiers

| Tier | Content | Requirement |
|---|---|---|
| **T1 — High** | Calculations, rates, thresholds, deadlines, filing dates | Exact match against `facts.yaml`; calculator tool must be used when arithmetic is involved; citation required |
| **T2 — Medium** | Definitions, procedural answers ("what documents are needed") | Citation required; claim must be supported by cited passage |
| **T3 — Low** | Scope/greeting/meta questions about Regulus itself | No citation required; must not fabricate regulation content |

Violating a tier is a failure mode in the eval suite: T1 without calculator, T2 without support,
or any T1/T2 answer without citations = failed case.

## 4. Abstention rules (when to say "not found")

Regulus must abstain — verbatim "Not found in the sources" or an explicit decline — when:

1. Retrieval returns no passage above the relevance floor for the core claim
2. The question is out of scope (see §1)
3. Sources conflict (e.g., superseded version vs. current) and the conflict can't be resolved by effective date
4. Evidence supports only part of a multi-part question — answer the supported part, abstain on the rest
5. The user asks for advice, opinion, or a recommendation rather than what the sources say

**Never abstain from:** refusing to answer a question the corpus clearly supports (over-refusal
is tracked as its own failure mode).

## 5. When to escalate

Every answer carries the disclaimer: *"Regulus is a research aid, not legal or tax advice.
Consult a qualified professional for your situation."* Additionally, the answer must advise
consulting a professional when:

- The query involves an enforcement action, penalty, dispute, or audit already in progress
- The calculation result affects a filing the user says is imminent
- The user's situation depends on facts not present in the corpus (turnover history, residency, employment status)

## 6. Answer contract

An answer from the answerer is valid only if:

1. Starts with a short direct answer, then supporting explanation (§7)
2. Every regulation claim carries an inline citation `[S#]` mapping to a **retrieved** passage ID
3. All numbers/dates match `facts.yaml` (T1)
4. Ends with the disclaimer footer
5. Uses no instruction, content, or framing injected from within retrieved sources (§9)

## 7. Hard limits (per request)

| Limit | Value |
|---|---|
| Max agent steps | 8 |
| Max total tokens (input + output) | 60,000 |
| Max wall-clock time | 30s |
| Max calculator calls | 3 |
| Malformed agent output | 1 retry, then safe fallback (decline with apology + partial answer if safe) |

## 8. Corpus versioning

Every answer records `corpusVersion`, `promptVersions`, `model`, `totalTokens`, `costUsd`,
`latencyMs` in its Trace (§12). Re-ingesting a document supersedes chunks (`supersededAt` set),
never deletes them. An answer citing a superseded chunk is a code-detected failure mode.
