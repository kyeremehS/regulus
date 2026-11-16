/**
 * Phase 0 exit test: one traced gateway call.
 * Run: npm run smoke:gateway
 * Requires a model key in .env: OPENROUTER_API_KEY (default provider — free
 * tier, no card) or OPENAI_API_KEY (set MODEL_PROVIDER=openai).
 * Exit 0 + printed trace record = Phase 0 done.
 */
import "dotenv/config";
import { callModel, resolveModelId, resolveProvider } from "../lib/gateway";

async function main() {
  const provider = resolveProvider();
  const keyVar = provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
  if (!process.env[keyVar]) {
    console.error(`FAIL: ${keyVar} not set (add it to .env) — provider=${provider}`);
    process.exit(1);
  }
  console.log(
    `provider=${provider} small=${resolveModelId("small")} large=${resolveModelId("large")}`,
  );

  const result = await callModel({
    tier: "small",
    promptVersion: "smoke@0.0.1",
    corpusVersion: "0.1.0",
    system: "You are a connectivity check. Reply with exactly: OK",
    prompt: "ping",
    // Free-tier models reason by default — a 16-token cap got fully consumed
    // by thinking and returned empty text (seen 2026-11-16). Give reasoning
    // models headroom (≥ ~256) or the visible answer may be cut off.
    maxOutputTokens: 512,
  });

  console.log("SMOKE RESULT:", JSON.stringify(result, null, 2));

  const ok =
    result.text.trim().length > 0 &&
    result.usage.totalTokens > 0 &&
    result.promptVersion === "smoke@0.0.1" &&
    result.corpusVersion === "0.1.0" &&
    result.latencyMs > 0;

  if (!ok) {
    console.error("FAIL: trace record incomplete");
    process.exit(1);
  }
  console.log("PASS: traced gateway call with prompt version + token count");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
