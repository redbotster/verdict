// Attempted the final proof docs/DAY-ONE-FINDINGS.md §25 flagged as still missing: an actual on-chain
// submitAttestation() against a freshly deployed real contract, using a brand-new real IMD
// attestation obtained after the schema fix, via a real live run through resolveDeal() itself — the
// same production function the deployed resolver webhook calls.
//
// Run for real 2026-09-30: found something bigger than what it set out to prove. resolveDeal()
// correctly refused the real attestation with question_hash_mismatch — not a bug in this script or
// in §25's fix, but a real, separate, deeper bug this run is what discovered: oracle-compiler's
// templates build a *relative* evidence window (window: {hours: N}), which IMD re-pins to exact
// blocks at the moment of *each* quote — meaning the questionHash computed at compile time can never
// match the one from a real resolution-time re-quote, for any realistic gap between creating a deal
// and resolving it. See docs/DAY-ONE-FINDINGS.md §27 for the full story, including the free
// (zero-cost) confirmation that repeated quotes of the identical input drift apart after ~90 seconds.
// No funds were lost — resolveDeal() refused before ever calling submitAttestation(), and the real
// $IMD escrowed here was fully recovered via reclaim()+withdraw() once the demo's short deadline
// elapsed. Kept as-is (not rewritten around the finding) since it's a real, complete, reproducible
// run — re-run this once §27 is actually fixed to get the real, complete end-to-end proof.
//
// Deliberate, small, self-dealing demo (one wallet plays payer, payee, fee recipient, deployer,
// resolver — NOT a real deal between real counterparties). Runs on Ethereum mainnet, not Base — the
// ops wallet's Base balance was accidentally swapped away by the user this session, but this proof
// doesn't need Base at all: escrows a small real amount of $IMD itself (an ordinary ERC20 on
// Ethereum mainnet, real Permit2 allowance already in place from prior real payments, gas currently
// ~0.14 gwei). The escrow's oracleSigner is IMD's REAL confirmed signing address (not a throwaway
// local key, unlike base-mainnet-demo.ts before §25).
//
//   VERDICT_PRIVATE_KEY=$(grep -oP '(?<=^EVM_PRIVATE_KEY=).*' ~/.secrets/verdict.env) npm run mainnet-real-attestation-demo
import { createPublicClient, createWalletClient, http, keccak256, toHex, encodeAbiParameters, getContractAddress, parseAbi, parseEther, parseGwei } from "viem";
import type { Account, Chain, Hash, PublicClient, Transport, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

// The default public RPC's eth_maxPriorityFeePerGas returned 0 on a first real run of this script,
// producing a transaction with maxPriorityFeePerGas: 0 that never got included (no validator
// incentive) — confirmed by reading the stuck tx back via eth_getTransaction and observing it sit
// unconfirmed. A 0 tip is a real, observed RPC behavior, not something to retry blindly around;
// fixed by flooring the chain's default priority fee, which applies to every tx this script's
// walletClient sends, including the ones relay.ts sends internally via resolveDeal()/withdraw().
const mainnetWithMinPriorityFee = { ...mainnet, fees: { maxPriorityFeePerGas: parseGwei("0.5") } };

import { compileDeal } from "../../oracle-compiler/src/compile.ts";
import type { Extraction } from "../../oracle-compiler/src/types.ts";
import { generateClientToken } from "../../imd-client/src/client.ts";
import { loadMilestoneEscrowArtifact } from "../src/artifact.ts";
import { withdraw, readEscrowState } from "../src/relay.ts";
import { imdPaymentSigner } from "../src/paymentSigner.ts";
import { resolveDeal } from "../src/resolve.ts";

const DOMAIN_NAME = "IdentityMD Oracle"; // real value, confirmed against IMD's own attestation endpoint — docs/DAY-ONE-FINDINGS.md §25
const DOMAIN_VERSION = "1";
const IMD_TOKEN = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7" as const; // the $IMD ERC20 itself, used here as the escrowed token
const REAL_ORACLE_SIGNER = "0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982" as const; // confirmed live — docs/DAY-ONE-FINDINGS.md §25
const ESCROW_AMOUNT = parseEther("1"); // 1 IMD — small, leaves the rest of the wallet's real $IMD free to actually pay for the oracle.request

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function main() {
  const privateKey = process.env.VERDICT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("set VERDICT_PRIVATE_KEY");
  const wallet = privateKeyToAccount(privateKey);
  console.log("wallet (payer=payee=feeRecipient=deployer=resolver):", wallet.address);
  console.log("oracle signer: IMD's real confirmed address,", REAL_ORACLE_SIGNER);

  const publicClient = createPublicClient({ chain: mainnetWithMinPriorityFee, transport: http() }) as unknown as PublicClient;
  const walletClient = createWalletClient({ account: wallet, chain: mainnetWithMinPriorityFee, transport: http() }) as unknown as WalletClient<Transport, Chain, Account>;

  async function mustSucceed(hash: Hash, label: string) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted on-chain (tx ${hash}) — see etherscan for the reason`);
    return receipt;
  }

  // --- Step 1: a real, free IMD quote for a real questionHash. Single unambiguous URL, same trick
  // that worked in §19/§25 — avoids the §15 citation-divergence disagreement failure mode. ---
  const deadlineIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const extraction: Extraction = {
    claim: "https://github.com serves content matching 'GitHub'",
    evidenceUrls: ["https://github.com"],
    deadlineIso,
    timezone: "UTC",
    ambiguousTerms: [],
    kind: "page_or_file_live",
    githubRepo: null,
    urlToCheck: "https://github.com",
    urlContentCheck: "GitHub",
    chainId: null,
    recipientAddress: null,
    tokenAddress: null,
    minAmountBaseUnits: null,
  };
  const compileResult = await compileDeal("https://github.com must serve content matching 'GitHub'.", { extract: async () => extraction });
  if (!compileResult.ok) throw new Error(`compileDeal refused: ${compileResult.reason.code} — ${compileResult.reason.detail}`);
  const questionHash = compileResult.questionHash as `0x${string}`;
  log("1. compileDeal() — real IMD quote (free)", { questionHash, question: compileResult.input.question });

  // --- Step 2: check real $IMD balance and approve the predicted escrow address ---
  const imdAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
  const balance = await publicClient.readContract({ address: IMD_TOKEN, abi: imdAbi, functionName: "balanceOf", args: [wallet.address] });
  if (balance < ESCROW_AMOUNT) throw new Error(`wallet holds ${balance} $IMD, need at least ${ESCROW_AMOUNT} to escrow`);
  console.log(`   wallet $IMD balance: ${balance} — escrowing ${ESCROW_AMOUNT}, ${balance - ESCROW_AMOUNT} left free for the real oracle.request payment`);

  const nonce = await publicClient.getTransactionCount({ address: wallet.address });
  const predictedEscrow = getContractAddress({ from: wallet.address, nonce: BigInt(nonce + 1) });

  const approveHash = await walletClient.writeContract({ address: IMD_TOKEN, abi: imdAbi, functionName: "approve", args: [predictedEscrow, ESCROW_AMOUNT] });
  await mustSucceed(approveHash, "approve");
  log("2. Approved the predicted escrow address for the real $IMD amount", { predictedEscrow, approveHash });

  // --- Step 3: sign the payer authorization and deploy the real contract, real terms, real oracle signer ---
  const constructBlock = await publicClient.getBlock();
  const nowAtConstruct = constructBlock.timestamp;
  const DEADLINE = nowAtConstruct + 600n; // real panel assessment takes real wall-clock time (~2 min typically)
  const GRACE = 60n;
  const CHALLENGE_WINDOW = 20n; // short so this demo finishes in real time, not a security parameter here
  const FEE_BPS = 0;

  const { abi, bytecode } = loadMilestoneEscrowArtifact();
  const TERMS_TYPEHASH = keccak256(
    toHex(
      "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)",
    ),
  );
  const termsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint64" }],
      [TERMS_TYPEHASH, wallet.address, wallet.address, IMD_TOKEN, ESCROW_AMOUNT, DEADLINE, GRACE, questionHash, REAL_ORACLE_SIGNER, wallet.address, FEE_BPS, CHALLENGE_WINDOW],
    ),
  );
  const payerAuthorization = await wallet.signMessage({ message: { raw: termsHash } });

  const deployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [wallet.address, wallet.address, IMD_TOKEN, ESCROW_AMOUNT, DEADLINE, GRACE, questionHash, REAL_ORACLE_SIGNER, wallet.address, FEE_BPS, CHALLENGE_WINDOW, DOMAIN_NAME, DOMAIN_VERSION, payerAuthorization],
  });
  const receipt = await mustSucceed(deployHash, "deploy");
  const escrowAddress = receipt.contractAddress!;
  if (escrowAddress.toLowerCase() !== predictedEscrow.toLowerCase()) {
    throw new Error(`deployed to ${escrowAddress}, predicted ${predictedEscrow} — nonce assumption broke`);
  }
  log("3. Deployed the real MilestoneEscrow to Ethereum mainnet, real IMD oracle signer bound", { escrowAddress, deployHash, amount: ESCROW_AMOUNT.toString() });
  console.log(`   https://etherscan.io/address/${escrowAddress}`);

  // --- Step 4: resolveDeal() — the actual production function, real paid oracle.request, real
  // consumer bound to this exact escrow, real attestation, real on-chain submit ---
  console.log("\n4. Calling resolveDeal() for real — this spends real $IMD and waits out real panel assessment time...");
  const fee = (ESCROW_AMOUNT * BigInt(FEE_BPS)) / 10000n;
  const payoutEstimateBaseUnits = ESCROW_AMOUNT - fee;
  const commonOptions = () => ({
    imdToken: generateClientToken(),
    paymentSigner: imdPaymentSigner(wallet),
    publicClient,
    walletClient,
    approvalThresholdBaseUnits: payoutEstimateBaseUnits + 1n, // this deal auto-settles, no approval gate needed
  });
  const result1 = await resolveDeal(
    { escrow: { address: escrowAddress, chainId: 1 }, oracleInput: compileResult.input, expectedQuestionHash: questionHash, payoutEstimateBaseUnits },
    commonOptions(),
  );
  log("4. resolveDeal() result (first call)", result1);

  if (result1.relayed && !result1.settled && result1.settleBlockedReason === "release_failed") {
    console.log(`\nChallenge window likely hasn't elapsed yet — waiting ${CHALLENGE_WINDOW}s (real time) and calling resolveDeal() again...`);
    console.log("(per §24's idempotency fix, this retry must NOT re-buy an attestation — trueAt is already set on-chain)");
    await new Promise((r) => setTimeout(r, Number(CHALLENGE_WINDOW) * 1000 + 10_000));
    const result2 = await resolveDeal(
      { escrow: { address: escrowAddress, chainId: 1 }, oracleInput: compileResult.input, expectedQuestionHash: questionHash, payoutEstimateBaseUnits },
      commonOptions(),
    );
    log("4b. resolveDeal() result (second call, idempotent retry)", result2);
  }

  // --- Step 5: withdraw the owed balance back to the wallet ---
  const imdBeforeWithdraw = await publicClient.readContract({ address: IMD_TOKEN, abi: imdAbi, functionName: "balanceOf", args: [wallet.address] });
  const withdrawHash = await withdraw(walletClient, escrowAddress, wallet.address);
  await mustSucceed(withdrawHash, "withdraw");
  const imdAfterWithdraw = await publicClient.readContract({ address: IMD_TOKEN, abi: imdAbi, functionName: "balanceOf", args: [wallet.address] });
  log("5. withdraw() — real tx", { withdrawHash, imdBefore: imdBeforeWithdraw.toString(), imdAfter: imdAfterWithdraw.toString() });

  // --- Step 6: final state ---
  const finalState = await readEscrowState(publicClient, escrowAddress, wallet.address);
  log("6. Final on-chain state", { state: ["Funded", "Released", "Refunded"][finalState.state], trueAt: finalState.trueAt.toString(), owed: finalState.owed.toString() });
  console.log(`\nDONE. Escrow contract, live on Ethereum mainnet, settled with a REAL IMD attestation: https://etherscan.io/address/${escrowAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
