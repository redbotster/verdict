// The capstone: proves oracle-compiler, contracts, and resolver actually compose, not just that each
// passes its own tests in isolation. Every step that's free and confirmed runs for real, against the
// live IMD API and a real local chain with the real compiled bytecode:
//
//   1. compileDeal() — REAL network call to api.imd.fun (free dry-run quote), for a fabricated but
//      realistic deal (extraction is faked, since no LLM key is available here — see oracle-compiler's
//      README). Returns the actual, binding questionHash IMD computed.
//   2. Deploy the REAL compiled MilestoneEscrow to a local Anvil chain, constructor-bound to that
//      exact questionHash — so this is a genuine escrow that would accept a real IMD attestation for
//      this exact question, not a stand-in with a made-up hash.
//   3. pinQuestion() — another REAL, free network call, registering the real deployed address with
//      IMD (per docs/DAY-ONE-FINDINGS.md §5, this doesn't change the hash; it's the bookkeeping step a
//      real resolver would still do before its real paid call).
//   4. resolveDeal() — the one necessarily-faked step: a real payment costs real IMD tokens on mainnet
//      and needs a signing scheme IMD never confirmed (see server/resolver/README.md). getAttestation
//      is overridden with a fake oracle signature over the REAL questionHash from step 1, and
//      everything downstream — the questionHash sanity check, the approval gate, the on-chain relay,
//      the settle attempt — runs for real through resolveDeal()'s actual code.
//   5. Read the final state back with this package's own readEscrowState() — the same on-chain read
//      site/lib/escrow.ts performs (that file can't be imported directly from a plain Node script; see
//      the README note this script prints).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, encodeAbiParameters, getContractAddress, type Abi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { compileDeal, pinQuestion } from "../../oracle-compiler/src/compile.ts";
import type { Extraction } from "../../oracle-compiler/src/types.ts";
import { resolveDeal } from "../src/resolve.ts";
import { readEscrowState } from "../src/relay.ts";
import { attestationDomain, ATTESTATION_TYPES } from "../src/eip712.ts";

const ANVIL_PORT = 8549;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const DOMAIN_NAME = "IMD-Attestation";
const DOMAIN_VERSION = "1";

function loadArtifact(relPath: string): { abi: Abi; bytecode: { object: `0x${string}` } } {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), relPath);
  return JSON.parse(readFileSync(p, "utf-8"));
}

async function waitForAnvil() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("anvil did not become ready in time");
}

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(detail);
}

async function main() {
  // --- Step 1: compile a real question against the live IMD API (free) ---
  const REPO = "octocat/Hello-World";
  const deadlineIso = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour out, for a fast local demo
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
  log("1. compileDeal() — real IMD quote", { kind: compileResult.kind, questionHash: compileResult.questionHash, question: compileResult.input.question });

  // --- Step 2: deploy the real compiled contract, bound to that exact questionHash ---
  const anvilBin = path.join(homedir(), ".foundry", "bin", "anvil");
  const anvil = spawn(anvilBin, ["--port", String(ANVIL_PORT), "--mnemonic", TEST_MNEMONIC], { detached: true, stdio: "ignore" });
  anvil.unref();
  await waitForAnvil();

  const escrowArtifact = loadArtifact("../../../contracts/out/MilestoneEscrow.sol/MilestoneEscrow.json");
  const usdcArtifact = loadArtifact("../../../contracts/out/MockUSDC.sol/MockUSDC.json");

  const deployer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
  const payer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
  const payee = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 });
  const oracle = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 3 });
  const resolverAccount = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 4 });
  const feeRecipient = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 5 });

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
  const walletFor = (account: typeof deployer) => createWalletClient({ account, chain: foundry, transport: http(RPC_URL) });

  const usdcHash = await walletFor(deployer).deployContract({ abi: usdcArtifact.abi, bytecode: usdcArtifact.bytecode.object, args: [] });
  const tokenAddress = (await publicClient.waitForTransactionReceipt({ hash: usdcHash })).contractAddress!;

  const AMOUNT = 1_000_000_000n; // 1000 USDC
  await walletFor(deployer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "mint", args: [payer.address, AMOUNT] });

  const deployerNonce = await publicClient.getTransactionCount({ address: deployer.address });
  const predictedEscrow = getContractAddress({ from: deployer.address, nonce: BigInt(deployerNonce) });
  await walletFor(payer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "approve", args: [predictedEscrow, AMOUNT] });

  const latestBlock = await publicClient.getBlock();
  const now = latestBlock.timestamp;
  const DEADLINE = now + 3600n;
  const GRACE = 3600n;
  const CHALLENGE_WINDOW = 30n;
  const FEE_BPS = 100;

  const TERMS_TYPEHASH = keccak256(
    toHex(
      "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)",
    ),
  );
  const questionHash = compileResult.questionHash as `0x${string}`;
  const termsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint64" }],
      [TERMS_TYPEHASH, payer.address, payee.address, tokenAddress, AMOUNT, DEADLINE, GRACE, questionHash, oracle.address, feeRecipient.address, FEE_BPS, CHALLENGE_WINDOW],
    ),
  );
  const payerAuthorization = await payer.signMessage({ message: { raw: termsHash } });

  const escrowDeployHash = await walletFor(deployer).deployContract({
    abi: escrowArtifact.abi,
    bytecode: escrowArtifact.bytecode.object,
    args: [payer.address, payee.address, tokenAddress, AMOUNT, DEADLINE, GRACE, questionHash, oracle.address, feeRecipient.address, FEE_BPS, CHALLENGE_WINDOW, DOMAIN_NAME, DOMAIN_VERSION, payerAuthorization],
  });
  const escrowAddress = (await publicClient.waitForTransactionReceipt({ hash: escrowDeployHash })).contractAddress!;
  log("2. Deployed the real MilestoneEscrow bytecode, bound to IMD's real questionHash", { escrowAddress });

  // --- Step 3: register the real address with IMD (real, free network call) ---
  const pinnedOrder = await pinQuestion(compileResult.input, { chainId: 31337, verifyingContract: escrowAddress });
  log("3. pinQuestion() — real IMD quote with the real consumer", { orderId: pinnedOrder.id, orderStatus: pinnedOrder.status });

  // --- Step 4: resolveDeal(), faking only the paid oracle-attestation step ---
  const message = {
    requestId: 1n,
    chainId: 31337n,
    questionHash,
    answerType: "bool",
    answer: true,
    figure: "",
    fromBlock: 1n,
    toBlock: 2n,
    panelJobId: "panel-1",
    issuedAt: now,
    expiresAt: now + 3600n,
  };
  const signature = await oracle.signTypedData({
    domain: attestationDomain(31337, escrowAddress, DOMAIN_NAME, DOMAIN_VERSION),
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message,
  });

  const resolveResult = await resolveDeal(
    { escrow: { address: escrowAddress, chainId: 31337 }, oracleInput: compileResult.input, expectedQuestionHash: questionHash, payoutEstimateBaseUnits: AMOUNT },
    {
      walletClient: walletFor(resolverAccount),
      publicClient,
      getAttestation: async () => ({ message, signature }),
      approvalGate: async () => "approved",
    },
  );
  log("4. resolveDeal() — real relay, real settle attempt (paid oracle step faked)", resolveResult.relayed ? { relayed: true, txHash: resolveResult.txHash, settled: resolveResult.settled } : resolveResult);

  if (resolveResult.relayed && !resolveResult.settled) {
    // Challenge window (30s) likely hadn't elapsed yet — wait it out and try again for a clean demo.
    await new Promise((r) => setTimeout(r, 31_000));
    const { release } = await import("../src/relay.ts");
    const retryHash = await release(walletFor(resolverAccount), escrowAddress);
    await publicClient.waitForTransactionReceipt({ hash: retryHash });
  }

  // --- Step 5: read the final state, the same fields site/lib/escrow.ts would show ---
  const finalState = await readEscrowState(publicClient, escrowAddress, payee.address);
  log("5. Final on-chain state (what the status page would render)", { state: ["Funded", "Released", "Refunded"][finalState.state], trueAt: finalState.trueAt.toString(), owedToPayee: finalState.owed.toString() });

  console.log(`\nAnvil is still running in the background (pid ${anvil.pid}) — kill it with \`kill ${anvil.pid}\` when done.`);
  console.log("Note: site/lib/escrow.ts reads the same fields via viem, but can't be imported directly from a plain Node script (Next's bundler resolves extensionless imports; Node's ESM loader doesn't) — step 5 above uses this package's own readEscrowState() instead, which reads the identical contract getters.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
