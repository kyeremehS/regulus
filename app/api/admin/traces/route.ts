/**
 * GET /api/admin/traces — recent turns for the eval harness + debugging (§13).
 * Query: ?limit=50 (max 200)
 * Auth: simple protection (§13) — send the ADMIN_KEY env value as the
 * `x-admin-key` header or `?key=`. Unset ADMIN_KEY = open (local dev only —
 * set it before deploying).
 */
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, traces } from "@/db/schema";

export const maxDuration = 60;

function authorized(request: Request): boolean {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return true; // dev mode; .env.example warns to set it in prod
  const header = request.headers.get("x-admin-key");
  if (header === expected) return true;
  const url = new URL(request.url);
  return url.searchParams.get("key") === expected;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);

  const rows = await db
    .select({
      traceId: traces.id,
      messageId: traces.messageId,
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
    .limit(limit);

  return Response.json({ traces: rows });
}
