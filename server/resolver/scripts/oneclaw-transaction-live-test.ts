// Real, live, zero-cost proof that oneClawTransactionRelay produces a genuinely valid, correctly
// signed transaction — using 1Claw's sign-only mode (POST /v1/agents/:id/transactions/sign), which
// signs inside the HSM but never broadcasts, so no gas is ever spent. Encodes a real
// submitAttestation() call against a fabricated (never-deployed) escrow address — the call doesn't
// need to succeed on-chain to prove the signing mechanism itself is correct: independently decodes
// the signed raw transaction with viem and confirms it recovers to the agent's real signing-key
// address, carries the right `to`, and its calldata round-trips through the real MilestoneEscrow ABI.
//
// Not run by CI — needs a live agent with Intents API enabled and a signing key provisioned.
//
//   ONE_CLAW_EXTRACTION_AGENT_ID=$(grep -oP '(?<=^ONE_CLAW_EXTRACTION_AGENT_ID=).*' ~/.secrets/verdict.env) \
//   ONE_CLAW_EXTRACTION_AGENT_API_KEY=$(grep -oP '(?<=^ONE_CLAW_EXTRACTION_AGENT_API_KEY=).*' ~/.secrets/verdict.env) \
//     npx tsx scripts/oneclaw-transaction-live-test.ts
import { encodeFunctionData, parseTransaction, recoverTransactionAddress } from "viem";
import { OneClawClient } from "../../oneclaw-client/src/client.ts";
import { loadMilestoneEscrowArtifact } from "../src/artifact.ts";
import { toAbiMessage } from "../src/relay.ts";
import type { AttestationMessage } from "../src/types.ts";

const agentId = process.env.ONE_CLAW_EXTRACTION_AGENT_ID!;
const agentApiKey = process.env.ONE_CLAW_EXTRACTION_AGENT_API_KEY!;
const EXPECTED_SIGNER = "0x2590fc6823ede90dbebac41bb5759c14555e6aab"; // this agent's real ethereum signing key
const FAKE_ESCROW = "0x1234567890123456789012345678901234567890" as const; // never deployed — proves signing, not delivery

const message: AttestationMessage = {
  requestId: "0x0000000000000000000000000000000000000000000000000000000000000001",
  chainId: 1n,
  questionHash: "0x1c116c28eccc74f0f0c3b4aae874b48c45df1070b3e732096cd40fb8700f4164",
  answerType: 0,
  answer: true,
  figure: 0n,
  fromBlock: 1n,
  toBlock: 2n,
  blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  panelJobId: "0x0000000000000000000000000000000000000000000000000000000000000002",
  issuedAt: 1000n,
  expiresAt: 2000n,
};

const { abi } = loadMilestoneEscrowArtifact();
const data = encodeFunctionData({
  abi,
  functionName: "submitAttestation",
  args: [toAbiMessage(message), ("0x" + "11".repeat(65)) as `0x${string}`],
});

const client = new OneClawClient({ agentId, agentApiKey });

console.log("Signing (not broadcasting) a real submitAttestation() call via 1Claw's Intents API...");
const signed = await client.signTransaction(agentId, {
  chain: "ethereum",
  to: FAKE_ESCROW,
  value: "0",
  data,
});
console.log("Response:", { tx_hash: signed.tx_hash, from: signed.from, to: signed.to, nonce: signed.nonce, status: signed.status });

console.log("\nIndependently parsing and verifying the signed raw transaction with viem...");
const parsed = parseTransaction(signed.signed_tx);
console.log("Parsed tx:", { to: parsed.to, chainId: parsed.chainId, nonce: parsed.nonce });

const recovered = await recoverTransactionAddress({
  serializedTransaction: signed.signed_tx as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"],
});
console.log("Recovered signer:", recovered);
console.log("Expected signer: ", EXPECTED_SIGNER);
console.log("SIGNER MATCH:", recovered.toLowerCase() === EXPECTED_SIGNER.toLowerCase());
console.log("TO MATCH:", parsed.to?.toLowerCase() === FAKE_ESCROW.toLowerCase());
console.log("CALLDATA MATCH:", parsed.data === data);
