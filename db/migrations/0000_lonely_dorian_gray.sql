CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"section_path" text NOT NULL,
	"text" text NOT NULL,
	"page_number" integer,
	"token_count" integer NOT NULL,
	"embedding" vector(1536),
	"superseded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"source_url" text NOT NULL,
	"publisher" text NOT NULL,
	"published_at" timestamp,
	"version" text DEFAULT '1' NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"eval_set_id" text NOT NULL,
	"question" text NOT NULL,
	"query_type" text NOT NULL,
	"reference" text NOT NULL,
	"required_chunks" jsonb,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" text PRIMARY KEY NOT NULL,
	"eval_run_id" text NOT NULL,
	"eval_case_id" text NOT NULL,
	"answer" text NOT NULL,
	"scores" jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"eval_set_id" text NOT NULL,
	"config_json" jsonb NOT NULL,
	"git_sha" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"summary_metrics" jsonb
);
--> statement-breakpoint
CREATE TABLE "eval_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"prompt_versions" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_eval_set_id_eval_sets_id_fk" FOREIGN KEY ("eval_set_id") REFERENCES "public"."eval_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_eval_case_id_eval_cases_id_fk" FOREIGN KEY ("eval_case_id") REFERENCES "public"."eval_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_eval_set_id_eval_sets_id_fk" FOREIGN KEY ("eval_set_id") REFERENCES "public"."eval_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_document_id_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chunks_section_path_idx" ON "chunks" USING btree ("section_path");--> statement-breakpoint
CREATE INDEX "documents_content_hash_idx" ON "documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "eval_cases_eval_set_id_idx" ON "eval_cases" USING btree ("eval_set_id");--> statement-breakpoint
CREATE INDEX "eval_results_eval_run_id_idx" ON "eval_results" USING btree ("eval_run_id");--> statement-breakpoint
CREATE INDEX "eval_results_eval_case_id_idx" ON "eval_results" USING btree ("eval_case_id");--> statement-breakpoint
CREATE INDEX "eval_runs_eval_set_id_idx" ON "eval_runs" USING btree ("eval_set_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "traces_message_id_idx" ON "traces" USING btree ("message_id");