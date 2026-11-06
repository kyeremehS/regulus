/**
 * Phase 0 exit test: one traced gateway call.
 * Run: npm run smoke:gateway   (requires OPENAI_API_KEY in .env)
 * Exit 0 + printed trace record = Phase 0 done.
 */
import "dotenv/config";
import { callModel } from "../lib/gateway";

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("FAIL: OPENAI_API_KEY not set (add it to .env)");
    process.exit(1);
  }

  const result = await callModel({
    tier: "small",
    promptVersion: "smoke@0.0.1",
    corpusVersion: "0.1.0",
    system: "You are a connectivity check. Reply with exactly: OK",
    prompt: "ping",
    maxOutputTokens: 16,
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
