import { encodeFunctionData } from "viem";
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

// The other half of retiring EVM_PRIVATE_KEY: oneclaw-client's typedDataSigner.ts (§20) covers IMD's
// payment signature, but submitAttestation()/release() are on-chain transaction WRITES, not
// signatures — a different 1Claw endpoint (POST /v1/agents/:id/transactions, docs.1claw.co, read
// 2026-09-29). The vault decrypts the key inside the HSM boundary, builds, signs, and broadcasts via
// 1Claw's own dedicated RPC for the target chain — this process's environment never holds a raw key
// either way. See docs/DAY-ONE-FINDINGS.md §22 for the live proof (sign-only mode, no gas spent).
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
    return result.tx_hash;
  }

  return {
    submitAttestation: (escrowAddress, attestation: SignedAttestation) =>
      submit(escrowAddress, "submitAttestation", [toAbiMessage(attestation.message), attestation.signature]),
    release: (escrowAddress) => submit(escrowAddress, "release", []),
  };
}
