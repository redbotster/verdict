// Deploys a real MilestoneEscrow (and MockUSDC) to a local Anvil chain, settles it to Released, and
// writes lib/demo-deal.local.json so the status page has genuine on-chain state to render during
// local development. Requires `forge build` to have run in contracts/. Leaves Anvil running in the
// background afterward — kill it with the PID this script prints when you're done.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, encodeAbiParameters, getContractAddress, type Abi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const ANVIL_PORT = 8548;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

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

async function main() {
  const anvilBin = path.join(homedir(), ".foundry", "bin", "anvil");
  const anvil = spawn(anvilBin, ["--port", String(ANVIL_PORT), "--mnemonic", TEST_MNEMONIC], { detached: true, stdio: "ignore" });
  anvil.unref();
  await waitForAnvil();
  console.log(`anvil running in the background on ${RPC_URL} (pid ${anvil.pid}) — kill it with \`kill ${anvil.pid}\` when done`);

  const escrowArtifact = loadArtifact("../../contracts/out/MilestoneEscrow.sol/MilestoneEscrow.json");
  const usdcArtifact = loadArtifact("../../contracts/out/MockUSDC.sol/MockUSDC.json");

  const deployer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
  const payer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
  const payee = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 });
  const oracle = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 3 });
  const feeRecipient = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 5 });

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
  const walletFor = (account: typeof deployer) => createWalletClient({ account, chain: foundry, transport: http(RPC_URL) });

  const usdcDeployHash = await walletFor(deployer).deployContract({ abi: usdcArtifact.abi, bytecode: usdcArtifact.bytecode.object, args: [] });
  const tokenAddress = (await publicClient.waitForTransactionReceipt({ hash: usdcDeployHash })).contractAddress!;

  const AMOUNT = 2_500_000_000n; // 2500 USDC at 6 decimals
  const mintHash = await walletFor(deployer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "mint", args: [payer.address, AMOUNT] });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  // Must read the nonce after the mint is mined, not just submitted — see server/resolver's integration test.
  const deployerNonce = await publicClient.getTransactionCount({ address: deployer.address });
  const predictedEscrow = getContractAddress({ from: deployer.address, nonce: BigInt(deployerNonce) });
  const approveHash = await walletFor(payer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "approve", args: [predictedEscrow, AMOUNT] });
  await publicClient.waitForTransactionReceipt({ hash: approveHash }); // must be mined before the escrow constructor's transferFrom runs

  const latestBlock = await publicClient.getBlock();
  const now = latestBlock.timestamp;
  const DEADLINE = now + 3600n;
  const GRACE = 3600n;
  const CHALLENGE_WINDOW = 60n;
  const FEE_BPS = 150;
  const REPO = "acme/widget";
  const QUESTION = `Did ${REPO} publish a non-prerelease GitHub release between now and the deadline?`;
  const QUESTION_HASH = keccak256(toHex(QUESTION));
  const DOMAIN_NAME = "IMD-Attestation";
  const DOMAIN_VERSION = "1";

  const TERMS_TYPEHASH = keccak256(
    toHex(
      "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)",
    ),
  );
  const termsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint64" }],
      [TERMS_TYPEHASH, payer.address, payee.address, tokenAddress, AMOUNT, DEADLINE, GRACE, QUESTION_HASH, oracle.address, feeRecipient.address, FEE_BPS, CHALLENGE_WINDOW],
    ),
  );
  const payerAuthorization = await payer.signMessage({ message: { raw: termsHash } });

  const escrowDeployHash = await walletFor(deployer).deployContract({
    abi: escrowArtifact.abi,
    bytecode: escrowArtifact.bytecode.object,
    args: [payer.address, payee.address, tokenAddress, AMOUNT, DEADLINE, GRACE, QUESTION_HASH, oracle.address, feeRecipient.address, FEE_BPS, CHALLENGE_WINDOW, DOMAIN_NAME, DOMAIN_VERSION, payerAuthorization],
  });
  const escrowAddress = (await publicClient.waitForTransactionReceipt({ hash: escrowDeployHash })).contractAddress!;

  // Settle it to Released, so the demo page has something more interesting than "Funded" to show.
  const ATTESTATION_TYPES = {
    Attestation: [
      { name: "requestId", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "questionHash", type: "bytes32" },
      { name: "answerType", type: "string" },
      { name: "answer", type: "bool" },
      { name: "figure", type: "string" },
      { name: "fromBlock", type: "uint256" },
      { name: "toBlock", type: "uint256" },
      { name: "panelJobId", type: "string" },
      { name: "issuedAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
    ],
  } as const;
  const message = {
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
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: 31337, verifyingContract: escrowAddress },
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message,
  });
  const submitHash = await walletFor(deployer).writeContract({ address: escrowAddress, abi: escrowArtifact.abi, functionName: "submitAttestation", args: [message, signature] });
  await publicClient.waitForTransactionReceipt({ hash: submitHash });

  const testClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) }); // reuse for a raw request below
  await testClient.request({ method: "evm_increaseTime" as never, params: [61] as never });
  await testClient.request({ method: "evm_mine" as never, params: [] as never });

  const releaseHash = await walletFor(deployer).writeContract({ address: escrowAddress, abi: escrowArtifact.abi, functionName: "release", args: [] });
  await publicClient.waitForTransactionReceipt({ hash: releaseHash });

  const demoDeal = {
    [escrowAddress.toLowerCase()]: {
      title: `${REPO} release bounty`,
      rpcUrl: RPC_URL,
      chainId: 31337,
      question: QUESTION,
      sources: [`https://github.com/${REPO}/`],
      panelSize: 5,
      quorum: 4,
    },
  };
  const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/demo-deal.local.json");
  writeFileSync(outPath, JSON.stringify(demoDeal, null, 2));

  console.log(`\nDemo deal deployed and released: ${escrowAddress}`);
  console.log(`Wrote ${outPath}`);
  console.log(`Run \`npm run dev\` and visit http://localhost:3000/deals/${escrowAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
