import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { extractDealFields } from "../src/extract.ts";

// Uses tool-calling (see extract.ts's comment for why: native Output.object()/generateObject()
// structured outputs get a real 400 from Vertex's org policy when routed through 1Claw's Shroud +
// LLM Token Billing — confirmed live, see docs/DAY-ONE-FINDINGS.md §17). These tests prove the
// tool-call request/parse plumbing works, with a fake model — no live credentials needed or used.

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };

function extractionFixture(overrides: Record<string, unknown> = {}) {
  return {
    claim: "octocat/Hello-World publishes a release",
    evidenceUrls: ["https://github.com/octocat/Hello-World"],
    deadlineIso: "2026-10-06T00:00:00Z",
    timezone: "UTC",
    ambiguousTerms: [],
    kind: "release_published",
    githubRepo: "octocat/Hello-World",
    urlToCheck: null,
    urlContentCheck: null,
    chainId: null,
    recipientAddress: null,
    tokenAddress: null,
    minAmountBaseUnits: null,
    ...overrides,
  };
}

function mockToolCallModel(input: Record<string, unknown>) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "record_extraction", input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

test("extractDealFields: parses a valid tool-call response into the Extraction shape", async () => {
  const model = mockToolCallModel(extractionFixture());
  const result = await extractDealFields("octocat/Hello-World must publish a release within 7 days.", { model });
  assert.equal(result.kind, "release_published");
  assert.equal(result.githubRepo, "octocat/Hello-World");
  assert.deepEqual(result.evidenceUrls, ["https://github.com/octocat/Hello-World"]);
});

test("extractDealFields: includes today's real date in the prompt so relative deadlines resolve correctly", async () => {
  const model = mockToolCallModel(extractionFixture());
  await extractDealFields("must publish within 7 days.", { model });
  const sentPrompt = JSON.stringify(model.doGenerateCalls[0]);
  const todayIso = new Date().toISOString().slice(0, 10); // date part only, tolerant of test run time
  assert.ok(sentPrompt.includes(todayIso), "prompt should include today's date so the model doesn't guess from its training cutoff");
});

test("extractDealFields: a schema-invalid tool call throws rather than silently passing through", async () => {
  const model = mockToolCallModel(extractionFixture({ kind: "not_a_real_kind" }));
  await assert.rejects(() => extractDealFields("bad deal", { model }));
});

test("extractDealFields: throws if the model never calls the forced tool", async () => {
  // toolChoice: { type: "tool", ... } makes the AI SDK itself enforce this before extract.ts's own
  // "model did not call record_extraction" fallback would ever run — that fallback exists only in
  // case a future provider doesn't honor toolChoice strictly.
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "I refuse to extract this." }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
  await assert.rejects(() => extractDealFields("bad deal", { model }), /record_extraction/);
});

test("extractDealFields: appends the prior IMD error for a retry attempt", async () => {
  const model = mockToolCallModel(extractionFixture());
  await extractDealFields("deal text", { model, priorError: "quote_rejected: window too large" });
  const sentPrompt = JSON.stringify(model.doGenerateCalls[0]);
  assert.ok(sentPrompt.includes("window too large"));
});
