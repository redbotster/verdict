import { randomUUID } from "node:crypto";
import type { Account, Chain, PublicClient, Transport, WalletClient } from "viem";
import { ImdClient, generateClientToken } from "../../imd-client/src/client.ts";
import type { OracleRequestInput } from "../../oracle-compiler/src/types.ts";
import { withConsumer } from "../../oracle-compiler/src/templates/common.ts";
import { NOT_IMPLEMENTED_APPROVAL_GATE, needsApproval, type ApprovalGate } from "./approval.ts";
import { NOT_IMPLEMENTED_PAYMENT_SIGNER, type PaymentSigner } from "./paymentSigner.ts";
import { fetchOracleAttestation } from "./oracleResult.ts";
import { release, submitAttestation } from "./relay.ts";
import type { EscrowRef, SignedAttestation } from "./types.ts";

export type GetAttestationFn = (input: OracleRequestInput, imdToken: string) => Promise<SignedAttestation>;

// The real end-to-end IMD flow: quote -> challenge -> sign -> pay -> poll payment -> poll oracle ->
// fetch. Every step through "poll payment" is confirmed live, including real payment signing (see
// docs/DAY-ONE-FINDINGS.md §13-14). The last step is a genuinely separate wait from payment
// admission: panel assessment takes real wall-clock time (a real run took ~2 minutes even for a
// trivial question) and can end in "disagreed" with no attestation ever signed — see
// oracleResult.ts and §15 for that failure mode, which this function surfaces as
// OracleDisagreedError rather than hanging or misreporting it as a parse failure.
export function defaultGetAttestation(paymentSigner: PaymentSigner, oracleWait?: { intervalMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch }): GetAttestationFn {
  return async (input, imdToken) => {
    const client = new ImdClient(imdToken);
    const { order } = await client.quote("oracle.request", input, randomUUID());
    const challenge = await client.getChallenge(order.id);
    const { paymentSignatureB64, quoteSignature } = await paymentSigner(challenge);
    await client.pay(order.id, paymentSignatureB64, quoteSignature);
    const status = await client.pollUntilAdmitted(order.id);
    if (status.status !== "admitted") throw new Error(`oracle.request did not reach admitted (got ${status.status})`);
    const admissionResult = (status.admission as Record<string, unknown> | null)?.["result"] as Record<string, unknown> | undefined;
    if (!admissionResult) throw new Error(`admitted status has no admission.result to find the oracle request at: ${JSON.stringify(status.admission)}`);
    return fetchOracleAttestation(admissionResult, oracleWait);
  };
}

export interface ResolveDealParams {
  escrow: EscrowRef;
  /** The question compiled and dual-approved before deployment — see oracle-compiler's compileDeal(). */
  oracleInput: OracleRequestInput;
  /** Sanity check: the escrow's immutable questionHash, from compile time. A mismatch aborts before relaying. */
  expectedQuestionHash: `0x${string}`;
  /** Drives the approval-threshold check; the caller computes this from the escrow's amount/feeBps. */
  payoutEstimateBaseUnits: bigint;
}

export interface ResolveDealOptions {
  imdToken?: string;
  paymentSigner?: PaymentSigner;
  approvalGate?: ApprovalGate;
  approvalThresholdBaseUnits?: bigint;
  /** Injectable for tests; production defaults to defaultGetAttestation. */
  getAttestation?: GetAttestationFn;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
}

export type ResolveResult =
  | { relayed: true; txHash: `0x${string}`; settled: boolean; settleTxHash?: `0x${string}`; attestation: SignedAttestation }
  | { relayed: false; reason: "approval_denied"; attestation: SignedAttestation }
  | { relayed: false; reason: "question_hash_mismatch"; attestation: SignedAttestation };

// Meant to be invoked by a scheduler at the deal's deadline (a 1Claw Automation in production, per
// the spec's 1Claw integration table — no automation is wired up here, this is just the function it
// would call). The escrow itself fixes payer/payee/deadline at deployment and only ever pays out to
// one of those two addresses, so a bug or a compromise here can waste gas or delay settlement, but
// cannot redirect funds — and since submitAttestation is permissionless, anyone else can always relay
// the same public attestation if this resolver is down.
export async function resolveDeal(params: ResolveDealParams, options: ResolveDealOptions): Promise<ResolveResult> {
  const imdToken = options.imdToken ?? generateClientToken();
  const finalInput = withConsumer(params.oracleInput, params.escrow.chainId, params.escrow.address);

  const getAttestation = options.getAttestation ?? defaultGetAttestation(options.paymentSigner ?? NOT_IMPLEMENTED_PAYMENT_SIGNER);
  const attestation = await getAttestation(finalInput, imdToken);

  if (attestation.message.questionHash.toLowerCase() !== params.expectedQuestionHash.toLowerCase()) {
    return { relayed: false, reason: "question_hash_mismatch", attestation };
  }

  if (attestation.message.answer) {
    const threshold = options.approvalThresholdBaseUnits ?? 0n;
    if (needsApproval(params.payoutEstimateBaseUnits, threshold)) {
      const gate = options.approvalGate ?? NOT_IMPLEMENTED_APPROVAL_GATE;
      const decision = await gate({
        dealSummary: finalInput.question,
        payoutBaseUnits: params.payoutEstimateBaseUnits,
        recipient: params.escrow.address,
      });
      if (decision !== "approved") return { relayed: false, reason: "approval_denied", attestation };
    }
  }

  const txHash = await submitAttestation(options.walletClient, params.escrow.address, attestation);
  await options.publicClient.waitForTransactionReceipt({ hash: txHash });

  let settled = false;
  let settleTxHash: `0x${string}` | undefined;
  if (attestation.message.answer) {
    // Best-effort: release() is permissionless, so a failure here (most likely: the challenge window
    // hasn't elapsed yet) just means settlement waits for someone else, or a later run, to call it.
    try {
      settleTxHash = await release(options.walletClient, params.escrow.address);
      await options.publicClient.waitForTransactionReceipt({ hash: settleTxHash });
      settled = true;
    } catch {
      settled = false;
    }
  }

  return { relayed: true, txHash, settled, settleTxHash, attestation };
}
