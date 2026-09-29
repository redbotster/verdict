import { test } from "node:test";
import assert from "node:assert/strict";
import { OneClawClient } from "../src/client.ts";

// Regression test for a real bug found live 2026-09-29 (docs/DAY-ONE-FINDINGS.md §20):
// EIP712TypedData messages routinely carry BigInt for uint256 fields (viem's own convention, used
// throughout @verdict/imd-client's paymentSigning.ts) — OneClawClient.sign() did a plain
// JSON.stringify(request), which throws "Do not know how to serialize a BigInt" the moment a real
// typed-data payload reaches it. Mocks global fetch (this package has no fetchImpl injection point;
// its own client.ts is otherwise only proven by scripts/live-smoke.ts against the real API).
test("sign(): serializes BigInt fields in the typed_data message instead of throwing", async (t) => {
  let capturedBody: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.toString().endsWith("/auth/agent-token")) {
      return new Response(JSON.stringify({ access_token: "fake", token_type: "Bearer", expires_in: 900 }), { status: 200 });
    }
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ signature: "0xsig" }), { status: 200 });
  });

  const client = new OneClawClient({ agentId: "agent-1", agentApiKey: "ocv_fake" });
  const result = await client.sign("agent-1", {
    intent_type: "typed_data",
    chain: "ethereum",
    typed_data: {
      domain: { name: "Permit2", chainId: 1, verifyingContract: "0xabc" },
      types: { Test: [{ name: "amount", type: "uint256" }] },
      primaryType: "Test",
      message: { amount: 500000000000000000n },
    },
  });

  assert.equal(result.signature, "0xsig");
  assert.ok(capturedBody, "expected a captured request body");
  const parsed = JSON.parse(capturedBody!);
  assert.equal(parsed.typed_data.message.amount, "500000000000000000");
});

test("submitTransaction(): posts to /transactions and returns the broadcast result", async (t) => {
  let capturedUrl: string | undefined;
  let capturedBody: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.toString().endsWith("/auth/agent-token")) {
      return new Response(JSON.stringify({ access_token: "fake", token_type: "Bearer", expires_in: 900 }), { status: 200 });
    }
    capturedUrl = url.toString();
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ id: "tx-1", tx_hash: "0xhash", chain: "ethereum", status: "broadcast" }), { status: 200 });
  });

  const client = new OneClawClient({ agentId: "agent-1", agentApiKey: "ocv_fake" });
  const result = await client.submitTransaction("agent-1", { chain: "ethereum", to: "0xabc", value: "0", data: "0xdeadbeef" });

  assert.equal(capturedUrl, "https://api.1claw.co/v1/agents/agent-1/transactions");
  assert.deepEqual(JSON.parse(capturedBody!), { chain: "ethereum", to: "0xabc", value: "0", data: "0xdeadbeef" });
  assert.deepEqual(result, { id: "tx-1", tx_hash: "0xhash", chain: "ethereum", status: "broadcast" });
});

test("signTransaction(): posts to /transactions/sign and returns the signed (unbroadcast) result", async (t) => {
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.toString().endsWith("/auth/agent-token")) {
      return new Response(JSON.stringify({ access_token: "fake", token_type: "Bearer", expires_in: 900 }), { status: 200 });
    }
    capturedUrl = url.toString();
    return new Response(
      JSON.stringify({ signed_tx: "0xsigned", tx_hash: "0xhash", from: "0xfrom", to: "0xabc", chain: "ethereum", chain_id: 1, nonce: 0, value_wei: "0", status: "sign_only" }),
      { status: 200 },
    );
  });

  const client = new OneClawClient({ agentId: "agent-1", agentApiKey: "ocv_fake" });
  const result = await client.signTransaction("agent-1", { chain: "ethereum", to: "0xabc", value: "0" });

  assert.equal(capturedUrl, "https://api.1claw.co/v1/agents/agent-1/transactions/sign");
  assert.equal(result.status, "sign_only");
  assert.equal(result.signed_tx, "0xsigned");
});
