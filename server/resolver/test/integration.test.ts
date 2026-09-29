// Real end-to-end test: spins up a local Anvil chain, deploys the ACTUAL compiled MilestoneEscrow
// bytecode (not a mock), signs a real EIP-712 attestation with a test oracle key, and relays it
// on-chain through this package's own relay.ts — proving the resolver's chain interaction genuinely
// works against the real contract, not just against a description of it. Requires `forge build` to
// have run in contracts/ (same dependency as artifact.ts documents).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  keccak256,
  toHex,
  encodeAbiParameters,
  getContractAddress,
  type Abi,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { submitAttestation, release, withdraw, readEscrowState } from "../src/relay.ts";
import { attestationDomain, ATTESTATION_TYPES } from "../src/eip712.ts";
import type { AttestationMessage } from "../src/types.ts";

const ANVIL_PORT = 8547;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
// Standard, public, well-known Hardhat/Foundry test mnemonic — never used for anything but local
// ephemeral test chains. Passed explicitly so the derived accounts (and anvil's auto-funding of
// them) are deterministic, rather than relying on anvil's own randomly-generated default.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

function loadArtifact(relPath: string): { abi: Abi; bytecode: { object: `0x${string}` } } {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), relPath);
  return JSON.parse(readFileSync(p, "utf-8"));
}

let anvil: ChildProcess;

before(async () => {
  const anvilBin = path.join(homedir(), ".foundry", "bin", "anvil");
  anvil = spawn(anvilBin, ["--port", String(ANVIL_PORT), "--mnemonic", TEST_MNEMONIC, "--silent"]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("anvil did not become ready in time");
});

after(() => {
  anvil?.kill();
});

test("resolver relay: submitAttestation and release against a real deployed MilestoneEscrow on a local chain", async () => {
  const escrowArtifact = loadArtifact("../../../contracts/out/MilestoneEscrow.sol/MilestoneEscrow.json");
  const usdcArtifact = loadArtifact("../../../contracts/out/MockUSDC.sol/MockUSDC.json");

  const deployer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
  const payer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
  const payee = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 });
  const oracle = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 3 });
  const resolverAccount = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 4 });
  const feeRecipient = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 5 });

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
  const testClient = createTestClient({ mode: "anvil", chain: foundry, transport: http(RPC_URL) });
  const walletFor = (account: typeof deployer) => createWalletClient({ account, chain: foundry, transport: http(RPC_URL) });

  // --- Deploy MockUSDC, mint to the payer ---
  const usdcDeployHash = await walletFor(deployer).deployContract({ abi: usdcArtifact.abi, bytecode: usdcArtifact.bytecode.object, args: [] });
  const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcDeployHash });
  const tokenAddress = usdcReceipt.contractAddress!;

  const AMOUNT = 1_000_000_000n; // 1000 USDC at 6 decimals
  const mintHash = await walletFor(deployer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "mint", args: [payer.address, AMOUNT] });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  // --- Predict the escrow's address so the payer can pre-approve it (the constructor pulls funds) ---
  // Must read the nonce AFTER the mint is mined (not just submitted) — a query issued in the gap
  // between submission and mining is a real race, rare enough to never show up locally but real on a
  // loaded CI runner, and it silently predicts the wrong address rather than erroring immediately.
  const deployerNonce = await publicClient.getTransactionCount({ address: deployer.address });
  const predictedEscrow = getContractAddress({ from: deployer.address, nonce: BigInt(deployerNonce) });
  const approveHash = await walletFor(payer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "approve", args: [predictedEscrow, AMOUNT] });
  await publicClient.waitForTransactionReceipt({ hash: approveHash }); // must be mined before the escrow constructor's transferFrom runs

  // --- Build deal terms and the payer's authorization signature (mirrors the contract's own check) ---
  const latestBlock = await publicClient.getBlock();
  const now = latestBlock.timestamp;
  const DEADLINE = now + 3600n;
  const GRACE = 3600n;
  const CHALLENGE_WINDOW = 60n; // short, so the test can advance past it quickly
  const FEE_BPS = 100;
  const QUESTION_HASH = keccak256(toHex("integration-test-question"));
  const DOMAIN_NAME = "IMD-Attestation";
  const DOMAIN_VERSION = "1";

  // Verified against contracts/src/MilestoneEscrow.sol's TERMS_TYPEHASH string directly.
  const TERMS_TYPEHASH = keccak256(
    toHex(
      "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)",
    ),
  );
  const termsHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint16" },
        { type: "uint64" },
      ],
      [TERMS_TYPEHASH, payer.address, payee.address, tokenAddress, AMOUNT, DEADLINE, GRACE, QUESTION_HASH, oracle.address, feeRecipient.address, FEE_BPS, CHALLENGE_WINDOW],
    ),
  );
  const payerAuthorization = await payer.signMessage({ message: { raw: termsHash } });

  // --- Deploy the real MilestoneEscrow ---
  const escrowDeployHash = await walletFor(deployer).deployContract({
    abi: escrowArtifact.abi,
    bytecode: escrowArtifact.bytecode.object,
    args: [
      payer.address,
      payee.address,
      tokenAddress,
      AMOUNT,
      DEADLINE,
      GRACE,
      QUESTION_HASH,
      oracle.address,
      feeRecipient.address,
      FEE_BPS,
      CHALLENGE_WINDOW,
      DOMAIN_NAME,
      DOMAIN_VERSION,
      payerAuthorization,
    ],
  });
  const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowDeployHash });
  const escrowAddress = escrowReceipt.contractAddress!;
  assert.equal(escrowAddress.toLowerCase(), predictedEscrow.toLowerCase());

  // --- The "oracle" signs a real Attestation; the resolver (a fourth, unrelated account) relays it ---
  const message: AttestationMessage = {
    requestId: 1n,
    chainId: 31337n,
    questionHash: QUESTION_HASH,
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

  const resolverWallet = walletFor(resolverAccount);
  const relayTxHash = await submitAttestation(resolverWallet, escrowAddress, { message, signature });
  await publicClient.waitForTransactionReceipt({ hash: relayTxHash });

  const afterTrue = await readEscrowState(publicClient, escrowAddress, payee.address);
  assert.equal(afterTrue.state, 0); // still Funded — challenge window hasn't elapsed
  assert.notEqual(afterTrue.trueAt, 0n);

  // --- Advance past the challenge window, then settle ---
  await testClient.increaseTime({ seconds: 61 });
  await testClient.mine({ blocks: 1 });

  const releaseTxHash = await release(resolverWallet, escrowAddress);
  await publicClient.waitForTransactionReceipt({ hash: releaseTxHash });

  const afterRelease = await readEscrowState(publicClient, escrowAddress, payee.address);
  assert.equal(afterRelease.state, 1); // Released
  assert.ok(afterRelease.owed > 0n);

  const feeOwed = await publicClient.readContract({ address: escrowAddress, abi: escrowArtifact.abi, functionName: "owed", args: [feeRecipient.address] });
  assert.ok((feeOwed as bigint) > 0n);

  // --- The payee pulls their own payout ---
  const withdrawTxHash = await withdraw(walletFor(payee), escrowAddress, payee.address);
  await publicClient.waitForTransactionReceipt({ hash: withdrawTxHash });

  const payeeBalance = await publicClient.readContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "balanceOf", args: [payee.address] });
  assert.ok((payeeBalance as bigint) > 0n);
});
