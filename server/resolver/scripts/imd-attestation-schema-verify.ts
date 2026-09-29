// Closed the §19 evidence gap for real, and found something much bigger: MilestoneEscrow.sol's
// on-chain ATTESTATION_TYPEHASH never matched IMD's real EIP-712 signature at all (wrong domain name,
// wrong struct name, several wrong field types) — see docs/DAY-ONE-FINDINGS.md §25 for the full story.
// The run that discovered this: one more real paid oracle.request (page_or_file_live, single
// unambiguous source — the §15 disagreement-avoidance trick), a real deliberate consumer instead of a
// placeholder, the raw response written to a file immediately (fixing §19's actual capture failure),
// and — critically — reading IMD's own docs properly to find the dedicated
// GET /oracle/requests/:id/attestation endpoint this codebase had never called, which returns the
// real domain/types/primaryType directly.
//
// The contract, eip712.ts, types.ts, relay.ts, and oracleResult.ts are all fixed now (§25). This
// script, re-run after the fix, calls the real dedicated endpoint via getRealAttestation() and
// confirms the corrected domain/types/primaryType actually recovers to IMD's own reported signer —
// the same live confirmation that originally found the bug, now proving the fix.
import { writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { compileDeal } from "../../oracle-compiler/src/compile.ts";
import { withConsumer } from "../../oracle-compiler/src/templates/common.ts";
import type { Extraction } from "../../oracle-compiler/src/types.ts";
import { ImdClient, generateClientToken } from "../../imd-client/src/client.ts";
import { imdPaymentSigner } from "../src/paymentSigner.ts";
import { pollOracleUntilResolved, getRealAttestation, parseSignedAttestation, OracleDisagreedError } from "../src/oracleResult.ts";
import { attestationDomain, ATTESTATION_TYPES } from "../src/eip712.ts";

const OUT_PATH = "/tmp/imd-attestation-schema-verify-output.json";
// Deliberately controlled/known values for this test — not a real deployed escrow, just a fixed
// point to check whether the response's signing domain is actually bound to `consumer` as
// docs/SPEC.md claims (§5 already confirmed consumer has no effect on questionHash; this checks
// whether it affects the *signature* domain, which is a separate question never checked before).
// chainId=1 confirmed accepted by IMD (it's the template's own free-dry-run default — 8453 got a real
// 400 invalid_request on a real quote call, so IMD validates consumer.chainId against a known set;
// not worth guessing further with real money on the line). verifyingContract is deliberately
// different from the template's own PLACEHOLDER_VERIFYING_CONTRACT (0x000...dead) so a domain-binding
// check can actually tell the two apart if it matters.
const TEST_CHAIN_ID = 1;
const TEST_VERIFYING_CONTRACT = "0x1234567890123456789012345678901234567890" as const;

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function main() {
  const privateKey = process.env.VERDICT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("set VERDICT_PRIVATE_KEY");
  const account = privateKeyToAccount(privateKey);
  console.log("payer wallet:", account.address);

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
  const finalInput = withConsumer(compileResult.input, TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT);
  log("1. compileDeal() + real consumer set (free)", { questionHash: compileResult.questionHash, consumer: finalInput.consumer });

  const client = new ImdClient(generateClientToken());
  const { order } = await client.quote("oracle.request", finalInput, crypto.randomUUID());
  log("2. quote() — real order created (free)", { orderId: order.id });

  const challenge = await client.getChallenge(order.id);
  const signer = imdPaymentSigner(account);
  const { paymentSignatureB64, quoteSignature } = await signer(challenge);
  log("3. signed both real payloads (free)");

  console.log("\n4. Submitting the real paid call — this spends real $IMD...");
  const payResult = await client.pay(order.id, paymentSignatureB64, quoteSignature);
  const admitted = payResult.status === "admitted" ? payResult : await client.pollUntilAdmitted(order.id, { timeoutMs: 120_000 });
  log("5. admitted", { status: admitted.status });
  const admissionResult = (admitted.admission as Record<string, unknown> | null)?.["result"] as Record<string, unknown> | undefined;
  if (!admissionResult) throw new Error(`admitted status has no admission.result: ${JSON.stringify(admitted.admission)}`);

  console.log("\n6. Polling the oracle panel until resolved (real wall-clock wait)...");
  let status;
  try {
    status = await pollOracleUntilResolved(admissionResult, { intervalMs: 5000, timeoutMs: 10 * 60_000 });
  } catch (err) {
    if (err instanceof OracleDisagreedError) {
      writeFileSync(OUT_PATH, JSON.stringify({ outcome: "disagreed", status: err.status }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      log("DISAGREED — see " + OUT_PATH, { message: err.message });
      return;
    }
    throw err;
  }

  // Write the COMPLETE raw response immediately — this is the actual fix for §19's capture failure.
  writeFileSync(OUT_PATH, JSON.stringify({ outcome: "resolved", rawStatus: status }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nFull raw response written to ${OUT_PATH}`);

  log("7. RAW resolved status (every field IMD actually returned)", status);

  // The general status endpoint's own `attestation`/`signature`/`signer` fields are NOT the real
  // signing package (no domain/types/primaryType, and `answerType` is a display string, not the
  // numeric value actually signed) — this is exactly what this script's real run discovered. The
  // dedicated endpoint below is the authoritative source; getRealAttestation()/parseSignedAttestation()
  // now encode that fix directly (see docs/DAY-ONE-FINDINGS.md §25).
  const real = await getRealAttestation(admissionResult);
  log("8. REAL signing package, from IMD's dedicated attestation endpoint", real);

  const attestation = parseSignedAttestation(real);
  log("9. Parsed via this project's NOW-CORRECTED shape", attestation);

  console.log("\n=== 10. Signature verification against the now-fixed contract scheme ===");
  console.log("IMD's own reported signer field:", real.signer);
  const recovered = await recoverTypedDataAddress({
    domain: attestationDomain(TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT, "IdentityMD Oracle", "1"),
    types: ATTESTATION_TYPES,
    primaryType: "OracleAttestation",
    message: { ...real.message, chainId: BigInt(real.message.chainId), answerType: 0, figure: BigInt(real.message.figure), fromBlock: BigInt(real.message.fromBlock), toBlock: BigInt(real.message.toBlock), issuedAt: BigInt(real.message.issuedAt), expiresAt: BigInt(real.message.expiresAt) },
    signature: attestation.signature,
  });
  console.log("Recovered using the corrected domain/types (name=IdentityMD Oracle, primaryType=OracleAttestation):", recovered);
  console.log("MATCHES signer:", recovered.toLowerCase() === real.signer.toLowerCase());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
