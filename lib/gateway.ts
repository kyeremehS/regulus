/**
 * Model gateway — DESIGN.md §6 "Model gateway".
 *
 * The ONLY place the app talks to a model API. Responsibilities:
 *  - model selection (named tiers, never hardcoded model IDs elsewhere)
 *  - retries with backoff + timeouts
 *  - token & cost accounting
 *  - prompt version tagging (every call logs prompt version, model, corpus version — §9)
 *  - emitting a trace record per call (§10.1: trace model before traffic)
 *
 * In Phase 1 this records to structured logs; Phase 1b persists Trace rows to Postgres.
 */

import { generateText, type LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// --- Tiers (D1 revised 2026-11-16) -----------------------------------------
// Two named tiers, provider-agnostic: which backend serves them is resolved
// at call time, never hardcoded elsewhere (DESIGN §6).
//
// Provider resolution order:
//   1. MODEL_PROVIDER=openrouter|openai  (explicit override)
//   2. default: "openrouter" when OPENROUTER_API_KEY is set, else "openai"
//
// While OpenAI credits are exhausted we run on OpenRouter's free tier
// (`:free` model ids — $0/token, no credit card, 20 req/min + 50 req/day on a
// fresh account). Free ids are env-swappable (MODEL_SMALL / MODEL_LARGE)
// because the free roster rotates; tiers stay stable so the app never
// hardcodes a model id. When the OpenAI key returns: MODEL_PROVIDER=openai.
//
// NOTE (observed 2026-11-16): the free tier defaults are REASONING models —
// they emit thinking tokens before the visible answer, counted as output
// tokens. Give calls headroom (maxOutputTokens ≥ ~256, or leave unset) or
// the budget is consumed by reasoning and `text` comes back empty.

export const DEFAULT_MODELS = {
  openrouter: {
    /** Nemotron 3.5 Lightning — 3B active/30B MoE, high-throughput agentic (§8) */
    small: "nvidia/nemotron-3.5-lightning:free",
    /** Nemotron 3 Ultra — 55B active/550B MoE, open frontier reasoning + orchestration (§8) */
    large: "nvidia/nemotron-3-ultra-550b-a55b:free",
    /** OpenAI text-embedding-3-small via OpenRouter — 1536 dims, matches the schema's vector(1536).
     *  Decided 2026-11-26 over local fastembed: one key for chat+embed, works on Vercel at query
     *  time (no ONNX payload on serverless), and the whole corpus embeds for ~$0.007. */
    embed: "openai/text-embedding-3-small",
  },
  openai: {
    small: "gpt-5-nano",
    large: "gpt-5",
    embed: "text-embedding-3-small",
  },
} as const;

export type ProviderName = keyof typeof DEFAULT_MODELS;

export function resolveProvider(): ProviderName {
  const explicit = process.env.MODEL_PROVIDER;
  if (explicit === "openrouter" || explicit === "openai") return explicit;
  if (explicit) {
    throw new Error(
      `MODEL_PROVIDER must be "openrouter" or "openai", got "${explicit}"`,
    );
  }
  return process.env.OPENROUTER_API_KEY ? "openrouter" : "openai";
}

export function resolveModelId(tier: "small" | "large"): string {
  const override = process.env[tier === "small" ? "MODEL_SMALL" : "MODEL_LARGE"];
  if (override) return override;
  return DEFAULT_MODELS[resolveProvider()][tier];
}

export function resolveEmbedModelId(): string {
  const override = process.env.MODEL_EMBED;
  if (override) return override;
  return DEFAULT_MODELS[resolveProvider()].embed;
}

let openrouterClient: ReturnType<typeof createOpenRouter> | null = null;

function resolveTier(tier: "small" | "large"): LanguageModel {
  const provider = resolveProvider();
  const modelId = resolveModelId(tier);
  if (provider === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY not set — create a free key at openrouter.ai/settings/keys and add it to .env " +
          "(or set MODEL_PROVIDER=openai + OPENAI_API_KEY to use OpenAI instead)",
      );
    }
    openrouterClient ??= createOpenRouter({
      apiKey,
      appName: "regulus",
    });
    return openrouterClient.chat(modelId);
  }
  return openai(modelId);
}

export const TIERS = {
  /** Small + fast: planner, retriever, verifier, judge (§8) */
  small: () => resolveTier("small"),
  /** Large: answerer only (§8) */
  large: () => resolveTier("large"),
} as const;

export type TierName = keyof typeof TIERS;

// --- Pricing (USD per 1M tokens) ------------------------------------------
// Verified: 2026-11-06. Update when models change; costs are logged per call.
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5": { input: 1.25, output: 10 },
  // Embeddings are input-only. Verified live 2026-11-26 ($0.02/M → 14 tok = $2.8e-7).
  "openai/text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
};

// --- Types ----------------------------------------------------------------

export interface GatewayCallOptions {
  tier: TierName;
  /** Prompt file ID + semantic version, e.g. "answerer@1.0.0" (§9) */
  promptVersion: string;
  /** Corpus version this call operates on (§5.6 / §12) */
  corpusVersion: string;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  /** Injected in tests to bypass the network */
  model?: LanguageModel;
}

export interface GatewayCallResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd: number;
  latencyMs: number;
  provider: string;
  model: string;
  promptVersion: string;
  corpusVersion: string;
  attempts: number;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// --- Config ---------------------------------------------------------------

const MAX_ATTEMPTS = 3;
// Free-tier endpoints queue and reasoning models think — 30s was too tight
// for the OpenRouter path (raised 2026-11-16).
const TIMEOUT_MS = 60_000;
const BACKOFF_MS = [500, 2_000];

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (model.endsWith(":free")) return 0; // OpenRouter free tier: $0/token
  const p = PRICING[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// --- The gateway ----------------------------------------------------------

export async function callModel(
  opts: GatewayCallOptions,
): Promise<GatewayCallResult> {
  const model = opts.model ?? TIERS[opts.tier]();
  const modelName = typeof model === "string" ? model : (model.modelId ?? opts.tier);
  const startedAt = Date.now();

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(
        generateText({
          model,
          system: opts.system,
          prompt: opts.prompt,
          maxOutputTokens: opts.maxOutputTokens,
        }),
        TIMEOUT_MS,
        `model call timed out after ${TIMEOUT_MS}ms`,
      );

      const { usage, text } = result;
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const latencyMs = Date.now() - startedAt;

      // Reasoning models can burn the whole output budget on thinking and
      // return nothing visible — surface it instead of passing silently.
      if (!text.trim()) {
        console.warn(
          JSON.stringify({
            event: "gateway.call.empty_text",
            model: modelName,
            outputTokens,
            note: "zero visible text (reasoning likely consumed maxOutputTokens)",
            ts: new Date().toISOString(),
          }),
        );
      }

      const record = {
        provider: resolveProvider(),
        model: modelName,
        promptVersion: opts.promptVersion,
        corpusVersion: opts.corpusVersion,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: estimateCost(modelName, inputTokens, outputTokens),
        latencyMs,
        attempts: attempt,
        ts: new Date().toISOString(),
      };
      // Structured log (§16). Phase 1b: also write a Trace row.
      console.log(JSON.stringify({ event: "gateway.call", ...record }));

      return { text, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, ...record };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }

  throw new GatewayError(
    `model call failed after ${MAX_ATTEMPTS} attempt(s): ${String(lastError)}`,
    MAX_ATTEMPTS,
    lastError,
  );
}

// --- Embeddings (stage 5 — decided 2026-11-26) ------------------------------

export interface GatewayEmbedOptions {
  /** Up to EMBED_MAX_BATCH texts per call — chunking into calls is the caller's job */
  texts: string[];
  corpusVersion: string;
  promptVersion?: string;
  /** Injected in tests to bypass the network */
  endpoint?: string;
}

export interface GatewayEmbedResult {
  vectors: number[][];
  usage: { inputTokens: number; totalTokens: number };
  costUsd: number;
  latencyMs: number;
  provider: string;
  model: string;
  corpusVersion: string;
  attempts: number;
}

// OpenAI caps an embeddings request at 2048 inputs; keep batches small so a
// retry never replays a huge payload (the script batches at 64).
const EMBED_MAX_BATCH = 256;

// Both providers expose the same OpenAI-compatible POST /embeddings shape:
// { model, input: string[] } → { data: [{ embedding: number[] }], usage }.
const EMBED_ENDPOINTS: Record<ProviderName, string> = {
  openrouter: "https://openrouter.ai/api/v1/embeddings",
  openai: "https://api.openai.com/v1/embeddings",
};

function embedAuthKey(provider: ProviderName): string {
  const keyVar = provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
  const key = process.env[keyVar];
  if (!key) {
    throw new Error(`${keyVar} not set — provider=${provider} (add it to .env)`);
  }
  return key;
}

/**
 * Embed a batch of texts through the provider's embeddings API. Same
 * responsibilities as callModel: retries with backoff, timeout, token/cost
 * accounting, structured trace log (§6, §10.1).
 */
export async function embedTexts(
  opts: GatewayEmbedOptions,
): Promise<GatewayEmbedResult> {
  if (opts.texts.length === 0) throw new Error("embedTexts: no texts given");
  if (opts.texts.length > EMBED_MAX_BATCH) {
    throw new Error(
      `embedTexts: ${opts.texts.length} texts > EMBED_MAX_BATCH ${EMBED_MAX_BATCH} — split the batch`,
    );
  }
  const provider = resolveProvider();
  const model = resolveEmbedModelId();
  const endpoint = opts.endpoint ?? EMBED_ENDPOINTS[provider];
  const startedAt = Date.now();

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await withTimeout(
        fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${embedAuthKey(provider)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input: opts.texts }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
        TIMEOUT_MS,
        `embedding call timed out after ${TIMEOUT_MS}ms`,
      );

      if (!res.ok) {
        const body = await res.text();
        // 429/5xx are retryable per isRetryable; throw so the loop sees them.
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        data: { embedding: number[] }[];
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };
      const vectors = json.data.map((d) => d.embedding);
      if (vectors.length !== opts.texts.length) {
        throw new Error(
          `embedding response count mismatch: sent ${opts.texts.length}, got ${vectors.length}`,
        );
      }
      const inputTokens = json.usage?.prompt_tokens ?? 0;
      const latencyMs = Date.now() - startedAt;
      const record = {
        provider,
        model,
        promptVersion: opts.promptVersion ?? "embed@1.0.0",
        corpusVersion: opts.corpusVersion,
        inputTokens,
        totalTokens: json.usage?.total_tokens ?? inputTokens,
        costUsd: estimateCost(model, inputTokens, 0),
        latencyMs,
        attempts: attempt,
        ts: new Date().toISOString(),
      };
      console.log(JSON.stringify({ event: "gateway.embed", ...record }));
      return {
        vectors,
        usage: { inputTokens, totalTokens: record.totalTokens },
        costUsd: record.costUsd,
        latencyMs,
        provider,
        model,
        corpusVersion: opts.corpusVersion,
        attempts: attempt,
      };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }

  throw new GatewayError(
    `embedding call failed after ${MAX_ATTEMPTS} attempt(s): ${String(lastError)}`,
    MAX_ATTEMPTS,
    lastError,
  );
}

export { EMBED_MAX_BATCH };

// --- Helpers --------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function isRetryable(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  // Transient network / rate-limit / 5xx conditions only.
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("529") ||
    msg.includes("http 5") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    msg.includes("overloaded")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
