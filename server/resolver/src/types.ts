// Field shapes match IMD's real OracleAttestation struct, confirmed live 2026-09-29 — see
// docs/DAY-ONE-FINDINGS.md §25 and eip712.ts's ATTESTATION_TYPES. `answerType`/`answer` are kept at
// this convenience layer as a plain boolean (`answerType: 0`, the only value this project's contract
// accepts, means "bool") — relay.ts's toAbiMessage() encodes `answer` into the real dynamic `bytes`
// wire shape when building the actual contract call.
export interface AttestationMessage {
  requestId: `0x${string}`; // bytes32
  chainId: bigint;
  questionHash: `0x${string}`;
  answerType: number; // uint8; 0 = bool, the only value ever used here
  answer: boolean;
  figure: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  blockHash: `0x${string}`; // bytes32
  panelJobId: `0x${string}`; // bytes32
  issuedAt: bigint;
  expiresAt: bigint;
}

export interface SignedAttestation {
  message: AttestationMessage;
  signature: `0x${string}`;
}

export interface EscrowRef {
  address: `0x${string}`;
  chainId: number;
}
