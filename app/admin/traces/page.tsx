/**
 * /admin/traces — simple trace review interface (§10.1): read whole traces,
 * one per chat turn — question, spans (embed → retrieval → answer/error),
 * answer, citations. The Phase 2 error-analysis workflow (read ≥60 traces)
 * happens here.
 *
 * Server component; auth via ?key= matching ADMIN_KEY (unset = open in dev).
 */
import { connection } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, traces } from "@/db/schema";

interface Span {
  step: string;
  latencyMs: number;
  model?: string;
  promptVersion?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  passages?: {
    sid: string;
    chunkId: string;
    sectionPath: string;
    similarity: number;
    tokenCount: number;
  }[];
  topK?: number;
  contextTokens?: number;
  answerChars?: number;
  emptyAnswer?: boolean;
  error?: string;
}

// Admin page: block on request data (auth + fresh DB reads) instead of
// streaming a prerendered shell — private tool, no need for instant loading.
export const instant = false;

const SPAN_COLORS: Record<string, string> = {
  embed_query: "bg-zinc-100 text-zinc-700",
  retrieval: "bg-blue-50 text-blue-700",
  answer: "bg-green-50 text-green-700",
  error: "bg-red-100 text-red-700",
};

export default async function AdminTracesPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string }>;
}) {
  const { key } = await searchParams;
  // Per-request rendering: auth + fresh trace reads must never prerender.
  await connection();
  const expected = process.env.ADMIN_KEY;
  const authed = !expected || key === expected;

  if (!authed) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold text-zinc-900">Admin traces</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Locked. Append <code className="rounded bg-zinc-100 px-1">?key=…</code> with your
          ADMIN_KEY value.
        </p>
      </main>
    );
  }

  const rawRows = await db
    .select({
      traceId: traces.id,
      promptVersions: traces.promptVersions,
      steps: traces.steps,
      totalTokens: traces.totalTokens,
      costUsd: traces.costUsd,
      latencyMs: traces.latencyMs,
      createdAt: traces.createdAt,
      answer: messages.content,
      citations: messages.citations,
      conversationId: messages.conversationId,
    })
    .from(traces)
    .innerJoin(messages, eq(traces.messageId, messages.id))
    .orderBy(desc(traces.createdAt))
    .limit(50);

  const rows = rawRows.map((r) => ({
    ...r,
    steps: (r.steps ?? []) as unknown as Span[],
    promptVersions: (r.promptVersions ?? []) as unknown as string[],
  }));

  const questions = new Map<string, string>();
  const userMessages = await db
    .select({ conversationId: messages.conversationId, content: messages.content })
    .from(messages)
    .where(eq(messages.role, "user"));
  for (const m of userMessages) questions.set(m.conversationId, m.content);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
            Traces <span className="text-sm font-normal text-zinc-400">/admin</span>
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            {rows.length} recent turns · one trace per chat turn (§10.1)
            {!expected && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
                ADMIN_KEY unset — open to anyone; set it before deploying
              </span>
            )}
          </p>
        </div>
      </div>

      {rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
          No traces yet — ask something in the chat first.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {rows.map((r) => {
          const spans = r.steps ?? [];
          const hasError = spans.some((s) => s.step === "error");
          const abstained = r.answer.startsWith("Not found in the sources");
          const question = questions.get(r.conversationId) ?? "(question not stored)";
          return (
            <details
              key={r.traceId}
              className="rounded-xl border border-zinc-200 bg-white open:shadow-sm"
            >
              <summary className="cursor-pointer list-none px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {hasError && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                      ERROR
                    </span>
                  )}
                  {abstained && !hasError && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      ABSTAINED
                    </span>
                  )}
                  <span className="flex-1 truncate text-sm text-zinc-800">{question}</span>
                  <span className="text-[10px] text-zinc-400">
                    {r.totalTokens} tok · ${r.costUsd} ·{" "}
                    {(r.latencyMs / 1000).toFixed(1)}s ·{" "}
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
              </summary>
              <div className="border-t border-zinc-100 px-4 py-4">
                <p className="text-xs font-medium text-zinc-400">QUESTION</p>
                <p className="mt-1 text-sm text-zinc-800">{question}</p>

                <p className="mt-4 text-xs font-medium text-zinc-400">SPANS</p>
                <div className="mt-1 flex flex-col gap-1">
                  {spans.map((s, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs"
                    >
                      <span
                        className={`rounded px-1.5 py-0.5 font-medium ${
                          SPAN_COLORS[s.step] ?? "bg-zinc-100 text-zinc-700"
                        }`}
                      >
                        {s.step}
                      </span>
                      {s.model && <span className="text-zinc-600">{s.model}</span>}
                      {s.promptVersion && (
                        <span className="text-zinc-400">{s.promptVersion}</span>
                      )}
                      {s.tokens && (
                        <span className="text-zinc-600">
                          {s.tokens.input}+{s.tokens.output} tok
                        </span>
                      )}
                      {s.costUsd != null && (
                        <span className="text-zinc-600">${Number(s.costUsd).toFixed(6)}</span>
                      )}
                      <span className="text-zinc-600">{s.latencyMs}ms</span>
                      {s.topK != null && (
                        <span className="text-zinc-600">
                          {s.topK} passages / {s.contextTokens} ctx tok
                        </span>
                      )}
                      {s.emptyAnswer && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
                          empty answer
                        </span>
                      )}
                      {s.error && <span className="text-red-600">{s.error}</span>}
                    </div>
                  ))}
                </div>

                {spans.find((s) => s.step === "retrieval")?.passages && (
                  <>
                    <p className="mt-4 text-xs font-medium text-zinc-400">
                      RETRIEVED PASSAGES
                    </p>
                    <table className="mt-1 w-full text-left text-xs">
                      <thead className="text-zinc-400">
                        <tr>
                          <th className="py-1 pr-2 font-medium">id</th>
                          <th className="py-1 pr-2 font-medium">section</th>
                          <th className="py-1 pr-2 font-medium">sim</th>
                          <th className="py-1 font-medium">tok</th>
                        </tr>
                      </thead>
                      <tbody className="text-zinc-700">
                        {(spans.find((s) => s.step === "retrieval")?.passages ?? []).map(
                          (p) => (
                            <tr key={p.sid} className="border-t border-zinc-100">
                              <td className="py-1 pr-2 font-mono">{p.sid}</td>
                              <td className="py-1 pr-2">
                                {p.sectionPath.length > 70
                                  ? `${p.sectionPath.slice(0, 70)}…`
                                  : p.sectionPath}
                              </td>
                              <td className="py-1 pr-2 font-mono">{p.similarity}</td>
                              <td className="py-1">{p.tokenCount}</td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </>
                )}

                <p className="mt-4 text-xs font-medium text-zinc-400">ANSWER</p>
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-700">
                  {r.answer}
                </p>

                <p className="mt-3 text-[10px] text-zinc-400">
                  {r.promptVersions.join(" · ")} · trace {r.traceId}
                </p>
              </div>
            </details>
          );
        })}
      </div>
    </main>
  );
}
