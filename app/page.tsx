"use client";

import { useEffect, useRef, useState } from "react";

interface Source {
  sid: string;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sectionPath: string;
  pageNumber: number | null;
  sourceUrl: string;
  similarity: number;
}

interface PassageDetail extends Source {
  text: string;
  documentPublisher: string;
}

interface Trace {
  promptVersion: string;
  corpusVersion: string;
  model: string;
  provider: string;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  trace?: Trace;
  error?: string;
}

const EXAMPLES = [
  "What is the VAT flat rate scheme rate?",
  "What are the PAYE income tax bands?",
  "Who must register for VAT?",
];

const DISCLAIMER =
  "Regulus answers from public legal sources and is not professional advice. Verify against the official sources or consult a licensed professional before acting.";

function CitationText({ text, onCite }: { text: string; onCite: (sid: string) => void }) {
  const parts = text.split(/(\[S\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\[(S\d+)\]$/);
        return m ? (
          <button
            key={i}
            onClick={() => onCite(m[1])}
            className="mx-0.5 inline-flex h-5 min-w-5 cursor-pointer items-center justify-center rounded-full border border-zinc-300 bg-zinc-100 px-1.5 align-baseline text-xs font-medium text-zinc-700 transition-colors hover:border-zinc-500 hover:bg-zinc-200"
            title="Show cited passage"
          >
            {m[1]}
          </button>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [panelSource, setPanelSource] = useState<PassageDetail | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function openCitation(chunkId: string) {
    setPanelLoading(true);
    setPanelSource(null);
    try {
      const res = await fetch(`/api/sources/${encodeURIComponent(chunkId)}`);
      if (res.ok) setPanelSource(await res.json());
    } finally {
      setPanelLoading(false);
    }
  }

  function closePanel() {
    setPanelSource(null);
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || streaming) return;
    setInput("");
    setStreaming(true);
    setPanelSource(null);
    setMessages((m) => [
      ...m,
      { role: "user", text: question },
      { role: "assistant", text: "" },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const ev of events) {
          const line = ev.trim();
          if (!line.startsWith("data: ")) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (parsed.type === "text") {
            const delta = parsed.delta as string;
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, text: last.text + delta };
              return copy;
            });
          } else if (parsed.type === "sources") {
            const sources = parsed.sources as Source[];
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, sources };
              return copy;
            });
          } else if (parsed.type === "done") {
            const trace = parsed.trace as Trace;
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, trace };
              return copy;
            });
          } else if (parsed.type === "error") {
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, error: parsed.message as string };
              return copy;
            });
          }
        }
      }
    } catch (err) {
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = {
          ...last,
          error: `Could not get an answer (${String(err)}). Please retry.`,
        };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans">
      <header className="border-b border-zinc-200 bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-baseline justify-between">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">Regulus</h1>
          <p className="text-xs text-zinc-500">
            Ghana tax &amp; business regulation · cited answers
          </p>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
          {messages.length === 0 && (
            <div className="mt-10 flex flex-col items-center gap-2 text-center">
              <p className="text-sm text-zinc-500">
                Ask a question about Ghanaian tax or business regulation.
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => send(ex)}
                    className="cursor-pointer rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:border-zinc-500 hover:bg-zinc-100"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) =>
            msg.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-900 px-4 py-2.5 text-sm text-white sm:max-w-[70%]">
                  {msg.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-2">
                <div className="max-w-[90%] self-start rounded-2xl rounded-bl-sm border border-zinc-200 bg-white px-4 py-3 text-sm leading-relaxed text-zinc-800 sm:max-w-[80%]">
                  {msg.text ? (
                    <span className="whitespace-pre-wrap">
                      <CitationText text={msg.text} onCite={(sid) => {
                        const src = msg.sources?.find((s) => s.sid === sid);
                        if (src) openCitation(src.chunkId);
                      }} />
                    </span>
                  ) : (
                    <span className="text-zinc-400">Thinking…</span>
                  )}
                  {msg.error && (
                    <p className="mt-2 text-xs text-red-600">{msg.error}</p>
                  )}
                  <p className="mt-3 border-t border-zinc-100 pt-2 text-[11px] leading-snug text-zinc-400">
                    {DISCLAIMER}
                  </p>
                </div>

                {msg.sources && msg.sources.length > 0 && (
                  <div className="flex max-w-[90%] flex-wrap gap-1.5 sm:max-w-[80%]">
                    {msg.sources.map((s) => (
                      <button
                        key={s.sid}
                        onClick={() => openCitation(s.chunkId)}
                        title={`${s.documentTitle} — ${s.sectionPath}`}
                        className="cursor-pointer rounded-lg border border-zinc-200 bg-white px-2 py-1 text-left text-[11px] text-zinc-600 transition-colors hover:border-zinc-500 hover:bg-zinc-100"
                      >
                        <span className="font-medium text-zinc-800">{s.sid}</span>
                        {" · "}
                        {s.sectionPath.length > 44
                          ? `${s.sectionPath.slice(0, 44)}…`
                          : s.sectionPath}
                      </button>
                    ))}
                  </div>
                )}

                {msg.trace && (
                  <p className="text-[10px] text-zinc-400">
                    {msg.trace.model} · {msg.trace.totalTokens} tok · ${msg.trace.costUsd.toFixed(6)} ·{" "}
                    {(msg.trace.latencyMs / 1000).toFixed(1)}s · {msg.trace.promptVersion}
                  </p>
                )}
              </div>
            ),
          )}
        </div>
      </div>

      <div className="border-t border-zinc-200 bg-white px-4 py-3 sm:px-6">
        <form
          className="mx-auto flex max-w-3xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. What is the VAT registration threshold?"
            className="flex-1 rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-500"
            disabled={streaming}
            maxLength={4000}
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            className="cursor-pointer rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {streaming ? "…" : "Ask"}
          </button>
        </form>
        <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-zinc-400">
          {DISCLAIMER}
        </p>
      </div>

      {panelLoading && (
        <div className="fixed inset-0 z-20 bg-zinc-900/20 lg:bg-transparent" />
      )}
      {(panelSource || panelLoading) && (
        <aside className="fixed inset-x-0 bottom-0 top-20 z-30 overflow-y-auto rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-xl sm:inset-x-4 lg:static lg:inset-auto lg:z-auto lg:w-96 lg:shrink-0 lg:rounded-none lg:border-l lg:p-5 lg:shadow-none">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              {panelLoading && (
                <p className="text-sm text-zinc-400">Loading cited passage…</p>
              )}
              {panelSource && (
                <>
                  <p className="text-sm font-semibold text-zinc-900">
                    {panelSource.documentTitle}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">{panelSource.sectionPath}</p>
                  {panelSource.pageNumber != null && (
                    <p className="mt-0.5 text-xs text-zinc-500">
                      Page {panelSource.pageNumber}
                    </p>
                  )}
                </>
              )}
            </div>
            <button
              onClick={closePanel}
              className="cursor-pointer rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
            >
              Close
            </button>
          </div>
          {panelSource && (
            <>
              <p className="whitespace-pre-wrap rounded-xl bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-700">
                {panelSource.text}
              </p>
              <a
                href={panelSource.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-xs font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900"
              >
                Open the official source PDF
              </a>
              <p className="mt-2 text-[10px] text-zinc-400">
                chunk {panelSource.chunkId}
              </p>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
