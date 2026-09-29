// Field order, types, and the struct name (OracleAttestation, not the earlier-assumed "Attestation")
// are all confirmed for real against IMD's own dedicated GET /oracle/requests/:id/attestation
// endpoint, 2026-09-29 — independently verified by recovering a real attestation's signer with this
// exact scheme and matching IMD's own reported signer field. See docs/DAY-ONE-FINDINGS.md §25 for
// the full comparison against the prior (wrong, never-verified) assumption. `answer` is dynamic
// `bytes` in IMD's real scheme (an ABI-encoded bool: 32 bytes, 0 or 1) — this project only ever
// deals with bool answers, so callers should encode a JS boolean into that shape (see
// relay.ts's toAbiMessage) rather than pass a raw boolean here.
export const ATTESTATION_TYPES = {
  OracleAttestation: [
    { name: "requestId", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "questionHash", type: "bytes32" },
    { name: "answerType", type: "uint8" },
    { name: "answer", type: "bytes" },
    { name: "figure", type: "uint256" },
    { name: "fromBlock", type: "uint64" },
    { name: "toBlock", type: "uint64" },
    { name: "blockHash", type: "bytes32" },
    { name: "panelJobId", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

// Confirmed live: IMD's real oracle attestation domain name is "IdentityMD Oracle", not
// "IMD-Attestation" (the never-verified assumption used everywhere before §25). Version "1" was
// already correct. Callers should pass "IdentityMD Oracle" as `name` for anything meant to match a
// real IMD attestation; a throwaway self-signed demo (no real IMD signer involved) can use anything,
// as long as the contract is deployed with the same domainName it's later checked against.
export function attestationDomain(chainId: number, verifyingContract: `0x${string}`, name: string, version: string) {
  return { name, version, chainId, verifyingContract } as const;
}
