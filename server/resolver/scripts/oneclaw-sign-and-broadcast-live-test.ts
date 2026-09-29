// Real, live proof that oneClawSignAndBroadcastRelay actually DELIVERS a transaction on-chain — the
// missing half that oneclaw-transaction-live-test.ts (sign-only, zero-cost) deliberately didn't
// prove, and that base-mainnet-oneclaw-relay-demo.ts's real attempt showed 1Claw's OWN broadcaster
// can't do (docs/DAY-ONE-FINDINGS.md §22's addendum). This script signs via the same 1Claw endpoint
// (POST .../transactions/sign — no raw key in this process) but broadcasts the resulting raw signed
// tx itself via a plain RPC (viem's sendRawTransaction), exactly like oneClawSignAndBroadcastRelay
// does internally, then waits for a real receipt.
//
// Deliberately trivial and cheap: a 0-value self-transfer (to = the signing key's own address, no
// calldata), not a real escrow call — this isolates the sign+broadcast mechanism from any contract
// logic. Uses the same 1Claw signing key funded earlier this session for exactly this purpose
// (0.00005 ETH on Base, nonce still 0 — confirming the earlier failed submitAttestation attempt via
// 1Claw's own broadcaster never actually spent anything). Real gas, but at Base's ~0.006 gwei this
// costs a small fraction of a cent.
//
// Confirmed live 2026-09-29: tx 0x0d4ea0717ceb79deabc82f89fa5348fadfd608da8e0b74d0c1e21e17a74791e4,
// block 51962137, status success, nonce advanced 0 -> 1, real gas spent (balance dropped from
// 50000000000000 to 18386278457278 wei — the ~3.16e13 wei cost is higher than a naive
// 21000 gas * ~0.006 gwei estimate because Base is an OP-stack L2 and every tx also pays an L1 data
// fee on top of L2 execution gas). This is the first real, on-chain-confirmed proof that a
// 1Claw-signed transaction can actually be delivered — the exact thing 1Claw's own broadcaster
// currently fails to do. oneClawSignAndBroadcastRelay is genuinely real now, not just unit-tested.
//
//   ONE_CLAW_EXTRACTION_AGENT_ID=$(grep -oP '(?<=^ONE_CLAW_EXTRACTION_AGENT_ID=).*' ~/.secrets/verdict.env) \
//   ONE_CLAW_EXTRACTION_AGENT_API_KEY=$(grep -oP '(?<=^ONE_CLAW_EXTRACTION_AGENT_API_KEY=).*' ~/.secrets/verdict.env) \
//     npx tsx scripts/oneclaw-sign-and-broadcast-live-test.ts
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { sendRawTransaction } from "viem/actions";
import { OneClawClient } from "../../oneclaw-client/src/client.ts";

const RPC_URL = "https://mainnet.base.org";
const agentId = process.env.ONE_CLAW_EXTRACTION_AGENT_ID!;
const agentApiKey = process.env.ONE_CLAW_EXTRACTION_AGENT_API_KEY!;
const SIGNING_KEY_ADDRESS = "0x2590fc6823ede90dbebac41bb5759c14555e6aab" as const; // this agent's real Base signing key

async function main() {
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const client = new OneClawClient({ agentId, agentApiKey });

  const nonceBefore = await publicClient.getTransactionCount({ address: SIGNING_KEY_ADDRESS });
  const balanceBefore = await publicClient.getBalance({ address: SIGNING_KEY_ADDRESS });
  console.log("Before:", { nonce: nonceBefore, balanceWei: balanceBefore.toString() });

  console.log("\nSigning a trivial 0-value self-transfer via 1Claw (no broadcast from 1Claw's side)...");
  const signed = await client.signTransaction(agentId, {
    chain: "base",
    to: SIGNING_KEY_ADDRESS,
    value: "0",
  });
  console.log("Signed:", { tx_hash: signed.tx_hash, from: signed.from, nonce: signed.nonce, status: signed.status });

  console.log("\nBroadcasting the raw signed tx ourselves via eth_sendRawTransaction (bypassing 1Claw's broadcaster)...");
  const broadcastHash = await sendRawTransaction(publicClient, { serializedTransaction: signed.signed_tx });
  console.log("Broadcast tx hash:", broadcastHash);
  console.log("1Claw's own predicted tx_hash:", signed.tx_hash, "MATCH:", broadcastHash.toLowerCase() === signed.tx_hash.toLowerCase());

  console.log("\nWaiting for a real receipt...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: broadcastHash });
  console.log("Receipt:", { status: receipt.status, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });

  // api.base.org's public RPC load-balances across nodes with visible eventual-consistency lag
  // (confirmed live 2026-09-29, see base-mainnet-demo.ts's header comment) — a nonce/balance read
  // immediately after a just-confirmed receipt can still land on a node that hasn't caught up. A
  // short wait and retry avoids a false "nothing changed" reading here.
  let nonceAfter = await publicClient.getTransactionCount({ address: SIGNING_KEY_ADDRESS });
  for (let i = 0; i < 5 && nonceAfter === nonceBefore; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    nonceAfter = await publicClient.getTransactionCount({ address: SIGNING_KEY_ADDRESS });
  }
  const balanceAfter = await publicClient.getBalance({ address: SIGNING_KEY_ADDRESS });
  console.log("\nAfter:", { nonce: nonceAfter, balanceWei: balanceAfter.toString() });
  console.log("NONCE ADVANCED:", nonceAfter === nonceBefore + 1);
  console.log("REAL DELIVERY CONFIRMED:", receipt.status === "success" && nonceAfter === nonceBefore + 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
