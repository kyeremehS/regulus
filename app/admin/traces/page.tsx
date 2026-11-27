/**
 * /admin/traces — simple trace review interface (§10.1): read whole traces,
 * one per chat turn — question, spans (embed → retrieval → answer/error),
 * answer, citations. The Phase 2 error-analysis workflow (read ≥60 traces)
 * happens here.
 *
 * Server component; auth via ?key= matching ADMIN_KEY (unset = open in dev).
 * Each card is a client component with a copy-to-clipboard button.
 */
import { connection } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, traces } from "@/db/schema";
import { TraceCard, type Span, type TraceCardData } from "./trace-card";

// Admin page: block on request data (auth + fresh DB reads) instead of
// streaming a prerendered shell — private tool, no need for instant loading.
export const instant = false;

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
          const card: TraceCardData = {
            traceId: r.traceId,
            question: questions.get(r.conversationId) ?? "(question not stored)",
            answer: r.answer,
            spans: r.steps,
            promptVersions: r.promptVersions,
            totalTokens: r.totalTokens,
            costUsd: r.costUsd,
            latencyMs: r.latencyMs,
            createdAt: new Date(r.createdAt).toISOString(),
            citations: r.citations,
          };
          return <TraceCard key={r.traceId} trace={card} />;
        })}
      </div>
    </main>
  );
}
