// Field order and types must match MilestoneEscrow.sol's ATTESTATION_TYPEHASH exactly — verified
// against contracts/src/MilestoneEscrow.sol directly, not from memory.
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "requestId", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "questionHash", type: "bytes32" },
    { name: "answerType", type: "string" },
    { name: "answer", type: "bool" },
    { name: "figure", type: "string" },
    { name: "fromBlock", type: "uint256" },
    { name: "toBlock", type: "uint256" },
    { name: "panelJobId", type: "string" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export function attestationDomain(chainId: number, verifyingContract: `0x${string}`, name: string, version: string) {
  return { name, version, chainId, verifyingContract } as const;
}
