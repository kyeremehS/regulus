/**
 * POST /api/chat — the naive single-call RAG path (§7 baseline, kept forever).
 * Body: { message: string }
 * SSE events (one JSON object per `data:` line):
 *   {"type":"text","delta":"…"}   — answer body deltas
 *   {"type":"done","sources":[…],"trace":{…}} — citations + trace for this turn
 *   {"type":"error","message":"…"}
 */
import { streamModel } from "@/lib/gateway";
import { ANSWERER_NAIVE, promptId } from "@/lib/prompts";
import { retrieve, assembleContext } from "@/lib/retrieval";

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

  // 1. Retrieve (§7: vector top-k → context with stable [S1]…[Sn] IDs).
  let retrieved;
  try {
    retrieved = await retrieve(message);
  } catch (err) {
    console.error(JSON.stringify({ event: "chat.retrieval_failed", error: String(err) }));
    return Response.json({ error: "retrieval failed" }, { status: 500 });
  }
  const corpusVersion = await import("@/lib/retrieval").then((m) => m.manifestCorpusVersion());

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
      try {
        safeEnqueue({ type: "sources", sources });
        for await (const delta of handle.textStream) {
          safeEnqueue({ type: "text", delta });
        }
        const trace = await handle.finished;
        safeEnqueue({
          type: "done",
          trace: {
            promptVersion: trace.promptVersion,
            corpusVersion: trace.corpusVersion,
            model: trace.model,
            provider: trace.provider,
            totalTokens: trace.usage.totalTokens,
            costUsd: trace.costUsd,
            latencyMs: trace.latencyMs,
          },
        });
      } catch (err) {
        console.error(JSON.stringify({ event: "chat.stream_failed", error: String(err) }));
        safeEnqueue({ type: "error", message: "the answer stream failed — please retry" });
      } finally {
        closed = true;
        controller.close();
      }
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
