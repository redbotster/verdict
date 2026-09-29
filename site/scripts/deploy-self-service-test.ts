// Proves the exact sequence app/new/NewDealForm.tsx's handleDeploy() runs in the browser: the payer
// both approves the predicted escrow address AND deploys the contract from the same wallet (unlike
// deploy-demo.ts, where a separate deployer account deploys on the payer's behalf) — so the nonce
// used to predict the CREATE address must be the payer's own nonce *after* the approve tx, not the
// deployer's. Uses the real ABI/bytecode via lib/artifact.ts's loadMilestoneEscrowAbi/Bytecode, the
// exact functions app/new/actions.ts's getDeploymentArtifact() (the server action the browser calls)
// wraps — so this is a real proof of the mechanism, not a hand-duplicated one.
//
// Spins up its own local Anvil on a scratch port; kills it on exit either way.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, encodeAbiParameters, getContractAddress, type Abi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { loadMilestoneEscrowAbi, loadMilestoneEscrowBytecode } from "../lib/artifact.ts";

const ANVIL_PORT = 8549;
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
  const anvil: ChildProcess = spawn(anvilBin, ["--port", String(ANVIL_PORT), "--mnemonic", TEST_MNEMONIC], { stdio: "ignore" });
  try {
    await waitForAnvil();

    const usdcArtifact = loadArtifact("../../contracts/out/MockUSDC.sol/MockUSDC.json");
    const abi = loadMilestoneEscrowAbi();
    const bytecode = loadMilestoneEscrowBytecode();

    const deployer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
    const payer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 }); // approves AND deploys, like the browser flow
    const payee = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 });
    const oracle = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 3 });
    const feeRecipient = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 5 });

    const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
    const walletFor = (account: typeof deployer) => createWalletClient({ account, chain: foundry, transport: http(RPC_URL) });

    const usdcDeployHash = await walletFor(deployer).deployContract({ abi: usdcArtifact.abi, bytecode: usdcArtifact.bytecode.object, args: [] });
    const tokenAddress = (await publicClient.waitForTransactionReceipt({ hash: usdcDeployHash })).contractAddress!;
    console.log("MockUSDC deployed:", tokenAddress);

    const AMOUNT = 2_500_000_000n; // 2500 USDC at 6 decimals
    const mintHash = await walletFor(deployer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "mint", args: [payer.address, AMOUNT] });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const latestBlock = await publicClient.getBlock();
    const now = latestBlock.timestamp;
    const DEADLINE = now + 3600n;
    const GRACE = 3600n;
    const CHALLENGE_WINDOW = 60n;
    const FEE_BPS = 150;
    const QUESTION_HASH = keccak256(toHex("Did acme/widget publish a release?"));
    const DOMAIN_NAME = "IdentityMD Oracle"; // real value, confirmed — docs/DAY-ONE-FINDINGS.md §25
    const DOMAIN_VERSION = "1";

    // --- This is the part that mirrors handleDeploy() exactly: same account approves and deploys ---
    const payerNonce = await publicClient.getTransactionCount({ address: payer.address });
    const predictedEscrow = getContractAddress({ from: payer.address, nonce: BigInt(payerNonce + 1) });
    console.log("payer nonce before approve:", payerNonce, "predicted escrow:", predictedEscrow);

    const approveHash = await walletFor(payer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "approve", args: [predictedEscrow, AMOUNT] });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log("approve status:", approveReceipt.status);

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

    const deployHash = await walletFor(payer).deployContract({
      abi,
      bytecode,
      args: [payer.address, payee.address, tokenAddress, AMOUNT, DEADLINE, GRACE, QUESTION_HASH, oracle.address, feeRecipient.address, FEE_BPS, CHALLENGE_WINDOW, DOMAIN_NAME, DOMAIN_VERSION, payerAuthorization],
    });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const escrowAddress = deployReceipt.contractAddress!;
    console.log("deploy status:", deployReceipt.status, "escrow:", escrowAddress);

    console.log("PREDICTED MATCH:", escrowAddress.toLowerCase() === predictedEscrow.toLowerCase());

    const [onChainPayer, onChainAmount, onChainQuestionHash] = await Promise.all([
      publicClient.readContract({ address: escrowAddress, abi, functionName: "payer" }),
      publicClient.readContract({ address: escrowAddress, abi, functionName: "amount" }),
      publicClient.readContract({ address: escrowAddress, abi, functionName: "questionHash" }),
    ]);
    console.log("ON-CHAIN PAYER MATCH:", (onChainPayer as string).toLowerCase() === payer.address.toLowerCase());
    console.log("ON-CHAIN AMOUNT MATCH:", onChainAmount === AMOUNT);
    console.log("ON-CHAIN QUESTIONHASH MATCH:", onChainQuestionHash === QUESTION_HASH);

    const tokenBalance = await publicClient.readContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "balanceOf", args: [escrowAddress] });
    console.log("ESCROW HOLDS FULL AMOUNT:", tokenBalance === AMOUNT);
  } finally {
    anvil.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
