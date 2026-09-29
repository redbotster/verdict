import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { oneClawTransactionRelay } from "../src/oneClawRelay.ts";
import { loadMilestoneEscrowArtifact } from "../src/artifact.ts";
import type { OneClawClient } from "../../oneclaw-client/src/client.ts";
import type { SignedAttestation } from "../src/types.ts";

const ESCROW_ADDRESS = "0x000000000000000000000000000000000000ee" as const;

function fakeAttestation(): SignedAttestation {
  return {
    message: {
      requestId: 1n,
      chainId: 1n,
      questionHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
      answerType: "bool",
      answer: true,
      figure: "",
      fromBlock: 1n,
      toBlock: 2n,
      panelJobId: "panel-1",
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
