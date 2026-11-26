/**
 * POST /api/chat — the naive single-call RAG path (§7 baseline, kept forever).
 * Body: { message: string }
 * SSE events (one JSON object per `data:` line):
 *   {"type":"sources","sources":[…]} — retrieved passages with similarity
 *   {"type":"text","delta":"…"}      — answer body deltas
 *   {"type":"done","trace":{…},"conversationId":"…"} — citations + trace
 *   {"type":"error","message":"…"}
 * Every turn is persisted (conversation, messages, trace with spans — §10.1).
 */
import { streamModel } from "@/lib/gateway";
import { ANSWERER_NAIVE, promptId } from "@/lib/prompts";
import { retrieve, assembleContext, manifestCorpusVersion } from "@/lib/retrieval";
import { persistTurn, type TraceSpan } from "@/lib/trace";

export const maxDuration = 120;

interface ChatBody {
  message?: string;
}

function sse(event: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  let message: string;
  try {
    const body = (await request.json()) as ChatBody;
    message = (body.message ?? "").trim();
  } catch {
    message = "";
  }
  if (!message) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > 4_000) {
    return Response.json({ error: "message too long (max 4,000 chars)" }, { status: 400 });
  }

  const turnStartedAt = Date.now();

  // 1. Retrieve (§7: vector top-k → context with stable [S1]…[Sn] IDs).
  let retrieved;
  try {
    retrieved = await retrieve(message);
  } catch (err) {
    console.error(JSON.stringify({ event: "chat.retrieval_failed", error: String(err) }));
    return Response.json({ error: "retrieval failed" }, { status: 500 });
  }
  const corpusVersion = await manifestCorpusVersion();

  const spans: TraceSpan[] = [];
  spans.push({
    step: "embed_query",
    startedAt: new Date(turnStartedAt).toISOString(),
    latencyMs: retrieved.latencyMs,
    tokens: { input: retrieved.queryTokens, output: 0 },
    costUsd: retrieved.queryCostUsd,
  });
  spans.push({
    step: "retrieval",
    startedAt: new Date(turnStartedAt + retrieved.latencyMs).toISOString(),
    latencyMs: 0, // DB time is included in the embed+query round trip above
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

  // 2. One call: answer from the assembled context only (abstention + injection
  //    defenses live in the system prompt, answerer-naive@1.0.0).
  const prompt = `Question: ${message}

Source passages:

${assembleContext(retrieved.passages)}`;

  const handle = streamModel({
    tier: "large",
    promptVersion: promptId(ANSWERER_NAIVE),
    corpusVersion,
    system: ANSWERER_NAIVE.system,
    prompt,
  });

  const sources = retrieved.passages.map((p) => ({
    sid: p.sid,
    chunkId: p.chunkId,
    documentId: p.documentId,
    documentTitle: p.documentTitle,
    sectionPath: p.sectionPath,
    pageNumber: p.pageNumber,
    sourceUrl: p.sourceUrl,
    similarity: Math.round(p.similarity * 1000) / 1000,
  }));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (event: object) => {
        if (!closed) controller.enqueue(sse(event));
      };
      let answer = "";
      let streamError: string | undefined;
      let doneTrace: Record<string, unknown> | undefined;
      try {
        safeEnqueue({ type: "sources", sources });
        for await (const delta of handle.textStream) {
          answer += delta;
          safeEnqueue({ type: "text", delta });
        }
        const trace = await handle.finished;
        spans.push({
          step: "answer",
          startedAt: new Date(turnStartedAt + retrieved.latencyMs).toISOString(),
          latencyMs: trace.latencyMs,
          model: trace.model,
          promptVersion: trace.promptVersion,
          tokens: { input: trace.usage.inputTokens, output: trace.usage.outputTokens },
          costUsd: trace.costUsd,
          answerChars: answer.length,
          emptyAnswer: !answer.trim(),
        });
        doneTrace = {
          promptVersion: trace.promptVersion,
          corpusVersion: trace.corpusVersion,
          model: trace.model,
          provider: trace.provider,
          totalTokens: trace.usage.totalTokens,
          costUsd: trace.costUsd,
          latencyMs: trace.latencyMs,
        };
      } catch (err) {
        streamError = String(err);
        console.error(JSON.stringify({ event: "chat.stream_failed", error: streamError }));
        spans.push({
          step: "error",
          startedAt: new Date().toISOString(),
          latencyMs: Date.now() - turnStartedAt,
          error: streamError,
        });
      }
      const conversationId = await persistTurn({
        question: message,
        answer,
        citations: sources,
        promptVersions: [promptId(ANSWERER_NAIVE), "query-embed@1.0.0"],
        spans,
        totalTokens: spans.reduce((n, s) => n + (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0), 0),
        costUsd: spans.reduce((n, s) => n + (s.costUsd ?? 0), 0),
        latencyMs: Date.now() - turnStartedAt,
        error: streamError,
      });
      if (streamError) {
        safeEnqueue({ type: "error", message: "the answer stream failed — please retry" });
      } else if (doneTrace) {
        safeEnqueue({ type: "done", trace: doneTrace, conversationId });
      }
      closed = true;
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
