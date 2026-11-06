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

// --- Tiers (D1: OpenAI only for v1) ---------------------------------------

export const TIERS = {
  /** Small + fast: planner, retriever, verifier, judge (§8) */
  small: () => openai("gpt-5-nano"),
  /** Large: answerer only (§8) */
  large: () => openai("gpt-5"),
} as const;

export type TierName = keyof typeof TIERS;

// --- Pricing (USD per 1M tokens) ------------------------------------------
// Verified: 2026-11-06. Update when models change; costs are logged per call.
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5": { input: 1.25, output: 10 },
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
const TIMEOUT_MS = 30_000;
const BACKOFF_MS = [500, 2_000];

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
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

      const record = {
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
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    msg.includes("overloaded")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
