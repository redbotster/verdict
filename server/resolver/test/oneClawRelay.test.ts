import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, type PublicClient } from "viem";
import { oneClawTransactionRelay, oneClawSignAndBroadcastRelay, OneClawBroadcastFailedError } from "../src/oneClawRelay.ts";
import { loadMilestoneEscrowArtifact } from "../src/artifact.ts";
import type { OneClawClient } from "../../oneclaw-client/src/client.ts";
import type { SignedAttestation } from "../src/types.ts";

const ESCROW_ADDRESS = "0x000000000000000000000000000000000000ee" as const;

function fakeAttestation(): SignedAttestation {
  return {
    message: {
      requestId: "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
      chainId: 1n,
      questionHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
      answerType: 0,
      answer: true,
      figure: 0n,
      fromBlock: 1n,
      toBlock: 2n,
      blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`,
      panelJobId: "0x3333333333333333333333333333333333333333333333333333333333333333" as `0x${string}`,
      issuedAt: 1000n,
      expiresAt: 2000n,
    },
    // A real (65-byte r||s||v) hex signature shape — not the value itself, but a decodable one, since
    // this test round-trips the encoded calldata back through decodeFunctionData().
    signature: ("0x" + "11".repeat(65)) as `0x${string}`,
  };
}

test("oneClawTransactionRelay.submitAttestation: encodes the real calldata and submits it through 1Claw", async () => {
  let captured: { agentId: string; input: unknown } | undefined;
  const fakeClient = {
    submitTransaction: async (agentId: string, input: unknown) => {
      captured = { agentId, input };
      return { id: "tx-1", tx_hash: "0xrealtxhash", chain: "ethereum", status: "broadcast" };
    },
  } as unknown as OneClawClient;

  const relay = oneClawTransactionRelay({ client: fakeClient, agentId: "agent-1", chain: "ethereum" });
  const txHash = await relay.submitAttestation(ESCROW_ADDRESS, fakeAttestation());

  assert.equal(txHash, "0xrealtxhash");
  assert.equal(captured?.agentId, "agent-1");
  const input = captured?.input as { chain: string; to: string; value: string; data: `0x${string}` };
  assert.equal(input.chain, "ethereum");
  assert.equal(input.to, ESCROW_ADDRESS);
  assert.equal(input.value, "0");

  // Confirm the calldata is real, correctly-encoded submitAttestation(message, signature) — not
  // just some opaque bytes.
  const { abi } = loadMilestoneEscrowArtifact();
  const decoded = decodeFunctionData({ abi, data: input.data });
  assert.equal(decoded.functionName, "submitAttestation");
  assert.equal((decoded.args as unknown[])[1], "0x" + "11".repeat(65));
});

test("oneClawTransactionRelay.release: encodes a real release() call with no args", async () => {
  let captured: { input: unknown } | undefined;
  const fakeClient = {
    submitTransaction: async (_agentId: string, input: unknown) => {
      captured = { input };
      return { id: "tx-2", tx_hash: "0xreleasehash", chain: "base", status: "broadcast" };
    },
  } as unknown as OneClawClient;

  const relay = oneClawTransactionRelay({ client: fakeClient, agentId: "agent-1", chain: "base" });
  const txHash = await relay.release(ESCROW_ADDRESS);

  assert.equal(txHash, "0xreleasehash");
  const input = captured?.input as { chain: string; data: `0x${string}` };
  assert.equal(input.chain, "base");

  const { abi } = loadMilestoneEscrowArtifact();
  const decoded = decodeFunctionData({ abi, data: input.data });
  assert.equal(decoded.functionName, "release");
  assert.deepEqual(decoded.args ?? [], []);
});

test("oneClawTransactionRelay: throws OneClawBroadcastFailedError when 1Claw returns a tx_hash but status isn't 'broadcast'", async () => {
  // Regression test for a real bug found live 2026-09-29 (docs/DAY-ONE-FINDINGS.md §22): 1Claw's
  // /transactions endpoint can return 200 with a real-looking tx_hash even when it never actually
  // broadcast (real observed status: "signed", with a "Broadcast failed: ... please upgrade to paid
  // plan" error_message on GET .../transactions) — a caller trusting tx_hash alone would wait forever
  // for a receipt that never comes.
  const fakeClient = {
    submitTransaction: async () => ({ id: "tx-3", tx_hash: "0xneverbroadcast", chain: "base", status: "signed" }),
  } as unknown as OneClawClient;

  const relay = oneClawTransactionRelay({ client: fakeClient, agentId: "agent-1", chain: "base" });
  await assert.rejects(() => relay.release(ESCROW_ADDRESS), OneClawBroadcastFailedError);
});

test("oneClawSignAndBroadcastRelay: signs via 1Claw (BYORPC) and broadcasts the raw tx itself over eth_sendRawTransaction", async () => {
  // The actual working path (docs/DAY-ONE-FINDINGS.md §22's addendum): 1Claw's own broadcaster is
  // currently broken, so this relay signs only (never costs 1Claw gas or hits their broadcaster) and
  // sends the resulting raw signed tx over a plain RPC via the caller's own PublicClient instead.
  let signInput: { agentId: string; input: unknown } | undefined;
  const fakeClient = {
    signTransaction: async (agentId: string, input: unknown) => {
      signInput = { agentId, input };
      return {
        signed_tx: "0xdeadbeef",
        tx_hash: "0xprecomputedhash",
        from: "0x2590fc6823ede90dbebac41bb5759c14555e6aab",
        to: ESCROW_ADDRESS,
        chain: "base",
        chain_id: 8453,
        nonce: 0,
        value_wei: "0",
        status: "signed",
      };
    },
  } as unknown as OneClawClient;

  let broadcastRequest: { method: string; params: unknown[] } | undefined;
  const fakePublicClient = {
    request: async (req: { method: string; params: unknown[] }) => {
      broadcastRequest = req;
      return "0xrealbroadcasthash";
    },
  } as unknown as PublicClient;

  const relay = oneClawSignAndBroadcastRelay({ client: fakeClient, agentId: "agent-1", chain: "base", publicClient: fakePublicClient });
  const txHash = await relay.submitAttestation(ESCROW_ADDRESS, fakeAttestation());

  // The returned hash comes from the actual broadcast, not 1Claw's own (unverified) tx_hash guess.
  assert.equal(txHash, "0xrealbroadcasthash");
  assert.equal(signInput?.agentId, "agent-1");
  const signed = signInput?.input as { chain: string; to: string; value: string; data: `0x${string}` };
  assert.equal(signed.chain, "base");
  assert.equal(signed.to, ESCROW_ADDRESS);

  const { abi } = loadMilestoneEscrowArtifact();
  const decoded = decodeFunctionData({ abi, data: signed.data });
  assert.equal(decoded.functionName, "submitAttestation");

  assert.equal(broadcastRequest?.method, "eth_sendRawTransaction");
  assert.deepEqual(broadcastRequest?.params, ["0xdeadbeef"]);
});
