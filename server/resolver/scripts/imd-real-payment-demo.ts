// The capstone of the whole project's biggest blocker: a REAL, PAID IMD oracle.request, using the
// payment-signing schema reverse-engineered from IMD's own shipped frontend
// (docs/DAY-ONE-FINDINGS.md §13) and IMPLEMENTED for real in imd-client's paymentSigning.ts and this
// package's paymentSigner.ts. Run once, with explicit user go-ahead, 2026-09-29 — admitted on the
// first attempt, no corrections needed. See docs/DAY-ONE-FINDINGS.md §14 for the full transaction
// record and the real oracle-request response shape this captured.
//
// This spends real $IMD (0.5 per run) from whatever wallet's private key you provide. Requires:
//   1. That wallet holds at least 0.5 $IMD on Ethereum mainnet.
//   2. Permit2 already approved for at least that amount — see approve() in
//      server/imd-client/src/paymentSigning.ts's PERMIT2_ADDRESS; a plain ERC20
//      `approve(PERMIT2_ADDRESS, amount)` from the wallet, mined, before running this.
//
//   VERDICT_PRIVATE_KEY=$(grep -oP '(?<=^EVM_PRIVATE_KEY=).*' ~/.secrets/verdict.env) npm run imd-real-payment-demo

import { privateKeyToAccount } from "viem/accounts";
import { compileDeal } from "../../oracle-compiler/src/compile.ts";
import type { Extraction } from "../../oracle-compiler/src/types.ts";
import { ImdClient, generateClientToken } from "../../imd-client/src/client.ts";
import { imdPaymentSigner } from "../src/paymentSigner.ts";

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(detail);
}

async function main() {
  const privateKey = process.env.VERDICT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("set VERDICT_PRIVATE_KEY");
  const account = privateKeyToAccount(privateKey);
  console.log("payer wallet:", account.address);

  // Step 1: compile a real, free question against the live IMD API.
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
  log("1. compileDeal() — real IMD quote (free)", { questionHash: compileResult.questionHash });

  // Step 2: create the real order (free — quote creation doesn't charge).
  const client = new ImdClient(generateClientToken());
  const { order } = await client.quote("oracle.request", compileResult.input, crypto.randomUUID());
  log("2. quote() — real order created (free)", { orderId: order.id });

  // Step 3: get the real 402 challenge (free — no charge until a signature is submitted).
  const challenge = await client.getChallenge(order.id);
  log("3. getChallenge() — real 402 challenge (free)", { accepts: challenge.accepts });

  // Step 4: build and sign both real signatures (free — signing itself costs nothing).
  const signer = imdPaymentSigner(account);
  const { paymentSignatureB64, quoteSignature } = await signer(challenge);
  log("4. Signed both real payloads (free)", { quoteSignature });

  // Step 5: THE REAL PAID CALL. This spends real $IMD.
  console.log("\n5. Submitting the real paid call — this spends real $IMD...");
  const result = await client.pay(order.id, paymentSignatureB64, quoteSignature);
  log("   result", result);

  if (result.status !== "admitted") {
    console.log("\n6. Polling until admitted...");
    const final = await client.pollUntilAdmitted(order.id, { timeoutMs: 120_000 });
    log("   final status", final);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
