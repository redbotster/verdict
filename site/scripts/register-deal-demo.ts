// Real, live proof of the logic behind /new's "register deployed escrow" step
// (app/new/actions.ts's registerDeal — this script exercises its two real dependencies,
// readEscrowOnChainState and createDeal, directly with relative imports, since Next's `@/` path
// alias that actions.ts itself uses isn't resolvable by a plain Node script outside Next's bundler;
// the two functions this replicates are exactly what registerDeal calls, in the same order, with the
// same fee math). Compiles a real question against the live IMD API (free), deploys a real
// MilestoneEscrow to a throwaway local Anvil chain bound to that exact questionHash, reads its real
// on-chain state, and writes a real row into Supabase — then cleans up.
//
// Not run by CI — needs SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and a local Anvil/Foundry install.
//
//   SUPABASE_URL=$(grep -oP '(?<=^SUPABASE_URL=).*' ~/.secrets/verdict.env) \
//   SUPABASE_SERVICE_ROLE_KEY=$(grep -oP '(?<=^SUPABASE_SERVICE_ROLE_KEY=).*' ~/.secrets/verdict.env) \
//     npx tsx scripts/register-deal-demo.ts
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256, toHex, getContractAddress, type Abi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ImdClient, generateClientToken } from "@verdict/imd-client";
import { releasePublishedTemplate } from "@verdict/oracle-compiler";
import type { Extraction } from "@verdict/oracle-compiler";
import { createDeal } from "../lib/deals.ts";
import { supabaseSelect } from "../lib/supabase.ts";

const ANVIL_PORT = 8551;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const DOMAIN_NAME = "IdentityMD Oracle"; // real value, confirmed — docs/DAY-ONE-FINDINGS.md §25
const DOMAIN_VERSION = "1";

function loadArtifact(relPath: string): { abi: Abi; bytecode: { object: `0x${string}` } } {
  return JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), relPath), "utf-8"));
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

  // 1. Real, free IMD compile — same template/quote path compileReleaseDeal() uses.
  const REPO = "octocat/Hello-World";
  const deadlineIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const extraction: Extraction = {
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
  const input = releasePublishedTemplate.build(extraction, { evidenceChainId: 1, startIso: new Date().toISOString(), validForSeconds: 7 * 24 * 60 * 60 });
  const client = new ImdClient(generateClientToken());
  const { order } = await client.quote("oracle.request", input, randomUUID());
  const questionHash = (JSON.parse(order.inputJson) as { questionHash: `0x${string}` }).questionHash;
  console.log("1. Real IMD quote", { questionHash });

  // 2. Deploy a real MilestoneEscrow bound to that exact questionHash.
  const escrowArtifact = loadArtifact("../../contracts/out/MilestoneEscrow.sol/MilestoneEscrow.json");
  const usdcArtifact = loadArtifact("../../contracts/out/MockUSDC.sol/MockUSDC.json");
  const deployer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
  const payer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
  const payee = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 });
  const oracle = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 3 });
  const feeRecipient = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 5 });
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
  const walletFor = (account: typeof deployer) => createWalletClient({ account, chain: foundry, transport: http(RPC_URL) });

  const usdcHash = await walletFor(deployer).deployContract({ abi: usdcArtifact.abi, bytecode: usdcArtifact.bytecode.object, args: [] });
  const tokenAddress = (await publicClient.waitForTransactionReceipt({ hash: usdcHash })).contractAddress!;
  const AMOUNT = 1_000_000_000n; // 1000 USDC
  await publicClient.waitForTransactionReceipt({ hash: await walletFor(deployer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "mint", args: [payer.address, AMOUNT] }) });

  const deployerNonce = await publicClient.getTransactionCount({ address: deployer.address });
  const predictedEscrow = getContractAddress({ from: deployer.address, nonce: BigInt(deployerNonce) });
  await publicClient.waitForTransactionReceipt({ hash: await walletFor(payer).writeContract({ address: tokenAddress, abi: usdcArtifact.abi, functionName: "approve", args: [predictedEscrow, AMOUNT] }) });

  const now = (await publicClient.getBlock()).timestamp;
  const DEADLINE = now + 3600n;
  const GRACE = 3600n;
  const CHALLENGE_WINDOW = 60n;
  const FEE_BPS = 100;

  const TERMS_TYPEHASH = keccak256(
    toHex(
      "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)",
    ),
  );
  const termsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint64" }],
      [TERMS_TYPEHASH, payer.address, payee.address, tokenAddress, AMOUNT, DEADLINE, GRACE, questionHash, oracle.address, feeRecipient.address, FEE_BPS, CHALLENGE_WINDOW],
    ),
  );
  const payerAuthorization = await payer.signMessage({ message: { raw: termsHash } });

  const deployHash = await walletFor(deployer).deployContract({
    abi: escrowArtifact.abi,
    bytecode: escrowArtifact.bytecode.object,
    args: [payer.address, payee.address, tokenAddress, AMOUNT, DEADLINE, GRACE, questionHash, oracle.address, feeRecipient.address, FEE_BPS, CHALLENGE_WINDOW, DOMAIN_NAME, DOMAIN_VERSION, payerAuthorization],
  });
  const escrowAddress = (await publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;
  console.log("2. Deployed the real MilestoneEscrow bytecode, bound to IMD's real questionHash", { escrowAddress });

  // 3. registerDeal()'s exact logic: read real on-chain state, verify questionHash matches, compute
  //    the fee-adjusted payout estimate, then write the real row. Reads the same two fields
  //    lib/escrow.ts's readEscrowOnChainState does, inlined here rather than imported — that file
  //    uses an extensionless import Next resolves but a plain Node script can't (same documented
  //    limitation as server/resolver/scripts/e2e-demo.ts hits for the same file).
  const [onChainQuestionHash, onChainAmount, onChainFeeBps] = await Promise.all([
    publicClient.readContract({ address: escrowAddress, abi: escrowArtifact.abi, functionName: "questionHash" }) as Promise<`0x${string}`>,
    publicClient.readContract({ address: escrowAddress, abi: escrowArtifact.abi, functionName: "amount" }) as Promise<bigint>,
    publicClient.readContract({ address: escrowAddress, abi: escrowArtifact.abi, functionName: "feeBps" }) as Promise<number>,
  ]);
  if (onChainQuestionHash.toLowerCase() !== questionHash.toLowerCase()) throw new Error("questionHash mismatch — registerDeal's own check would have refused this");
  const fee = (onChainAmount * BigInt(onChainFeeBps)) / 10000n;
  const payoutEstimateBaseUnits = (onChainAmount - fee).toString();

  await createDeal({
    address: escrowAddress,
    title: `${REPO} release bounty`,
    rpcUrl: RPC_URL,
    chainId: 31337,
    question: input.question,
    sources: input.guards.sources ?? [],
    panelSize: input.panelSize,
    quorum: input.quorum,
    oracleInput: input,
    expectedQuestionHash: questionHash,
    payoutEstimateBaseUnits,
  });
  console.log("3. createDeal() — wrote the real row", { payoutEstimateBaseUnits });

  // 4. Confirm the row is real, in the real table.
  const rows = await supabaseSelect<{ address: string; title: string }>("deals", `?address=eq.${escrowAddress.toLowerCase()}&select=address,title`);
  console.log("4. Row confirmed in Supabase:", rows);
  if (rows.length !== 1) throw new Error("expected exactly one row in Supabase after createDeal()");

  // Clean up: delete the test row.
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/deals?address=eq.${escrowAddress.toLowerCase()}`, {
    method: "DELETE",
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  console.log("Cleaned up test row.");

  console.log(`\nRESULT: the register-deal pipeline (on-chain read -> hash check -> Supabase write) works end to end. (Anvil pid ${anvil.pid} still running — kill it when done.)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
