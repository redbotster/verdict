import { encodeFunctionData, type PublicClient } from "viem";
import { sendRawTransaction } from "viem/actions";
import type { OneClawClient } from "../../oneclaw-client/src/client.ts";
import { loadMilestoneEscrowArtifact } from "./artifact.ts";
import { toAbiMessage, type TransactionRelay } from "./relay.ts";
import type { SignedAttestation } from "./types.ts";

export interface OneClawTransactionRelayOptions {
  client: OneClawClient;
  agentId: string;
  /** 1Claw's own chain-name string (e.g. "ethereum", "base") — see oneclaw-client's oneClawChainName. */
  chain: string;
}

export class OneClawBroadcastFailedError extends Error {
  status: string;
  constructor(status: string) {
    super(
      `1Claw signed the transaction but its own broadcast failed (status: "${status}"). Confirmed live ` +
        `2026-09-29: 1Claw's POST /v1/agents/:id/transactions can return a 200 with a tx_hash even when ` +
        `it never actually broadcasts (real error: "Broadcast failed: Request timeout on the free plan, ` +
        `please upgrade to paid plan" on an org subscribed to the "team" tier) — the tx_hash alone is not ` +
        `proof of delivery. See docs/DAY-ONE-FINDINGS.md §22.`,
    );
    this.name = "OneClawBroadcastFailedError";
    this.status = status;
  }
}

// The other half of retiring EVM_PRIVATE_KEY: oneclaw-client's typedDataSigner.ts (§20) covers IMD's
// payment signature, but submitAttestation()/release() are on-chain transaction WRITES, not
// signatures — a different 1Claw endpoint (POST /v1/agents/:id/transactions, docs.1claw.co, read
// 2026-09-29). The vault decrypts the key inside the HSM boundary, builds, signs, and (when it
// actually works) broadcasts via 1Claw's own dedicated RPC for the target chain — this process's
// environment never holds a raw key either way. Signing itself is proven live at zero cost; a real
// broadcast attempt failed on 1Claw's own infrastructure — see docs/DAY-ONE-FINDINGS.md §22 for both.
export function oneClawTransactionRelay(opts: OneClawTransactionRelayOptions): TransactionRelay {
  const { abi } = loadMilestoneEscrowArtifact();

  async function submit(escrowAddress: `0x${string}`, functionName: string, args: unknown[]): Promise<`0x${string}`> {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await opts.client.submitTransaction(opts.agentId, {
      chain: opts.chain,
      to: escrowAddress,
      value: "0",
      data,
    });
    // A 200 response with a tx_hash is NOT proof of delivery — confirmed live, see
    // OneClawBroadcastFailedError's own message for the exact real failure this guards against.
    if (result.status !== "broadcast") throw new OneClawBroadcastFailedError(result.status);
    return result.tx_hash;
  }

  return {
    submitAttestation: (escrowAddress, attestation: SignedAttestation) =>
      submit(escrowAddress, "submitAttestation", [toAbiMessage(attestation.message), attestation.signature]),
    release: (escrowAddress) => submit(escrowAddress, "release", []),
  };
}

export interface OneClawSignAndBroadcastRelayOptions extends OneClawTransactionRelayOptions {
  /**
   * Broadcasts the 1Claw-signed raw transaction over a normal RPC instead of 1Claw's own (currently
   * broken, see OneClawBroadcastFailedError) broadcaster. Any viem PublicClient pointed at the right
   * chain works — resolveDeal() already has one for waitForTransactionReceipt, so callers typically
   * reuse that same instance rather than constructing a second one.
   */
  publicClient: PublicClient;
}

// The actual working path today: sign via 1Claw's BYORPC endpoint (POST .../transactions/sign, the
// same zero-cost call oneclaw-transaction-live-test.ts proves works) so the raw key never touches
// this process, then broadcast the resulting raw signed tx ourselves via a plain RPC — bypassing
// 1Claw's own broadcast infrastructure entirely, since that's the half that's currently broken (see
// OneClawBroadcastFailedError and docs/DAY-ONE-FINDINGS.md §22's addendum). Once 1Claw's own
// broadcaster is fixed, oneClawTransactionRelay above becomes the simpler option again (one network
// hop instead of two); this one is what actually delivers a transaction in the meantime.
export function oneClawSignAndBroadcastRelay(opts: OneClawSignAndBroadcastRelayOptions): TransactionRelay {
  const { abi } = loadMilestoneEscrowArtifact();

  async function submit(escrowAddress: `0x${string}`, functionName: string, args: unknown[]): Promise<`0x${string}`> {
    const data = encodeFunctionData({ abi, functionName, args });
    const signed = await opts.client.signTransaction(opts.agentId, {
      chain: opts.chain,
      to: escrowAddress,
      value: "0",
      data,
    });
    return sendRawTransaction(opts.publicClient, { serializedTransaction: signed.signed_tx });
  }

  return {
    submitAttestation: (escrowAddress, attestation: SignedAttestation) =>
      submit(escrowAddress, "submitAttestation", [toAbiMessage(attestation.message), attestation.signature]),
    release: (escrowAddress) => submit(escrowAddress, "release", []),
  };
}
