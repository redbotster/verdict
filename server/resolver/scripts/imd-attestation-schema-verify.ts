// Closes the §19 evidence gap for real, and checks something more important that was never
// confirmed at all: docs/SPEC.md (an early planning doc, never verified against reality) describes
// IMD's real oracle attestation response as EIP-712 typed data with primaryType "OracleAttestation" —
// but MilestoneEscrow.sol's own on-chain ATTESTATION_TYPEHASH uses the struct name "Attestation", not
// "OracleAttestation". EIP-712's typeHash is keccak256 of the struct's full type string INCLUDING its
// name, so if IMD really signs with a different primaryType, no real attestation could ever verify
// on-chain — a potential blocker deeper than anything §19 flagged, and it's never been checked because
// the successful response shape has never been captured (oracleResult.ts's own comments say so).
//
// This script: runs one more real paid oracle.request (page_or_file_live, single unambiguous source —
// the §15 disagreement-avoidance trick that worked in §19), sets a REAL, deliberate consumer
// (chainId + verifyingContract) instead of a placeholder so the response's domain binding, if any, is
// to a known value, writes the ENTIRE raw resolved response to a file immediately (§19's own capture
// failure was an output-truncation issue, not a shape problem), and then independently checks
// signature validity three ways: (1) using this project's own assumed domain/types
// (attestationDomain + ATTESTATION_TYPES, i.e. what MilestoneEscrow.sol actually verifies against),
// (2) using the response's own domain/types/primaryType fields directly, if IMD's response actually
// includes them, and (3) reports the raw signer field for direct comparison either way.
import { writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { compileDeal } from "../../oracle-compiler/src/compile.ts";
import { withConsumer } from "../../oracle-compiler/src/templates/common.ts";
import type { Extraction } from "../../oracle-compiler/src/types.ts";
import { ImdClient, generateClientToken } from "../../imd-client/src/client.ts";
import { imdPaymentSigner } from "../src/paymentSigner.ts";
import { pollOracleUntilResolved, parseSignedAttestation, OracleDisagreedError } from "../src/oracleResult.ts";
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

  const attestation = parseSignedAttestation(status);
  log("8. Parsed via this project's assumed shape", attestation);

  console.log("\n=== 9. Signature verification ===");
  console.log("IMD's own reported signer field:", status.signer);

  // Check 1: does the signature verify against THIS PROJECT'S assumed domain/types — i.e. what
  // MilestoneEscrow.sol itself would actually check on-chain?
  try {
    const recoveredOurScheme = await recoverTypedDataAddress({
      domain: attestationDomain(TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT, "IMD-Attestation", "1"),
      types: ATTESTATION_TYPES,
      primaryType: "Attestation",
      message: attestation.message,
      signature: attestation.signature,
    });
    console.log("Recovered using OUR assumed domain/types (name=IMD-Attestation, primaryType=Attestation):", recoveredOurScheme);
    console.log("MATCHES status.signer:", recoveredOurScheme.toLowerCase() === String(status.signer).toLowerCase());
  } catch (err) {
    console.log("Recovery using our assumed scheme FAILED:", err instanceof Error ? err.message : String(err));
  }

  // Check 2: does the raw response actually include its own domain/types/primaryType (per
  // docs/SPEC.md's description)? If so, recover using THOSE exact values instead of our assumption.
  const rawAny = status as unknown as Record<string, unknown>;
  if (rawAny.domain && rawAny.types && rawAny.primaryType) {
    console.log("\nResponse DOES include its own domain/types/primaryType — using those directly:");
    console.log(JSON.stringify({ domain: rawAny.domain, primaryType: rawAny.primaryType }, null, 2));
    try {
      const recoveredRealScheme = await recoverTypedDataAddress({
        domain: rawAny.domain,
        types: rawAny.types,
        primaryType: rawAny.primaryType,
        message: rawAny.message ?? status.attestation,
        signature: attestation.signature,
      } as Parameters<typeof recoverTypedDataAddress>[0]);
      console.log("Recovered using IMD's OWN reported domain/types/primaryType:", recoveredRealScheme);
      console.log("MATCHES status.signer:", recoveredRealScheme.toLowerCase() === String(status.signer).toLowerCase());
    } catch (err) {
      console.log("Recovery using IMD's own reported scheme FAILED:", err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log("\nResponse does NOT include its own domain/types/primaryType fields at the top level — see the raw dump above for the actual keys present.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
