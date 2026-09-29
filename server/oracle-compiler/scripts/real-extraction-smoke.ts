// Real, paid smoke test: extraction against a real model (claude-sonnet-4-6, via 1Claw's Shroud +
// LLM Token Billing — no Anthropic key anywhere in this project), then a real free IMD dry-run
// quote. Proves the full compileDeal() pipeline end to end with real LLM extraction, not an injected
// fixture — the first time that's been true for this project. See docs/DAY-ONE-FINDINGS.md §17.
//
// Not run by CI — needs a live ONE_CLAW_EXTRACTION_AGENT_ID/API_KEY. Run it yourself:
//
//   ONE_CLAW_EXTRACTION_AGENT_ID=$(grep -oP '(?<=^ONE_CLAW_EXTRACTION_AGENT_ID=).*' ~/.secrets/verdict.env) \
//   ONE_CLAW_EXTRACTION_AGENT_API_KEY=$(grep -oP '(?<=^ONE_CLAW_EXTRACTION_AGENT_API_KEY=).*' ~/.secrets/verdict.env) \
//     npx tsx scripts/real-extraction-smoke.ts
import { compileDeal } from "../src/compile.ts";
import { shroudAnthropicModel } from "../src/shroud.ts";

const model = shroudAnthropicModel({
  agentId: process.env.ONE_CLAW_EXTRACTION_AGENT_ID!,
  agentApiKey: process.env.ONE_CLAW_EXTRACTION_AGENT_API_KEY!,
  model: "claude-sonnet-4-6",
});

const result = await compileDeal(
  "octocat/Hello-World must publish a non-prerelease GitHub release within the next 7 days.",
  { model },
);
console.log(JSON.stringify(result, null, 2));
