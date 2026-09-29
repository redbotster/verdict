import { encodeAbiParameters, keccak256, toHex, type Address } from "viem";

// Verified against contracts/src/MilestoneEscrow.sol's TERMS_TYPEHASH string directly — this must
// match exactly, field-for-field, for the contract to recover the payer's address from a signature
// computed here.
export const TERMS_TYPEHASH = keccak256(
  toHex(
    "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)",
  ),
);

export interface DealTerms {
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  deadline: bigint;
  grace: bigint;
  questionHash: `0x${string}`;
  oracleSigner: Address;
  feeRecipient: Address;
  feeBps: number;
  challengeWindow: bigint;
}

export function computeTermsHash(t: DealTerms): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint16" },
        { type: "uint64" },
      ],
      [TERMS_TYPEHASH, t.payer, t.payee, t.token, t.amount, t.deadline, t.grace, t.questionHash, t.oracleSigner, t.feeRecipient, t.feeBps, t.challengeWindow],
    ),
  );
}
