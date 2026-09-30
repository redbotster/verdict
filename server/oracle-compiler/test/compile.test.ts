import { test } from "node:test";
import assert from "node:assert/strict";
import { compileDeal, pinQuestion, approvalSummaryFromOrder } from "../src/compile.ts";
import { ImdApiError } from "../../imd-client/src/types.ts";
import type { Order } from "../../imd-client/src/types.ts";
import type { Extraction } from "../src/types.ts";

function baseExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    claim: "acme/widget publishes a release",
    evidenceUrls: ["https://github.com/acme/widget"],
    deadlineIso: "2026-10-16T00:00:00.000Z",
    timezone: "UTC",
    ambiguousTerms: [],
    kind: "release_published",
    githubRepo: "acme/widget",
    urlToCheck: null,
    urlContentCheck: null,
    chainId: null,
    recipientAddress: null,
    tokenAddress: null,
    minAmountBaseUnits: null,
    ...overrides,
  };
}

function fakeOrder(inputJson: string, overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    requestKey: "req-1",
    status: "quoted",
    quote: {
      v: 1,
      id: "order-1",
      action: "oracle.request",
      policyVersion: "oracle-1",
      inputHash: "a".repeat(64),
      issuedAt: 1_000_000,
      expiresAt: 1_000_600,
      payment: { network: "eip155:1", asset: "0x" + "0".repeat(40), amount: "500000000000000000", payTo: "0x" + "1".repeat(40), decimals: 18, scheme: "exact" },
      terms: { purchase: "action-admission", resultGuaranteed: false },
      quoteHash: "b".repeat(64),
    },
    inputJson,
    createdAt: new Date().toISOString(),
    paidAt: null,
    ...overrides,
  };
}

test("compileDeal: happy path returns the questionHash from the dry-run quote", async () => {
  const order = fakeOrder(JSON.stringify({ questionHash: "0xabc", pinned: { fromBlock: 1, toBlock: 2 } }));
  const result = await compileDeal("acme/widget must publish a release by 2026-10-16.", {
    extract: async () => baseExtraction(),
    quote: async (input) => {
      assert.equal(input.evidence, "panel");
      return { order };
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "release_published");
    assert.equal(result.questionHash, "0xabc");
    assert.equal(result.attempts, 1);
  }
});

test("compileDeal: re-quotes with an absolute window once the first quote resolves a pinned block range (§27)", async () => {
  // A relative window: {hours} gets re-pinned to fresh blocks on every quote (confirmed live,
  // docs/DAY-ONE-FINDINGS.md §27), so compileDeal() must swap in the *absolute* range the first
  // quote resolved before computing the questionHash it actually returns — otherwise a later
  // re-quote of the same deal (at real resolution time) would never match.
  const quoteCalls: unknown[] = [];
  const result = await compileDeal("acme/widget must publish a release by 2026-10-16.", {
    extract: async () => baseExtraction(),
    quote: async (input) => {
      quoteCalls.push(input.window);
      if (quoteCalls.length === 1) {
        // First (probe) call: still the template's original relative window.
        assert.deepEqual(input.window, { hours: (input.window as { hours: number }).hours });
        return { order: fakeOrder(JSON.stringify({ questionHash: "0xprobe", pinned: { fromBlock: 100, toBlock: 200 } })) };
      }
      // Second (final) call: the probe's pinned range substituted in as an absolute window.
      assert.deepEqual(input.window, { fromBlock: 100, toBlock: 200 });
      return { order: fakeOrder(JSON.stringify({ questionHash: "0xfinal" })) };
    },
  });

  assert.equal(quoteCalls.length, 2);
  assert.equal(result.ok, true);
  if (result.ok) {
    // The returned questionHash is the *final* (absolute-window) quote's, not the probe's.
    assert.equal(result.questionHash, "0xfinal");
    assert.deepEqual(result.input.window, { fromBlock: 100, toBlock: 200 });
  }
});

test("compileDeal: skips the second quote and keeps the relative window if the response has no pinned range", async () => {
  let calls = 0;
  const result = await compileDeal("acme/widget must publish a release by 2026-10-16.", {
    extract: async () => baseExtraction(),
    quote: async () => {
      calls++;
      return { order: fakeOrder(JSON.stringify({ questionHash: "0xonly" })) }; // no `pinned` field at all
    },
  });

  assert.equal(calls, 1); // no wasted second quote when there's no pinned range to substitute
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.questionHash, "0xonly");
    assert.ok("hours" in result.input.window); // unchanged — still the original relative window
  }
});

test("compileDeal: refuses when extraction finds no matching template", async () => {
  const result = await compileDeal("Please be a good partner and do your best.", {
    extract: async () => baseExtraction({ kind: "unsupported", githubRepo: null }),
    quote: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason.code, "no_template_match");
});

test("compileDeal: refuses on missing required fields for the matched template", async () => {
  const result = await compileDeal("acme/widget should ship a release.", {
    extract: async () => baseExtraction({ deadlineIso: null }),
    quote: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason.code, "no_template_match");
    assert.match(result.reason.detail, /deadlineIso/);
  }
});

test("compileDeal: refuses on subjective language found by extraction", async () => {
  const result = await compileDeal("acme/widget must ship a good release by 2026-10-16.", {
    extract: async () => baseExtraction({ ambiguousTerms: ["good"] }),
    quote: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason.code, "lint_failed");
});

test("compileDeal: refuses on a private evidence source URL", async () => {
  const result = await compileDeal("acme/widget must ship by 2026-10-16.", {
    extract: async () => baseExtraction({ evidenceUrls: ["https://localhost/internal"] }),
    quote: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason.code, "lint_failed");
});

test("compileDeal: retries once for free on a 422, then succeeds", async () => {
  let calls = 0;
  const order = fakeOrder(JSON.stringify({ questionHash: "0xdef" }));
  const result = await compileDeal("acme/widget must ship by 2026-10-16.", {
    extract: async () => baseExtraction(),
    maxAttempts: 2,
    quote: async () => {
      calls++;
      if (calls === 1) throw new ImdApiError(422, { error: "invalid_input", detail: "bad window" });
      return { order };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.attempts, 2);
});

test("compileDeal: gives up after maxAttempts of 422s", async () => {
  const result = await compileDeal("acme/widget must ship by 2026-10-16.", {
    extract: async () => baseExtraction(),
    maxAttempts: 2,
    quote: async () => {
      throw new ImdApiError(422, { error: "invalid_input", detail: "still bad" });
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason.code, "quote_rejected");
    assert.equal(result.attempts, 2);
  }
});

test("compileDeal: propagates non-422 errors instead of swallowing them", async () => {
  await assert.rejects(
    () =>
      compileDeal("acme/widget must ship by 2026-10-16.", {
        extract: async () => baseExtraction(),
        quote: async () => {
          throw new Error("network down");
        },
      }),
    /network down/,
  );
});

test("pinQuestion + approvalSummaryFromOrder: substitutes the real consumer and reads the binding questionHash", async () => {
  const order = fakeOrder(JSON.stringify({ questionHash: "0xreal", pinned: { fromBlock: 10, toBlock: 20 } }));
  const compileResult = await compileDeal("acme/widget must ship by 2026-10-16.", {
    extract: async () => baseExtraction(),
    quote: async () => ({ order: fakeOrder(JSON.stringify({ questionHash: "0xpreview" })) }),
  });
  assert.equal(compileResult.ok, true);
  if (!compileResult.ok) return;

  let seenConsumer: { chainId: number; verifyingContract: string } | undefined;
  const finalOrder = await pinQuestion(
    compileResult.input,
    { chainId: 11155111, verifyingContract: "0xESCROW" },
    {
      quote: async (input) => {
        seenConsumer = input.consumer;
        return { order };
      },
    },
  );

  // withConsumer lowercases the address — IMD's schema requires lowercase hex (see templates/common.ts)
  assert.deepEqual(seenConsumer, { chainId: 11155111, verifyingContract: "0xescrow" });
  const summary = approvalSummaryFromOrder(compileResult.input, finalOrder);
  assert.equal(summary.questionHash, "0xreal");
  assert.equal(summary.pinned.fromBlock, 10);
  assert.equal(summary.panelSize, 5);
  assert.equal(summary.quorum, 4);
});
