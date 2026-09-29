import { test } from "node:test";
import assert from "node:assert/strict";
import { releasePublishedTemplate, pageOrFileLiveTemplate, onchainEventTemplate } from "../src/templates/index.ts";
import type { Extraction } from "../src/types.ts";
import { PLACEHOLDER_VERIFYING_CONTRACT } from "../src/types.ts";

function baseExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    claim: "",
    evidenceUrls: [],
    deadlineIso: null,
    timezone: null,
    ambiguousTerms: [],
    kind: "unsupported",
    githubRepo: null,
    urlToCheck: null,
    urlContentCheck: null,
    chainId: null,
    recipientAddress: null,
    tokenAddress: null,
    minAmountBaseUnits: null,
    ...overrides,
  };
}

const ctx = { evidenceChainId: 1, startIso: "2026-10-01T00:00:00.000Z", validForSeconds: 604800 };

test("releasePublishedTemplate: reports missing fields", () => {
  assert.deepEqual(releasePublishedTemplate.missingFields(baseExtraction()), ["githubRepo", "deadlineIso"]);
  assert.deepEqual(releasePublishedTemplate.missingFields(baseExtraction({ githubRepo: "acme/widget" })), ["deadlineIso"]);
});

test("releasePublishedTemplate: builds a body matching the confirmed live schema shape", () => {
  const e = baseExtraction({ kind: "release_published", githubRepo: "acme/widget/", deadlineIso: "2026-10-16T00:00:00.000Z" });
  const input = releasePublishedTemplate.build(e, ctx);

  assert.equal(input.v, 1);
  assert.equal(input.answerType, "bool");
  assert.equal(input.evidence, "panel");
  assert.equal(input.panelSize, 5);
  assert.equal(input.quorum, 4);
  assert.equal(input.consumer.verifyingContract, PLACEHOLDER_VERIFYING_CONTRACT);
  assert.match(input.question, /acme\/widget/);
  assert.ok(!input.question.includes("acme/widget/")); // trailing slash trimmed
  assert.equal(input.guards.sources?.[0], "https://github.com/acme/widget/");
  assert.equal(input.guards.minSources, 1);
  assert.match(input.definitions.missing, /not false/);
  // start (Oct 1) to deadline+1day (Oct 17) is 16 days
  assert.equal(input.window.hours, 16 * 24);
});

test("pageOrFileLiveTemplate: reports missing fields", () => {
  assert.deepEqual(pageOrFileLiveTemplate.missingFields(baseExtraction()), ["urlToCheck", "urlContentCheck", "deadlineIso"]);
});

test("pageOrFileLiveTemplate: builds a body with the host as the guard source", () => {
  const e = baseExtraction({
    kind: "page_or_file_live",
    urlToCheck: "https://acme.example.com/status",
    urlContentCheck: "shows 'v2 live'",
    deadlineIso: "2026-10-16T00:00:00.000Z",
  });
  const input = pageOrFileLiveTemplate.build(e, ctx);
  assert.equal(input.guards.sources?.[0], "https://acme.example.com/");
  assert.match(input.question, /acme\.example\.com\/status/);
});

test("onchainEventTemplate: reports missing fields", () => {
  assert.deepEqual(onchainEventTemplate.missingFields(baseExtraction()), [
    "chainId",
    "recipientAddress",
    "tokenAddress",
    "minAmountBaseUnits",
    "deadlineIso",
  ]);
});

test("onchainEventTemplate: builds with evidence 'chain' and full quorum", () => {
  const e = baseExtraction({
    kind: "onchain_event",
    chainId: 11155111,
    recipientAddress: "0x1111111111111111111111111111111111111",
    tokenAddress: "0x2222222222222222222222222222222222222",
    minAmountBaseUnits: "1000000",
    deadlineIso: "2026-10-16T00:00:00.000Z",
  });
  const input = onchainEventTemplate.build(e, ctx);
  assert.equal(input.evidence, "chain");
  assert.equal(input.quorum, 5);
  assert.equal(input.panelSize, 5);
  // toleranceBps deliberately not emitted — confirmed live to cause a bare 400 (see types.ts)
  assert.equal(input.guards.minSources, 1);
  assert.match(input.guards.sources?.[0] ?? "", /sepolia\.etherscan\.io\/token/);
  assert.equal(input.consumer.chainId, 11155111); // uses the extracted chain, not ctx.evidenceChainId
});
