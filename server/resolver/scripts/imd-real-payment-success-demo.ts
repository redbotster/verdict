// Second real paid oracle.request, per explicit user go-ahead 2026-09-29 (after topping up $IMD via
// a real Uniswap v4 swap — see docs/DAY-ONE-FINDINGS.md §19). The first real request (§14/§15) used
// release_published and disagreed: panelists cited either GitHub's API or web URL for the same
// underlying fact, and IMD's clustering treats those as different sources. This attempt uses
// page_or_file_live instead — a single, unambiguous URL to check (https://github.com), so every
// panelist has exactly one thing to fetch and cite, removing the citation-divergence failure mode
// from §15 by construction. Also the first real exercise of pollOracleUntilResolved (§16/§17's fix)
// against a genuinely live request.
import { privateKeyToAccount } from "viem/accounts";
import { compileDeal } from "../../oracle-compiler/src/compile.ts";
import type { Extraction } from "../../oracle-compiler/src/types.ts";
import { ImdClient, generateClientToken } from "../../imd-client/src/client.ts";
import { imdPaymentSigner } from "../src/paymentSigner.ts";
import { fetchOracleAttestation, OracleDisagreedError } from "../src/oracleResult.ts";

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function main() {
  const privateKey = process.env.VERDICT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("set VERDICT_PRIVATE_KEY");
  const account = privateKeyToAccount(privateKey);
  console.log("payer wallet:", account.address);

  const deadlineIso = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour out
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
  log("1. compileDeal() — real IMD quote (free)", { questionHash: compileResult.questionHash, question: compileResult.input.question });

  const client = new ImdClient(generateClientToken());
  const { order } = await client.quote("oracle.request", compileResult.input, crypto.randomUUID());
  log("2. quote() — real order created (free)", { orderId: order.id });

  const challenge = await client.getChallenge(order.id);
  log("3. getChallenge() — real 402 challenge (free)", { accepts: challenge.accepts });

  const signer = imdPaymentSigner(account);
  const { paymentSignatureB64, quoteSignature } = await signer(challenge);
  log("4. Signed both real payloads (free)");

  console.log("\n5. Submitting the real paid call — this spends real $IMD...");
  const payResult = await client.pay(order.id, paymentSignatureB64, quoteSignature);
  log("   result", payResult);

  const admitted = payResult.status === "admitted" ? payResult : await client.pollUntilAdmitted(order.id, { timeoutMs: 120_000 });
  log("6. admitted", { status: admitted.status });
  const admissionResult = (admitted.admission as Record<string, unknown> | null)?.["result"] as Record<string, unknown> | undefined;
  if (!admissionResult) throw new Error(`admitted status has no admission.result: ${JSON.stringify(admitted.admission)}`);

  console.log("\n7. Polling the oracle panel until resolved (real wall-clock wait)...");
  try {
    const attestation = await fetchOracleAttestation(admissionResult, { intervalMs: 5000, timeoutMs: 10 * 60_000 });
    log("SUCCESS — real signed attestation", attestation);
  } catch (err) {
    if (err instanceof OracleDisagreedError) {
      log("DISAGREED again", { message: err.message, status: err.status });
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
