export interface AttestationMessage {
  requestId: bigint;
  chainId: bigint;
  questionHash: `0x${string}`;
  answerType: string;
  answer: boolean;
  figure: string;
  fromBlock: bigint;
  toBlock: bigint;
  panelJobId: string;
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
