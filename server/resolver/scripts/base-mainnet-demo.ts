// Proves MilestoneEscrow.sol works for real, on a real live chain, with real money — not just on
// local Anvil. Run at the user's explicit request (2026-09-29) as a deliberate, small, self-dealing
// demo: NOT a real deal between real counterparties. One wallet plays every role (payer, payee, fee
// recipient, deployer, resolver); only the oracle signer is a throwaway local key generated fresh
// for this run, standing in for IMD's real signer, which this project cannot use yet (see
// docs/DAY-ONE-FINDINGS.md — the payment-signing schema is still unconfirmed and intentionally not
// guessed at). Uses the real compiled contract bytecode, the real deployed USDC on Base, and a real
// questionHash from a free, real IMD quote — everything that CAN be real, is.
//
// Confirmed live 2026-09-29: api.base.org's public RPC load-balances across nodes with visible
// eventual-consistency lag — a `getBlock()` read used minutes later for an attestation's `issuedAt`
// came from a node ~2 minutes ahead of the one that actually mined later transactions, tripping the
// contract's own BadIssuedAt() replay-safety check; and a write's own preflight simulation
// immediately after a just-confirmed prior write twice hit a node that hadn't caught up yet
// (SETTLE_ALL-style "insufficient allowance" on deploy, "NotYetTrue" on release, "NothingOwed" on
// withdraw — all transient, all correct on retry). Mitigated here two ways: read `issuedAt` fresh,
// immediately before use, rather than reusing an early timestamp; and check receipt.status
// explicitly after every write instead of assuming a non-throwing waitForTransactionReceipt means
// success (it doesn't — it returns the receipt regardless of revert status).
//
//   VERDICT_PRIVATE_KEY=$(grep -oP '(?<=^EVM_PRIVATE_KEY=).*' ~/.secrets/verdict.env) npm run base-mainnet-demo

import { createPublicClient, createWalletClient, http, keccak256, toHex, encodeAbiParameters, getContractAddress, parseAbi, zeroHash } from "viem";
import type { Account, Chain, Hash, PublicClient, Transport, WalletClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";

import { compileDeal } from "../../oracle-compiler/src/compile.ts";
import type { Extraction } from "../../oracle-compiler/src/types.ts";
import { loadMilestoneEscrowArtifact } from "../src/artifact.ts";
import { submitAttestation, release, withdraw, readEscrowState } from "../src/relay.ts";
import { attestationDomain, ATTESTATION_TYPES } from "../src/eip712.ts";

const RPC_URL = "https://mainnet.base.org";
const DOMAIN_NAME = "IdentityMD Oracle"; // real value, confirmed against IMD's own attestation endpoint — docs/DAY-ONE-FINDINGS.md §25
const DOMAIN_VERSION = "1";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const; // confirmed 2026-09-29, see DAY-ONE-FINDINGS.md §11

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(detail);
}

async function main() {
  const privateKey = process.env.VERDICT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("set VERDICT_PRIVATE_KEY");
  const wallet = privateKeyToAccount(privateKey);
  const oracleKey = generatePrivateKey();
  const oracle = privateKeyToAccount(oracleKey); // throwaway — stands in for IMD's real signer

  // relay.ts's Signer/PublicClient types use viem's generic Chain, which structurally clashes with
  // Base's OP-stack-specific chain type (extra "deposit" transaction variant) — a known viem typing
  // friction point, not a real runtime incompatibility. Cast once here rather than widen relay.ts's
  // public types for one script's sake.
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) }) as unknown as PublicClient;
  const walletClient = createWalletClient({ account: wallet, chain: base, transport: http(RPC_URL) }) as unknown as WalletClient<Transport, Chain, Account>;

  console.log("wallet (payer=payee=feeRecipient=deployer=resolver):", wallet.address);
  console.log("throwaway oracle signer (NOT IMD's real key):", oracle.address);
  console.log("oracle private key (safety net only — print and discard if this run completes):", oracleKey);

  async function mustSucceed(hash: Hash, label: string) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted on-chain (tx ${hash}) — see basescan for the reason`);
    return receipt;
  }
  const settle = () => new Promise((r) => setTimeout(r, 5000)); // let the RPC's replicas catch up

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
  const usdcAbi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ]);
  const AMOUNT = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [wallet.address] });
  if (AMOUNT === 0n) throw new Error("wallet holds no USDC on Base — nothing to escrow");
  console.log(`   escrow amount: ${AMOUNT} (all of the wallet's real USDC)`);

  const nonce = await publicClient.getTransactionCount({ address: wallet.address });
  const predictedEscrow = getContractAddress({ from: wallet.address, nonce: BigInt(nonce + 1) }); // +1: the approve tx below consumes this nonce first

  const approveHash = await walletClient.writeContract({ address: USDC, abi: usdcAbi, functionName: "approve", args: [predictedEscrow, AMOUNT] });
  await mustSucceed(approveHash, "approve"); // must be mined before the constructor's transferFrom runs
  await settle();
  log("2. Approved the predicted escrow address for the real USDC amount", { predictedEscrow, approveHash });

  // --- Step 3: sign the payer authorization and deploy the real contract, real terms ---
  const constructBlock = await publicClient.getBlock();
  const nowAtConstruct = constructBlock.timestamp;
  const DEADLINE = nowAtConstruct + 120n; // does not need to elapse for the true-answer path; kept short regardless
  const GRACE = 60n;
  const CHALLENGE_WINDOW = 20n; // short so this demo finishes in real time, not because it's a security parameter here
  const FEE_BPS = 0; // payer=payee=feeRecipient are the same address — fee split is moot for this demo

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

  // --- Step 4: sign and submit a real true attestation (from our own throwaway oracle key) ---
  // issuedAt is read fresh, right here, rather than reusing nowAtConstruct from minutes earlier —
  // see the file header on why that matters on this RPC.
  const attestBlock = await publicClient.getBlock();
  const nowAtAttest = attestBlock.timestamp;
  // AttestationMessage (boolean `answer`) is what submitAttestation() takes — relay.ts's
  // toAbiMessage() encodes `answer` into the real wire shape internally. signTypedData below needs
  // the raw wire shape directly, so `answer` is ABI-encoded separately for that call. Real field
  // shapes confirmed live — docs/DAY-ONE-FINDINGS.md §25.
  const message = {
    requestId: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    chainId: 8453n,
    questionHash,
    answerType: 0,
    answer: true,
    figure: 0n,
    fromBlock: 1n,
    toBlock: 2n,
    blockHash: zeroHash,
    panelJobId: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
    issuedAt: nowAtAttest,
    expiresAt: nowAtAttest + 3600n,
  };
  const signature = await oracle.signTypedData({
    domain: attestationDomain(8453, escrowAddress, DOMAIN_NAME, DOMAIN_VERSION),
    types: ATTESTATION_TYPES,
    primaryType: "OracleAttestation",
    message: { ...message, answer: encodeAbiParameters([{ type: "bool" }], [message.answer]) },
  });
  const submitHash = await submitAttestation(walletClient, escrowAddress, { message, signature });
  await mustSucceed(submitHash, "submitAttestation");
  await settle();
  log("4. submitAttestation() — real tx, real signature verified on-chain", { submitHash });

  // --- Step 5: wait out the real challenge window, then release ---
  console.log(`\nWaiting ${CHALLENGE_WINDOW}s (real time) for the challenge window to elapse...`);
  await new Promise((r) => setTimeout(r, Number(CHALLENGE_WINDOW) * 1000 + 5000));
  const releaseHash = await release(walletClient, escrowAddress);
  await mustSucceed(releaseHash, "release");
  await settle();
  log("5. release() — real tx", { releaseHash });

  // --- Step 6: withdraw the owed balance back to the wallet ---
  const usdcBeforeWithdraw = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [wallet.address] });
  const withdrawHash = await withdraw(walletClient, escrowAddress, wallet.address);
  await mustSucceed(withdrawHash, "withdraw");
  const usdcAfterWithdraw = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [wallet.address] });
  log("6. withdraw() — real tx", { withdrawHash, usdcBefore: usdcBeforeWithdraw.toString(), usdcAfter: usdcAfterWithdraw.toString() });

  // --- Step 7: final state, the same fields the status page renders ---
  const finalState = await readEscrowState(publicClient, escrowAddress, wallet.address);
  log("7. Final on-chain state", { state: ["Funded", "Released", "Refunded"][finalState.state], trueAt: finalState.trueAt.toString(), owed: finalState.owed.toString() });
  console.log(`\nEscrow contract, live on Base mainnet: https://basescan.org/address/${escrowAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
