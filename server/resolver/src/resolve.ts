import { randomUUID } from "node:crypto";
import type { Account, Chain, PublicClient, Transport, WalletClient } from "viem";
import { ImdClient, generateClientToken } from "../../imd-client/src/client.ts";
import type { OracleRequestInput } from "../../oracle-compiler/src/types.ts";
import { withConsumer } from "../../oracle-compiler/src/templates/common.ts";
import { NOT_IMPLEMENTED_APPROVAL_GATE, needsApproval, type ApprovalGate } from "./approval.ts";
import { NOT_IMPLEMENTED_PAYMENT_SIGNER, type PaymentSigner } from "./paymentSigner.ts";
import { fetchOracleAttestation } from "./oracleResult.ts";
import { viemTransactionRelay, type TransactionRelay } from "./relay.ts";
import { loadMilestoneEscrowArtifact } from "./artifact.ts";
import type { EscrowRef, SignedAttestation } from "./types.ts";

// A true answer already on-chain (trueAt != 0, contract's own permanent record) is proof a previous
// run already paid IMD for this exact deal — re-requesting would spend real $IMD again for an answer
// we already have, and could even get a *different* real answer on a retry (a real panel disagreement
// has happened before, see docs/DAY-ONE-FINDINGS.md §15). state != Funded means fully done (Released
// via release(), or Refunded — set immediately inside submitAttestation() on a false answer, per
// MilestoneEscrow.sol). Checking this first, before ever calling getAttestation(), is what makes a
// retried webhook call (an Automation retry, a crash, a duplicate trigger) safe rather than costly.
async function readOnChainAttestationState(publicClient: PublicClient, escrowAddress: `0x${string}`): Promise<{ state: 0 | 1 | 2; trueAt: bigint }> {
  const { abi } = loadMilestoneEscrowArtifact();
  const [state, trueAt] = await Promise.all([
    publicClient.readContract({ address: escrowAddress, abi, functionName: "state" }) as Promise<0 | 1 | 2>,
    publicClient.readContract({ address: escrowAddress, abi, functionName: "trueAt" }) as Promise<bigint>,
  ]);
  return { state, trueAt };
}

export class TransactionRelayNotConfiguredError extends Error {
  constructor() {
    super("resolveDeal() needs either options.walletClient (a local viem account) or options.relay (e.g. oneClawRelay.ts's oneClawTransactionRelay) to submit on-chain writes");
    this.name = "TransactionRelayNotConfiguredError";
  }
}

const NOT_IMPLEMENTED_RELAY: TransactionRelay = {
  submitAttestation: async () => {
    throw new TransactionRelayNotConfiguredError();
  },
  release: async () => {
    throw new TransactionRelayNotConfiguredError();
  },
};

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
  /** A local viem account — the default path. Ignored if `relay` is also given. */
  walletClient?: WalletClient<Transport, Chain, Account>;
  /**
   * An alternative to `walletClient` for submitting the two on-chain writes below — e.g.
   * oneClawRelay.ts's oneClawTransactionRelay, so the signing key never has to live in this
   * process's environment at all. Takes precedence over `walletClient` if both are given.
   */
  relay?: TransactionRelay;
}

/** Why release() wasn't (successfully) called, when settled is false. "approval_required" covers both an explicit denial and no ApprovalGate being wired at all — either way, a human needs to act (wire a gate, or call release() manually); the attestation is already safely recorded on-chain either way. "release_failed" is the pre-existing best-effort case (most commonly: the challenge window hasn't elapsed yet). */
export type SettleBlockedReason = "approval_required" | "release_failed";

export type ResolveResult =
  | { relayed: true; txHash: `0x${string}`; settled: boolean; settleTxHash?: `0x${string}`; settleBlockedReason?: SettleBlockedReason; attestation: SignedAttestation }
  | { relayed: false; reason: "question_hash_mismatch"; attestation: SignedAttestation }
  /** state was already Released or Refunded on-chain — a prior run (or someone else) already finished this deal. Never touched IMD. */
  | { relayed: false; reason: "already_resolved" }
  /** trueAt was already set on-chain from a prior run — skipped re-buying an attestation, and attempted release() (subject to the same approval gate as a first-time settlement). */
  | { relayed: false; reason: "already_attested_awaiting_release"; settled: boolean; settleTxHash?: `0x${string}`; settleBlockedReason?: SettleBlockedReason };

interface ReleaseAttemptResult {
  settled: boolean;
  settleTxHash?: `0x${string}`;
  settleBlockedReason?: SettleBlockedReason;
}

// Gates only the fund-moving release() call — never submitAttestation(), which just records IMD's
// answer on-chain (permanent, but moves no money, and starts the challenge window either way). An
// above-threshold payout that has no ApprovalGate wired (or gets denied) is a legitimate, expected,
// non-exceptional outcome now: the attestation is already safely on-chain, so this returns
// settled: false with a reason rather than throwing and turning the whole resolution into a crash.
// A human can wire a real gate later, or call release() manually — see docs/DAY-ONE-FINDINGS.md.
async function attemptRelease(params: ResolveDealParams, options: ResolveDealOptions, relay: TransactionRelay): Promise<ReleaseAttemptResult> {
  const threshold = options.approvalThresholdBaseUnits ?? 0n;
  if (needsApproval(params.payoutEstimateBaseUnits, threshold)) {
    const gate = options.approvalGate ?? NOT_IMPLEMENTED_APPROVAL_GATE;
    let decision: Awaited<ReturnType<ApprovalGate>>;
    try {
      decision = await gate({
        dealSummary: params.oracleInput.question,
        payoutBaseUnits: params.payoutEstimateBaseUnits,
        recipient: params.escrow.address,
      });
    } catch {
      return { settled: false, settleBlockedReason: "approval_required" };
    }
    if (decision !== "approved") return { settled: false, settleBlockedReason: "approval_required" };
  }
  // Best-effort: release() is permissionless, so a failure here (most commonly: the challenge
  // window hasn't elapsed yet) just means settlement waits for someone else, or a later run.
  try {
    const settleTxHash = await relay.release(params.escrow.address);
    await options.publicClient.waitForTransactionReceipt({ hash: settleTxHash });
    return { settled: true, settleTxHash };
  } catch {
    return { settled: false, settleBlockedReason: "release_failed" };
  }
}

// Meant to be invoked by a scheduler at the deal's deadline (a 1Claw Automation in production, per
// the spec's 1Claw integration table — no automation is wired up here, this is just the function it
// would call). The escrow itself fixes payer/payee/deadline at deployment and only ever pays out to
// one of those two addresses, so a bug or a compromise here can waste gas or delay settlement, but
// cannot redirect funds — and since submitAttestation is permissionless, anyone else can always relay
// the same public attestation if this resolver is down.
export async function resolveDeal(params: ResolveDealParams, options: ResolveDealOptions): Promise<ResolveResult> {
  const relay = options.relay ?? (options.walletClient ? viemTransactionRelay(options.walletClient) : NOT_IMPLEMENTED_RELAY);

  const onChain = await readOnChainAttestationState(options.publicClient, params.escrow.address);
  if (onChain.state !== 0) return { relayed: false, reason: "already_resolved" };
  if (onChain.trueAt !== 0n) {
    const release = await attemptRelease(params, options, relay);
    return { relayed: false, reason: "already_attested_awaiting_release", ...release };
  }

  const imdToken = options.imdToken ?? generateClientToken();
  const finalInput = withConsumer(params.oracleInput, params.escrow.chainId, params.escrow.address);
  const getAttestation = options.getAttestation ?? defaultGetAttestation(options.paymentSigner ?? NOT_IMPLEMENTED_PAYMENT_SIGNER);
  const attestation = await getAttestation(finalInput, imdToken);

  if (attestation.message.questionHash.toLowerCase() !== params.expectedQuestionHash.toLowerCase()) {
    return { relayed: false, reason: "question_hash_mismatch", attestation };
  }

  const txHash = await relay.submitAttestation(params.escrow.address, attestation);
  await options.publicClient.waitForTransactionReceipt({ hash: txHash });

  const release = attestation.message.answer ? await attemptRelease(params, options, relay) : { settled: false };

  return { relayed: true, txHash, ...release, attestation };
}
