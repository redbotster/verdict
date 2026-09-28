import type { Account, Chain, Hash, PublicClient, Transport, WalletClient } from "viem";
import { loadMilestoneEscrowArtifact } from "./artifact.ts";
import type { AttestationMessage, SignedAttestation } from "./types.ts";

type Signer = WalletClient<Transport, Chain, Account>;

function toAbiMessage(m: AttestationMessage) {
  // Field order here doesn't need to match the struct — viem encodes tuples by ABI position from
  // the artifact, using each key by name — but the set of keys must match exactly.
  return {
    requestId: m.requestId,
    chainId: m.chainId,
    questionHash: m.questionHash,
    answerType: m.answerType,
    answer: m.answer,
    figure: m.figure,
    fromBlock: m.fromBlock,
    toBlock: m.toBlock,
    panelJobId: m.panelJobId,
    issuedAt: m.issuedAt,
    expiresAt: m.expiresAt,
  };
}

// Permissionless by design (see MilestoneEscrow.sol) — any funded wallet can call these, not just
// the payer/payee/oracle. The resolver's wallet is just the one actually paying gas to do so.
export async function submitAttestation(walletClient: Signer, escrowAddress: `0x${string}`, attestation: SignedAttestation): Promise<Hash> {
  const { abi } = loadMilestoneEscrowArtifact();
  return walletClient.writeContract({
    address: escrowAddress,
    abi,
    functionName: "submitAttestation",
    args: [toAbiMessage(attestation.message), attestation.signature],
    chain: walletClient.chain,
    account: walletClient.account,
  });
}

export async function release(walletClient: Signer, escrowAddress: `0x${string}`): Promise<Hash> {
  const { abi } = loadMilestoneEscrowArtifact();
  return walletClient.writeContract({ address: escrowAddress, abi, functionName: "release", args: [], chain: walletClient.chain, account: walletClient.account });
}

export async function reclaim(walletClient: Signer, escrowAddress: `0x${string}`): Promise<Hash> {
  const { abi } = loadMilestoneEscrowArtifact();
  return walletClient.writeContract({ address: escrowAddress, abi, functionName: "reclaim", args: [], chain: walletClient.chain, account: walletClient.account });
}

export async function withdraw(walletClient: Signer, escrowAddress: `0x${string}`, to: `0x${string}`): Promise<Hash> {
  const { abi } = loadMilestoneEscrowArtifact();
  return walletClient.writeContract({ address: escrowAddress, abi, functionName: "withdraw", args: [to], chain: walletClient.chain, account: walletClient.account });
}

export interface EscrowSnapshot {
  state: 0 | 1 | 2; // Funded, Released, Refunded
  trueAt: bigint;
  owed: bigint;
}

export async function readEscrowState(publicClient: PublicClient, escrowAddress: `0x${string}`, account: `0x${string}`): Promise<EscrowSnapshot> {
  const { abi } = loadMilestoneEscrowArtifact();
  const [state, trueAt, owed] = await Promise.all([
    publicClient.readContract({ address: escrowAddress, abi, functionName: "state" }) as Promise<0 | 1 | 2>,
    publicClient.readContract({ address: escrowAddress, abi, functionName: "trueAt" }) as Promise<bigint>,
    publicClient.readContract({ address: escrowAddress, abi, functionName: "owed", args: [account] }) as Promise<bigint>,
  ]);
  return { state, trueAt, owed };
}
