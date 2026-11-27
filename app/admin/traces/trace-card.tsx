"use client";

import { useState } from "react";

export interface Span {
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

export interface TraceCardData {
  traceId: string;
  question: string;
  answer: string;
  spans: Span[];
  promptVersions: string[];
  totalTokens: number;
  costUsd: string;
  latencyMs: number;
  createdAt: string;
  citations: unknown;
}

const SPAN_COLORS: Record<string, string> = {
  embed_query: "bg-zinc-100 text-zinc-700",
  retrieval: "bg-blue-50 text-blue-700",
  answer: "bg-green-50 text-green-700",
  error: "bg-red-100 text-red-700",
};

/** Plain-text rendering of the whole trace — pasted into error-analysis notes. */
export function buildTraceText(t: TraceCardData): string {
  const hasError = t.spans.some((s) => s.step === "error");
  const abstained = t.answer.startsWith("Not found in the sources");
  const lines: string[] = [];
  lines.push(
    `TRACE ${t.traceId} (${new Date(t.createdAt).toLocaleString()})`,
    `QUESTION: ${t.question}`,
    `VERDICT: ${hasError ? "ERROR" : abstained ? "ABSTAINED" : "OK"}`,
    "",
    "SPANS:",
  );
  for (const s of t.spans) {
    const bits: string[] = [s.step, `${s.latencyMs}ms`];
    if (s.model) bits.push(s.model);
    if (s.tokens) bits.push(`${s.tokens.input}+${s.tokens.output} tok`);
    if (s.costUsd != null) bits.push(`$${Number(s.costUsd).toFixed(6)}`);
    if (s.topK != null) bits.push(`${s.topK} passages / ${s.contextTokens} ctx tok`);
    if (s.emptyAnswer) bits.push("EMPTY ANSWER");
    if (s.error) bits.push(`ERROR: ${s.error}`);
    lines.push(`- ${bits.join(" | ")}`);
    for (const p of s.passages ?? []) {
      lines.push(
        `    ${p.sid} (sim ${p.similarity}, ${p.tokenCount} tok) ${p.sectionPath} [${p.chunkId}]`,
      );
    }
  }
  lines.push("", "ANSWER:", t.answer, "");
  const cites = t.spans.find((s) => s.step === "retrieval")?.passages ?? [];
  if (cites.length > 0) {
    lines.push(
      "CITATIONS:",
      ...cites.map((p) => `- ${p.sid} → ${p.chunkId}`),
      "",
    );
  }
  lines.push(`prompts: ${t.promptVersions.join(" · ")}`);
  return lines.join("\n");
}

export function TraceCard({ trace }: { trace: TraceCardData }) {
  const [copied, setCopied] = useState(false);
  const hasError = trace.spans.some((s) => s.step === "error");
  const abstained = trace.answer.startsWith("Not found in the sources");

  async function copy(e: React.MouseEvent) {
    e.preventDefault(); // don't toggle the <details> card
    e.stopPropagation();
    const text = buildTraceText(trace);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context — fall back for http previews.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <details className="rounded-xl border border-zinc-200 bg-white open:shadow-sm">
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
          <span className="flex-1 truncate text-sm text-zinc-800">{trace.question}</span>
          <span className="text-[10px] text-zinc-400">
            {trace.totalTokens} tok · ${trace.costUsd} ·{" "}
            {(trace.latencyMs / 1000).toFixed(1)}s ·{" "}
            {new Date(trace.createdAt).toLocaleString()}
          </span>
          <button
            onClick={copy}
            title="Copy this trace as text"
            className="cursor-pointer rounded-lg border border-zinc-200 px-2 py-1 text-[10px] font-medium text-zinc-600 transition-colors hover:border-zinc-500 hover:bg-zinc-100"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </summary>
      <div className="border-t border-zinc-100 px-4 py-4">
        <p className="text-xs font-medium text-zinc-400">QUESTION</p>
        <p className="mt-1 text-sm text-zinc-800">{trace.question}</p>

        <p className="mt-4 text-xs font-medium text-zinc-400">SPANS</p>
        <div className="mt-1 flex flex-col gap-1">
          {trace.spans.map((s, i) => (
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
              {s.promptVersion && <span className="text-zinc-400">{s.promptVersion}</span>}
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

        {trace.spans.find((s) => s.step === "retrieval")?.passages && (
          <>
            <p className="mt-4 text-xs font-medium text-zinc-400">RETRIEVED PASSAGES</p>
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
                {(trace.spans.find((s) => s.step === "retrieval")?.passages ?? []).map(
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
          {trace.answer}
        </p>

        <p className="mt-3 text-[10px] text-zinc-400">
          {trace.promptVersions.join(" · ")} · trace {trace.traceId}
        </p>
      </div>
    </details>
  );
}
