/**
 * Regulus data model — DESIGN.md §12 (Drizzle edition).
 * One source of truth for tables; migrations via `npm run db:generate` + `db:migrate`.
 */
import {
  customType,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";

// --- pgvector --------------------------------------------------------------
// Drizzle has no built-in vector column; this maps number[] <-> 'vector(1536)'.
// Requires the pgvector extension: created by the first migration.

export const EMBEDDING_DIMENSIONS = 1536;

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${EMBEDDING_DIMENSIONS})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(Number);
  },
});

// --- Corpus (§5) -------------------------------------------------------------

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    sourceUrl: text("source_url").notNull(),
    publisher: text("publisher").notNull(),
    publishedAt: timestamp("published_at", { mode: "date" }),
    version: text("version").notNull().default("1"),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("documents_content_hash_idx").on(t.contentHash)],
);

export const chunks = pgTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    sectionPath: text("section_path").notNull(),
    text: text("text").notNull(),
    pageNumber: integer("page_number"),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding"),
    // Set when a newer document version supersedes this chunk; never deleted (§5.6).
    supersededAt: timestamp("superseded_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("chunks_document_id_idx").on(t.documentId),
    index("chunks_section_path_idx").on(t.sectionPath),
  ],
);

// --- Conversation & answers ---------------------------------------------------

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_id_idx").on(t.conversationId)],
);

export const traces = pgTable(
  "traces",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    promptVersions: jsonb("prompt_versions").notNull(),
    steps: jsonb("steps").notNull(),
    totalTokens: integer("total_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("traces_message_id_idx").on(t.messageId)],
);

// --- Eval harness (§10) --------------------------------------------------------

export const evalSets = pgTable("eval_sets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
});

export const evalCases = pgTable(
  "eval_cases",
  {
    id: text("id").primaryKey(),
    evalSetId: text("eval_set_id")
      .notNull()
      .references(() => evalSets.id),
    question: text("question").notNull(),
    queryType: text("query_type").notNull(),
    reference: text("reference").notNull(),
    requiredChunks: jsonb("required_chunks"),
    tags: jsonb("tags"),
  },
  (t) => [index("eval_cases_eval_set_id_idx").on(t.evalSetId)],
);

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: text("id").primaryKey(),
    evalSetId: text("eval_set_id")
      .notNull()
      .references(() => evalSets.id),
    configJson: jsonb("config_json").notNull(),
    gitSha: text("git_sha").notNull(),
    startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
    summaryMetrics: jsonb("summary_metrics"),
  },
  (t) => [index("eval_runs_eval_set_id_idx").on(t.evalSetId)],
);

export const evalResults = pgTable(
  "eval_results",
  {
    id: text("id").primaryKey(),
    evalRunId: text("eval_run_id")
      .notNull()
      .references(() => evalRuns.id),
    evalCaseId: text("eval_case_id")
      .notNull()
      .references(() => evalCases.id),
    answer: text("answer").notNull(),
    scores: jsonb("scores").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
  },
  (t) => [
    index("eval_results_eval_run_id_idx").on(t.evalRunId),
    index("eval_results_eval_case_id_idx").on(t.evalCaseId),
  ],
);
