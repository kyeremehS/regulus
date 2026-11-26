/**
 * Trace persistence — §10.1 "trace data model before taking any traffic".
 * Every chat turn is stored as: one conversation, two messages (user question,
 * assistant answer with citations), and one trace row whose `steps` jsonb holds
 * the ordered spans (embed → retrieval → answer) with per-step tokens/cost/
 * latency and any errors. The eval harness reads exactly this format.
 *
 * Persistence failures must never break an answer: persistTurn logs and
 * returns null on error.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { conversations, messages, traces } from "../db/schema";

export interface TraceSpan {
  step: "embed_query" | "retrieval" | "answer" | "error";
  startedAt: string;
  latencyMs: number;
  model?: string;
  promptVersion?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  /** retrieval only */
  passages?: {
    sid: string;
    chunkId: string;
    documentId: string;
    sectionPath: string;
    pageNumber: number | null;
    similarity: number;
    tokenCount: number;
  }[];
  topK?: number;
  contextTokens?: number;
  /** answer only */
  answerChars?: number;
  emptyAnswer?: boolean;
  /** error only */
  error?: string;
  note?: string;
}

export interface TurnToPersist {
  question: string;
  answer: string;
  citations: {
    sid: string;
    chunkId: string;
    documentId: string;
    documentTitle: string;
    sectionPath: string;
    pageNumber: number | null;
    sourceUrl: string;
    similarity: number;
  }[] | null;
  promptVersions: string[];
  spans: TraceSpan[];
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  error?: string;
}

export async function persistTurn(turn: TurnToPersist): Promise<string | null> {
  const conversationId = randomUUID();
  const answerMessageId = randomUUID();
  try {
    await db.insert(conversations).values({ id: conversationId });
    await db.insert(messages).values({
      id: randomUUID(),
      conversationId,
      role: "user",
      content: turn.question,
    });
    await db.insert(messages).values({
      id: answerMessageId,
      conversationId,
      role: "assistant",
      content: turn.answer,
      citations: turn.citations,
    });
    await db.insert(traces).values({
      id: randomUUID(),
      messageId: answerMessageId,
      promptVersions: turn.promptVersions,
      steps: turn.spans,
      totalTokens: turn.totalTokens,
      costUsd: turn.costUsd.toFixed(6),
      latencyMs: turn.latencyMs,
    });
    return conversationId;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "trace.persist_failed",
        conversationId,
        error: String(err),
        ts: new Date().toISOString(),
      }),
    );
    return null;
  }
}
