// Attempts to prove oneClawTransactionRelay actually BROADCASTS (not just signs) real transactions on
// a real live chain. Run for real 2026-09-29 — it currently FAILS at the submitAttestation() step
// with OneClawBroadcastFailedError: 1Claw signs correctly but its own broadcast infrastructure
// refuses to relay the transaction ("Broadcast failed: Request timeout on the free plan, please
// upgrade to paid plan" — on an org subscribed to the "team" tier, so the message itself may be
// wrong; see docs/DAY-ONE-FINDINGS.md §22's addendum for the full account, including confirming no
// funds were lost: the escrow's real USDC was cleanly reclaimed once the demo deadline elapsed).
// Kept as-is rather than rewritten around the failure — re-run this once 1Claw's broadcast path
// actually works to get the real, complete proof; until then it's a faithful reproduction of the
// real failure, not a passing demo.
//
// Same self-dealing demo shape as base-mainnet-demo.ts (one wallet plays payer/payee/feeRecipient/
// deployer; a throwaway local key stands in for IMD's real oracle signer, since the real paid
// attestation step is already proven separately in §14/§19 and isn't the point of this run) — the
// only difference: submitAttestation() and release() are relayed through 1Claw's real Intents API
// transaction endpoint instead of a local wallet, funded with a small real ETH transfer from the ops
// wallet first (1Claw broadcasts via its own dedicated RPC, so it categorically cannot reach a local
// Anvil chain — this has to be a real chain 1Claw supports).
//
//   VERDICT_PRIVATE_KEY=$(grep -oP '(?<=^EVM_PRIVATE_KEY=).*' ~/.secrets/verdict.env) \
//   ONE_CLAW_EXTRACTION_AGENT_ID=$(grep -oP '(?<=^ONE_CLAW_EXTRACTION_AGENT_ID=).*' ~/.secrets/verdict.env) \
//   ONE_CLAW_EXTRACTION_AGENT_API_KEY=$(grep -oP '(?<=^ONE_CLAW_EXTRACTION_AGENT_API_KEY=).*' ~/.secrets/verdict.env) \
//   DRPC_API_KEY=$(grep -oP '(?<=^DRPC_API_KEY=).*' ~/.secrets/verdict.env) \
//     npx tsx scripts/base-mainnet-oneclaw-relay-demo.ts
import { createPublicClient, createWalletClient, http, keccak256, toHex, encodeAbiParameters, getContractAddress, parseAbi } from "viem";
import type { Account, Chain, Hash, PublicClient, Transport, WalletClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";

import { compileDeal } from "../../oracle-compiler/src/compile.ts";
import type { Extraction } from "../../oracle-compiler/src/types.ts";
import { loadMilestoneEscrowArtifact } from "../src/artifact.ts";
import { withdraw, readEscrowState } from "../src/relay.ts";
import { oneClawTransactionRelay } from "../src/oneClawRelay.ts";
import { OneClawClient } from "../../oneclaw-client/src/client.ts";
import { attestationDomain, ATTESTATION_TYPES } from "../src/eip712.ts";

const RPC_URL = `https://lb.drpc.org/ogrpc?network=base&dkey=${process.env.DRPC_API_KEY}`;
const DOMAIN_NAME = "IMD-Attestation";
const DOMAIN_VERSION = "1";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ONECLAW_SIGNER_ADDRESS = "0x2590fc6823ede90dbebac41bb5759c14555e6aab" as const; // this agent's real ethereum signing key
const FUND_AMOUNT = 50_000_000_000_000n; // 0.00005 ETH — Base gas is ~0.006 gwei, so this is a very safe margin for two contract calls without leaving much stranded

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(detail);
}

async function main() {
  const privateKey = process.env.VERDICT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("set VERDICT_PRIVATE_KEY");
  const wallet = privateKeyToAccount(privateKey);
  const oracleKey = generatePrivateKey();
  const oracle = privateKeyToAccount(oracleKey);

  const agentId = process.env.ONE_CLAW_EXTRACTION_AGENT_ID!;
  const agentApiKey = process.env.ONE_CLAW_EXTRACTION_AGENT_API_KEY!;
  const oneClawClient = new OneClawClient({ agentId, agentApiKey });
  const relay = oneClawTransactionRelay({ client: oneClawClient, agentId, chain: "base" });

  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) }) as unknown as PublicClient;
  const walletClient = createWalletClient({ account: wallet, chain: base, transport: http(RPC_URL) }) as unknown as WalletClient<Transport, Chain, Account>;

  console.log("wallet (payer=payee=feeRecipient=deployer):", wallet.address);
  console.log("throwaway oracle signer (NOT IMD's real key):", oracle.address);
  console.log("1Claw-held relay signer (will call submitAttestation/release for real):", ONECLAW_SIGNER_ADDRESS);

  async function mustSucceed(hash: Hash, label: string) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted on-chain (tx ${hash}) — see basescan for the reason`);
    return receipt;
  }
  const settle = () => new Promise((r) => setTimeout(r, 5000));

  // --- Step 0: fund the 1Claw-held signer with enough real ETH to pay its own gas ---
  const fundHash = await walletClient.sendTransaction({ to: ONECLAW_SIGNER_ADDRESS, value: FUND_AMOUNT });
  await mustSucceed(fundHash, "fund 1Claw signer");
  await settle();
  log("0. Funded the 1Claw-held signer with real ETH for gas", { fundHash, amount: FUND_AMOUNT.toString() });

  // --- Step 1: a real, free IMD quote for a real questionHash ---
  const REPO = "octocat/Hello-World";
  const deadlineIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const fakeExtraction: Extraction = {
    claim: `${REPO} publishes a release`,
    evidenceUrls: [`https://github.com/${REPO}`],
    deadlineIso,
    timezone: "UTC",
    ambiguousTerms: [],
    kind: "release_published",
    githubRepo: REPO,
    urlToCheck: null,
    urlContentCheck: null,
    chainId: null,
    recipientAddress: null,
    tokenAddress: null,
    minAmountBaseUnits: null,
  };
  const compileResult = await compileDeal(`${REPO} must publish a non-prerelease GitHub release by ${deadlineIso}.`, {
    extract: async () => fakeExtraction,
  });
  if (!compileResult.ok) throw new Error(`compileDeal refused: ${compileResult.reason.code} — ${compileResult.reason.detail}`);
  const questionHash = compileResult.questionHash as `0x${string}`;
  log("1. compileDeal() — real IMD quote", { questionHash });

  // --- Step 2: read the real USDC balance and approve the predicted escrow address ---
  const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
  const AMOUNT = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [wallet.address] });
  if (AMOUNT === 0n) throw new Error("wallet holds no USDC on Base — nothing to escrow");
  console.log(`   escrow amount: ${AMOUNT} (all of the wallet's real USDC)`);

  const nonce = await publicClient.getTransactionCount({ address: wallet.address });
  const predictedEscrow = getContractAddress({ from: wallet.address, nonce: BigInt(nonce + 1) });

  const approveHash = await walletClient.writeContract({ address: USDC, abi: usdcAbi, functionName: "approve", args: [predictedEscrow, AMOUNT] });
  await mustSucceed(approveHash, "approve");
  await settle();
  log("2. Approved the predicted escrow address for the real USDC amount", { predictedEscrow, approveHash });

  // --- Step 3: sign the payer authorization and deploy the real contract, real terms ---
  const constructBlock = await publicClient.getBlock();
  const nowAtConstruct = constructBlock.timestamp;
  const DEADLINE = nowAtConstruct + 120n;
  const GRACE = 60n;
  const CHALLENGE_WINDOW = 20n;
  const FEE_BPS = 0;

  const TERMS_TYPEHASH = keccak256(
    toHex(
      "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)",
    ),
  );
  const termsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint64" }],
      [TERMS_TYPEHASH, wallet.address, wallet.address, USDC, AMOUNT, DEADLINE, GRACE, questionHash, oracle.address, wallet.address, FEE_BPS, CHALLENGE_WINDOW],
    ),
  );
  const payerAuthorization = await wallet.signMessage({ message: { raw: termsHash } });

  const { abi, bytecode } = loadMilestoneEscrowArtifact();
  const deployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [wallet.address, wallet.address, USDC, AMOUNT, DEADLINE, GRACE, questionHash, oracle.address, wallet.address, FEE_BPS, CHALLENGE_WINDOW, DOMAIN_NAME, DOMAIN_VERSION, payerAuthorization],
  });
  const receipt = await mustSucceed(deployHash, "deploy");
  const escrowAddress = receipt.contractAddress!;
  if (escrowAddress.toLowerCase() !== predictedEscrow.toLowerCase()) {
    throw new Error(`deployed to ${escrowAddress}, predicted ${predictedEscrow} — nonce assumption broke`);
  }
  await settle();
  log("3. Deployed the real MilestoneEscrow to Base mainnet", { escrowAddress, deployHash, amount: AMOUNT.toString() });

  // --- Step 4: sign a real true attestation, relay it through 1Claw's real transaction endpoint ---
  const attestBlock = await publicClient.getBlock();
  const nowAtAttest = attestBlock.timestamp;
  const message = {
    requestId: 1n,
    chainId: 8453n,
    questionHash,
    answerType: "bool",
    answer: true,
    figure: "",
    fromBlock: 1n,
    toBlock: 2n,
    panelJobId: "oneclaw-relay-demo",
    issuedAt: nowAtAttest,
    expiresAt: nowAtAttest + 3600n,
  };
  const signature = await oracle.signTypedData({
    domain: attestationDomain(8453, escrowAddress, DOMAIN_NAME, DOMAIN_VERSION),
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message,
  });
  const submitHash = await relay.submitAttestation(escrowAddress, { message, signature });
  await mustSucceed(submitHash, "submitAttestation (via 1Claw)");
  await settle();
  log("4. submitAttestation() relayed through 1Claw's real Intents API — real tx, really broadcast", { submitHash });

  // --- Step 5: wait out the real challenge window, then release through 1Claw too ---
  console.log(`\nWaiting ${CHALLENGE_WINDOW}s (real time) for the challenge window to elapse...`);
  await new Promise((r) => setTimeout(r, Number(CHALLENGE_WINDOW) * 1000 + 5000));
  const releaseHash = await relay.release(escrowAddress);
  await mustSucceed(releaseHash, "release (via 1Claw)");
  await settle();
  log("5. release() relayed through 1Claw's real Intents API — real tx", { releaseHash });

  // --- Step 6: withdraw the owed balance back to the wallet (local key — withdraw() isn't part of
  //     resolveDeal()'s flow, so it isn't in TransactionRelay; no need to prove it via 1Claw too) ---
  const usdcBeforeWithdraw = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [wallet.address] });
  const withdrawHash = await withdraw(walletClient, escrowAddress, wallet.address);
  await mustSucceed(withdrawHash, "withdraw");
  const usdcAfterWithdraw = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [wallet.address] });
  log("6. withdraw() — real tx", { withdrawHash, usdcBefore: usdcBeforeWithdraw.toString(), usdcAfter: usdcAfterWithdraw.toString() });

  // --- Step 7: final state ---
  const finalState = await readEscrowState(publicClient, escrowAddress, wallet.address);
  log("7. Final on-chain state", { state: ["Funded", "Released", "Refunded"][finalState.state], trueAt: finalState.trueAt.toString(), owed: finalState.owed.toString() });
  console.log(`\nEscrow contract, live on Base mainnet, resolved entirely via 1Claw's real Intents API: https://basescan.org/address/${escrowAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
